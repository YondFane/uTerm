& {
    $ErrorActionPreference = 'Stop'
    if ($env:OS -ne 'Windows_NT') { throw 'Windows only. / 仅支持 Windows。' }
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -ne 'AMD64') { throw 'Windows x64 only. / 仅支持 Windows x64。' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $base = 'https://github.com/YondFane/uTerm/releases/download'
    $work = Join-Path ([IO.Path]::GetTempPath()) ('uterm-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        $feed = Invoke-RestMethod -Uri "$base/uTerm-updates/latest.json" -TimeoutSec 120
        $version = [string]$feed.version
        if ($version -cnotmatch '\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z') {
            throw 'Invalid stable version. / 稳定版本号无效。'
        }
        $installer = Join-Path $work 'uTerm-setup.exe'
        Write-Host "Downloading uTerm $version / 正在下载 uTerm $version"
        Invoke-WebRequest -UseBasicParsing -Uri "$base/uTerm-v$version/uTerm-$version-windows-x86_64-setup.exe" -OutFile $installer -TimeoutSec 1800
        Write-Host 'Follow the installation wizard. / 请按照安装向导完成安装。'
        $process = Start-Process -FilePath $installer -Wait -PassThru
        if ($process.ExitCode -notin @(0, 3010)) { throw "Installer exited with code $($process.ExitCode). / 安装程序退出码：$($process.ExitCode)。" }
        Write-Host 'Installer completed. / 安装程序已完成。'
    }
    finally {
        Remove-Item -LiteralPath $work -Recurse -Force
    }
}
