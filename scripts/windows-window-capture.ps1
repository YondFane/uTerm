param([int]$TargetProcessId, [string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WindowCapture {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; public Point(int x, int y) { X=x; Y=y; } }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
}
'@
[void][WindowCapture]::SetProcessDPIAware()
$application = Get-Process -Id $TargetProcessId
$windowDeadline = [DateTime]::UtcNow.AddSeconds(10)
$handle = [IntPtr]::Zero
do {
    $application.Refresh()
    if ($application.HasExited) { throw 'Native QA exited before window capture' }
    $handle = $application.MainWindowHandle
    if ($handle -ne [IntPtr]::Zero) {
        $owner = [uint32]0
        [void][WindowCapture]::GetWindowThreadProcessId($handle, [ref]$owner)
        if ($owner -ne $TargetProcessId) { throw 'Native QA window ownership changed' }
        [void][WindowCapture]::ShowWindow($handle, 9)
        $readyRect = [WindowCapture+Rect]::new()
        if ([WindowCapture]::GetWindowRect($handle, [ref]$readyRect) -and ($readyRect.Right - $readyRect.Left) -ge 600 -and ($readyRect.Bottom - $readyRect.Top) -ge 400) { break }
    }
    # Restoration and WebView startup can temporarily expose a tiny native window.
    # 窗口恢复及 WebView 启动期间，原生窗口尺寸可能暂时很小。
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $windowDeadline)
if ($handle -eq [IntPtr]::Zero -or ($readyRect.Right - $readyRect.Left) -lt 600 -or ($readyRect.Bottom - $readyRect.Top) -lt 400) { throw 'No restored native QA window with valid dimensions' }
$topmost = ([WindowCapture]::GetWindowLongPtr($handle, -20).ToInt64() -band 8) -ne 0
try {
    # Raise only the owned QA window; CI consoles must not cover evidence. 仅置顶所属 QA 窗口，CI 控制台不能遮挡证据。
    [void][WindowCapture]::ShowWindow($handle, 9)
    if (![WindowCapture]::SetWindowPos($handle, [IntPtr]::new(-1), 0, 0, 0, 0, 0x43)) { throw 'Cannot raise the native QA window' }
    [void][WindowCapture]::SetForegroundWindow($handle)
    Start-Sleep -Milliseconds 350
    $rect = [WindowCapture+Rect]::new()
    if (![WindowCapture]::GetWindowRect($handle, [ref]$rect)) { throw 'GetWindowRect failed' }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 600 -or $height -lt 400) { throw 'Invalid native QA window dimensions' }
    $unobstructed = $true
    $samples = @()
    foreach ($fraction in @(@(0.5,0.5), @(0.25,0.25), @(0.75,0.25), @(0.25,0.75), @(0.75,0.75))) {
        $point = [WindowCapture+Point]::new([int]($rect.Left + $width * $fraction[0]), [int]($rect.Top + $height * $fraction[1]))
        $visibleRoot = [WindowCapture]::GetAncestor([WindowCapture]::WindowFromPoint($point), 3)
        $samples += @{ x=$point.X; y=$point.Y; visibleRoot=$visibleRoot.ToInt64() }
        if ($visibleRoot -ne $handle) { $unobstructed = $false }
    }
    $image = [System.Drawing.Bitmap]::new($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($image)
    try {
        # Ask the actual app window to render, even on a covered CI desktop. 即使 CI 桌面被遮挡，也由实际应用窗口渲染。
        $dc = $graphics.GetHdc()
        try { $printed = [WindowCapture]::PrintWindow($handle, $dc, 2) }
        finally { $graphics.ReleaseHdc($dc) }
        $method = 'Win32 PrintWindow PW_RENDERFULLCONTENT on owned QA HWND'
        if (!$printed) {
            if (!$unobstructed) { throw 'Native QA window is occluded and PrintWindow failed' }
            $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $image.Size)
            $method = 'CopyFromScreen with sampled occlusion checks'
        }
        $image.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
        @{ processId=$TargetProcessId; handle=$handle.ToInt64(); title=$application.MainWindowTitle; method=$method; width=$width; height=$height; unobstructed=$unobstructed; samples=$samples } | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 ($Destination + '.capture.json')
    } finally { $graphics.Dispose(); $image.Dispose() }
} finally {
    if (!$topmost) { [void][WindowCapture]::SetWindowPos($handle, [IntPtr]::new(-2), 0, 0, 0, 0, 0x13) }
}
