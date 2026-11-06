$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (![System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) { throw 'Windows candidate packaging requires Windows' }
$candidateEvidence = Join-Path (Get-Location) 'ci-evidence/candidate'
New-Item -ItemType Directory -Force $candidateEvidence | Out-Null
$candidateRoot = Join-Path ([IO.Path]::GetTempPath()) ('uterm-tauri-qa-candidate-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $candidateRoot | Out-Null
$candidateInstall = Join-Path $candidateRoot 'Private Applications'
$candidateData = Join-Path $candidateRoot 'data'
New-Item -ItemType Directory $candidateData | Out-Null
New-Item -ItemType Directory (Join-Path $candidateRoot 'project') | Out-Null
$candidateIdentity = 'sh.uterm.desktop.qa.sharedstate'
$candidateProduct = 'uTerm Shared State QA'
$candidateLinks = [Collections.Generic.List[string]]::new()
$candidateProcess = $null
$candidateInstalled = $false
$candidateReport = [ordered]@{ passed=$false; platform='Windows'; architecture=[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); system=[Environment]::OSVersion.VersionString; candidateOnly=$true; productionDataAccess=$false; productionDeepLinkRegistered=$false; updateSignature=$false; bundleIdentifier=$candidateIdentity }

function Candidate-Run([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed ($LASTEXITCODE)" }
}
function Candidate-RegistryHash {
    $values = foreach ($path in @('HKCU:\Software\Classes\uterm', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\uTerm', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\uTerm')) {
        if (Test-Path $path) {
            Get-ItemProperty $path | ConvertTo-Json -Depth 8 -Compress
            Get-ChildItem $path -Recurse | Sort-Object Name | ForEach-Object { Get-ItemProperty $_.PSPath | ConvertTo-Json -Depth 8 -Compress }
        } else { "absent:$path" }
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($values -join "`n"))
    return ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
}
function Candidate-Uninstall {
    $uninstallers = @(Get-ChildItem $candidateInstall -Filter '*uninstall*.exe' -ErrorAction SilentlyContinue)
    if ($uninstallers.Count -ne 1) { throw 'Expected exactly one owned QA uninstaller' }
    $process = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList '/S' -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "QA uninstall failed ($($process.ExitCode))" }
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ((Test-Path $candidateInstall) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (Test-Path $candidateInstall) { throw 'QA installer directory survived uninstall' }
}

try {
    $candidateHead = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or (& git status --porcelain)) { throw 'Candidate must use a clean source tree' }
    $candidateReport.testedMergeSHA = $candidateHead
    $candidateReport.sourceHeadSHA = if ($env:PR_HEAD_SHA) { $env:PR_HEAD_SHA } else { $candidateHead }
    $candidateReport.sourceTreeDirty = $false
    $candidateVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $candidateReport.version = $candidateVersion
    $candidateReport.toolchain = @{ node=(& node --version); pnpm=(& pnpm --version); rust=(& rustc --version); cargo=(& cargo --version); powershell=$PSVersionTable.PSVersion.ToString() }
    $candidateRegistryBefore = Candidate-RegistryHash
    $candidateRegistryRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    $existing = if (Test-Path $candidateRegistryRoot) { @(Get-ChildItem $candidateRegistryRoot | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like "$candidateProduct*" }) } else { @() }
    if ($existing.Count) { throw 'Refusing to replace an existing QA installation' }
    foreach ($area in @($env:APPDATA, $env:LOCALAPPDATA) | Select-Object -Unique) {
        if (!$area) { throw 'Windows profile directory is unavailable' }
        $link = Join-Path $area $candidateIdentity
        if (Test-Path $link) { throw "Refusing to replace an existing QA profile: $link" }
        New-Item -ItemType Junction -Path $link -Target $candidateData | Out-Null
        $candidateLinks.Add($link)
    }
    $overlay = [ordered]@{ identifier=$candidateIdentity; productName=$candidateProduct;
        plugins=@{ 'deep-link'=@{ desktop=@{ schemes=@() } } };
        bundle=@{ createUpdaterArtifacts=$false; windows=@{ webviewInstallMode=@{ type='skip' }; nsis=@{ installMode='currentUser'; installerHooks='qa-candidate-installer.nsh' } } };
        app=@{ windows=@(@{ label='main'; title=$candidateProduct; width=960; height=620; minWidth=640; minHeight=420; visible=$true; focus=$true; dragDropEnabled=$false }) } }
    $overlayPath = Join-Path $candidateRoot 'qa-overlay.json'
    [IO.File]::WriteAllText($overlayPath, ($overlay | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    Copy-Item $overlayPath (Join-Path $candidateEvidence 'qa-overlay.json')
    $env:VITE_UTERM_STATE_QA = '1'
    $env:UTERM_QA_HEAD = $candidateReport.sourceHeadSHA
    $env:UTERM_QA_TESTED = $candidateHead
    $env:UTERM_QA_DIRTY = 'false'
    Candidate-Run 'node' @('node_modules/@tauri-apps/cli/tauri.js', 'build', '--debug', '--features', 'qa', '--bundles', 'nsis', '--config', $overlayPath, '--', '--locked')
    $target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'src-tauri/target' }
    $installers = @(Get-ChildItem (Join-Path $target 'debug/bundle/nsis') -Filter "$candidateProduct*-setup.exe")
    if ($installers.Count -ne 1) { throw 'Expected exactly one Windows QA NSIS package' }
    $name = "uTerm-QA-$candidateVersion-windows-x64-$($candidateReport.sourceHeadSHA.Substring(0,12))-setup.exe"
    $package = Join-Path $candidateEvidence $name
    Copy-Item $installers[0].FullName $package -Force
    $candidateReport.artifact = @{ file=$name; sha256=(Get-FileHash $package -Algorithm SHA256).Hash.ToLowerInvariant(); bytes=(Get-Item $package).Length }
    [IO.File]::WriteAllText((Join-Path $candidateEvidence 'SHA256SUMS'), "$($candidateReport.artifact.sha256)  $name`n")
    $candidateReport.authenticode = (Get-AuthenticodeSignature $package).Status.ToString()
    if ($candidateReport.authenticode -ne 'NotSigned') { throw 'Review unexpected candidate signing status' }
    # NSIS consumes the unquoted remainder after /D; keep this owned path as the final argument.
    # NSIS 将 /D 后未加引号的剩余文本作为目录，所属临时路径必须是最后一个参数。
    $installer = [Diagnostics.ProcessStartInfo]::new($package)
    $installer.UseShellExecute = $false; $installer.Arguments = "/S /D=$candidateInstall"
    $installation = [Diagnostics.Process]::Start($installer)
    if (!$installation.WaitForExit(120000)) { $installation.Kill(); throw 'QA installation timed out' }
    if ($installation.ExitCode -ne 0) { throw "QA installation failed ($($installation.ExitCode))" }
    $candidateInstalled = $true
    $binary = Join-Path $candidateInstall 'uterm.exe'
    if (!(Test-Path $binary)) { throw 'Installed QA executable is missing' }
    $candidateReport.binarySHA256 = (Get-FileHash $binary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($candidateReport.binarySHA256 -ne (Get-FileHash (Join-Path $target 'debug/uterm.exe') -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Installed executable differs from the built QA binary' }
    $candidateReport.binaryVersion = (Get-Item $binary).VersionInfo.ProductVersion
    if (!$candidateReport.binaryVersion.StartsWith($candidateVersion)) { throw 'Installed executable version mismatch' }
    $image = [IO.File]::ReadAllBytes($binary)
    $pe = [BitConverter]::ToInt32($image, 0x3c)
    if ([BitConverter]::ToUInt16($image, $pe + 4) -ne 0x8664) { throw 'Installed QA executable is not x64' }
    $candidateReport.binaryArchitecture = 'x86_64-pc-windows-msvc'
    $protected = @($binary, (Join-Path $candidateInstall 'licenses/uTerm-LICENSE.txt'), (Join-Path $candidateInstall 'licenses/uTerm-NOTICE.txt'))
    foreach ($path in $protected) {
        if (!((Get-Item $path).Attributes -band [IO.FileAttributes]::ReadOnly)) { throw "Installed resource is writable: $path" }
        $opened = $false
        try { $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite); $opened=$true; $stream.Dispose() }
        catch [UnauthorizedAccessException] {}
        if ($opened) { throw "Installed resource accepted writes: $path" }
    }
    $candidateReport.runtimeResourcesWriteRejected = $true
    $stdout = Join-Path $candidateEvidence 'installed-stdout.log'; $stderr = Join-Path $candidateEvidence 'installed-stderr.log'
    $candidateProcess = Start-Process -FilePath $binary -ArgumentList @('--qa-data-root', $candidateRoot, '--qa-phase', 'package') -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $scenePath = Join-Path $candidateRoot 'evidence/package-installed-start.json'
    $failurePath = Join-Path $candidateRoot 'evidence/package-failure.json'
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while (!(Test-Path $scenePath) -and [DateTime]::UtcNow -lt $deadline) {
        if (Test-Path $failurePath) { Copy-Item $failurePath $candidateEvidence; throw 'Installed QA reported startup failure' }
        if ($candidateProcess.HasExited) { throw "Installed QA exited before its scene ($($candidateProcess.ExitCode))" }
        Start-Sleep -Milliseconds 100
    }
    if (!(Test-Path $scenePath)) { throw 'Installed QA startup scene timed out' }
    $scene = Get-Content $scenePath -Raw | ConvertFrom-Json
    if ($scene.context.head -ne $candidateReport.sourceHeadSHA -or $scene.context.tested -ne $candidateHead -or $scene.context.sourceTreeDirty -ne 'false' -or !$scene.checks.coreReady -or $scene.checks.productionDataAccess) { throw 'Installed QA scene metadata or checks mismatch' }
    $capture = Join-Path $candidateEvidence 'candidate-installed-windows-window.png'
    & (Join-Path $PSScriptRoot 'windows-window-capture.ps1') -TargetProcessId $candidateProcess.Id -Destination $capture
    if ((Get-Item $capture).Length -lt 1000) { throw 'Installed QA screenshot is missing' }
    Copy-Item $scenePath $candidateEvidence
    New-Item -ItemType File (Join-Path $candidateRoot 'evidence/package-installed-start.ack') | Out-Null
    if (!$candidateProcess.WaitForExit(30000) -or $candidateProcess.ExitCode -ne 0) { throw 'Installed QA failed ordinary exit' }
    $candidateReport.installedStartPassed = $true; $candidateReport.processExitCode = $candidateProcess.ExitCode
    $candidateReport.screenshot = 'candidate-installed-windows-window.png'; $candidateProcess = $null
    if (!(Test-Path (Join-Path $candidateData 'shared-state-v1/snapshot-v1.json'))) { throw 'Private QA snapshot is missing' }
    Candidate-Uninstall
    $candidateInstalled = $false
    $remaining = if (Test-Path $candidateRegistryRoot) { @(Get-ChildItem $candidateRegistryRoot | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like "$candidateProduct*" }) } else { @() }
    if ($remaining.Count) { throw 'QA uninstall registry entry survived removal' }
    $candidateReport.uninstallRegistryEntryRemoved = $true
    if (!(Test-Path (Join-Path $candidateData 'shared-state-v1/snapshot-v1.json'))) { throw 'Uninstall removed private application data' }
    $candidateReport.uninstalledAppRemoved = $true; $candidateReport.privateDataRetainedUntilFixtureCleanup = $true
    $candidateReport.productionRegistryUnchanged = ((Candidate-RegistryHash) -eq $candidateRegistryBefore)
    if (!$candidateReport.productionRegistryUnchanged) { throw 'Production protocol or uninstall registry changed' }
    $candidateReport.installationScope = 'current-user NSIS into an owned temporary directory'
    $candidateReport.passed = $true
} catch {
    $candidateReport.failure = $_.ToString()
    throw
} finally {
    if ($candidateProcess -and !$candidateProcess.HasExited) { Stop-Process -Id $candidateProcess.Id -Force }
    if ($candidateInstalled) {
        try { Candidate-Uninstall } catch { $candidateReport.cleanupError = $_.ToString() }
    }
    try {
        foreach ($link in $candidateLinks) { if (Test-Path $link) { [IO.Directory]::Delete($link) } }
        if (!$candidateReport.cleanupError) { Remove-Item $candidateRoot -Recurse -Force }
    } catch { $candidateReport.cleanupError = $_.ToString(); $candidateReport.passed = $false }
    $candidateReport | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 (Join-Path $candidateEvidence 'candidate-windows.json')
    $candidateReport | ConvertTo-Json -Depth 12
    if ($candidateReport.cleanupError) { throw $candidateReport.cleanupError }
}
