& {
    $ErrorActionPreference = 'Stop'
    function Get-UtermHash($Path) {
        $stream = [IO.File]::OpenRead($Path)
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose(); $algorithm.Dispose() }
    }
    function Get-UtermInstaller($Uri, $Path, $Hash, $Size) {
        if ($Hash -and (Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -eq $Size -and (Get-UtermHash $Path) -eq $Hash) { return }
        if ($Hash -and (Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -ge $Size) { Remove-Item -LiteralPath $Path -Force }
        for ($attempt = 0; $attempt -lt 3; $attempt++) {
            $started = [Diagnostics.Stopwatch]::StartNew()
            $response = $null
            $inputStream = $null
            $outputStream = $null
            try {
                $offset = if ($Hash -and (Test-Path -LiteralPath $Path)) { (Get-Item -LiteralPath $Path).Length } else { 0 }
                if ($offset -gt $Size -and $Hash) { Remove-Item -LiteralPath $Path -Force; $offset = 0 }
                $request = [Net.HttpWebRequest]::Create($Uri)
                $request.UserAgent = 'uTerm-install'
                $request.Timeout = 30000
                $request.ReadWriteTimeout = 120000
                if ($offset -gt 0) { $request.AddRange([long]$offset) }
                $response = $request.GetResponse()
                if ([int]$response.StatusCode -eq 200) { $offset = 0 }
                elseif ([int]$response.StatusCode -ne 206 -or $response.Headers['Content-Range'] -cne "bytes $offset-$($Size - 1)/$Size") {
                    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
                    throw 'DOWNLOAD_RESPONSE'
                }
                $mode = if ($offset -gt 0) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
                $expectedLength = if ($response.ContentLength -ge 0) { $offset + $response.ContentLength } else { $null }
                $outputStream = [IO.File]::Open($Path, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $inputStream = $response.GetResponseStream()
                $buffer = New-Object byte[] 65536
                while ($true) {
                    if ($started.Elapsed.TotalSeconds -gt 1800) { throw 'DOWNLOAD_TIMEOUT' }
                    try { $count = $inputStream.Read($buffer, 0, $buffer.Length) } catch { throw 'DOWNLOAD_NETWORK' }
                    if ($count -eq 0) { break }
                    $offset += $count
                    if ($offset -gt 536870912 -or ($Hash -and $offset -gt $Size)) { throw 'DOWNLOAD_VERIFY' }
                    $outputStream.Write($buffer, 0, $count)
                }
                $outputStream.Dispose(); $outputStream = $null
                if ($null -ne $expectedLength -and $offset -ne $expectedLength) { throw 'DOWNLOAD_NETWORK' }
                if ($offset -eq 0) { throw 'DOWNLOAD_RESPONSE' }
                if ($Hash -and $offset -lt $Size) { throw 'DOWNLOAD_NETWORK' }
                if ($Hash -and (Get-UtermHash $Path) -ne $Hash) { throw 'DOWNLOAD_VERIFY' }
                return
            }
            catch {
                $failure = $_
                if ($outputStream) { $outputStream.Dispose(); $outputStream = $null }
                $web = $failure.Exception
                while ($web.InnerException -and $web -isnot [Net.WebException]) { $web = $web.InnerException }
                $status = if ($web -is [Net.WebException] -and $web.Response) { [int]$web.Response.StatusCode } else { 0 }
                if ($failure.ToString() -match 'DOWNLOAD_VERIFY') {
                    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
                    throw 'Installer verification failed / 安装包校验失败'
                }
                if ($web -is [Net.WebException] -and $web.Status -in @([Net.WebExceptionStatus]::TrustFailure, [Net.WebExceptionStatus]::SecureChannelFailure)) { throw 'Certificate or TLS connection failed / 证书或 TLS 连接失败' }
                if ($status -eq 416) {
                    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
                }
                elseif ($status -ge 400 -and $status -notin @(408, 429, 500, 502, 503, 504)) { throw "Download rejected: HTTP $status / 下载被拒绝" }
                elseif ($web -isnot [Net.WebException] -and $failure.ToString() -notmatch 'DOWNLOAD_NETWORK|DOWNLOAD_RESPONSE|DOWNLOAD_TIMEOUT') { throw "Cannot read or write download; check space and permissions / 无法读写下载文件，请检查空间和权限：$failure" }
                if ($attempt -eq 2) { throw "Download interrupted; retry to continue / 下载中断，请重试继续：$failure" }
                $pause = [int][Math]::Pow(2, $attempt)
                if ($web -is [Net.WebException] -and $web.Response -and $web.Response.Headers['Retry-After']) {
                    $seconds = 0
                    if (-not [int]::TryParse($web.Response.Headers['Retry-After'], [ref]$seconds) -or $seconds -gt 30) { throw 'Download source is busy; retry later / 下载源繁忙，请稍后重试' }
                    $pause = [Math]::Max($pause, $seconds)
                }
                if ($web -is [Net.WebException] -and $web.Response) { $web.Response.Dispose() }
                Start-Sleep -Seconds $pause
            }
            finally {
                if ($inputStream) { $inputStream.Dispose() }
                if ($outputStream) { $outputStream.Dispose() }
                if ($response) { $response.Dispose() }
            }
        }
    }
    if ($env:OS -ne 'Windows_NT') { throw 'Windows only. / 仅支持 Windows。' }
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -ne 'AMD64') { throw 'Windows x64 only. / 仅支持 Windows x64。' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $base = 'https://github.com/YondFane/uTerm/releases/download'
    $work = Join-Path ([IO.Path]::GetTempPath()) ('uterm-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    $cacheLock = $null
    try {
        $feed = Invoke-RestMethod -Uri "$base/uTerm-updates/latest.json" -TimeoutSec 120
        $version = [string]$feed.version
        if ($version -cnotmatch '\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z') {
            throw 'Invalid stable version. / 稳定版本号无效。'
        }
        $installer = Join-Path $work 'uTerm-setup.exe'
        $artifact = $feed.installers.'windows-x86_64'
        $hash = $null
        $size = 0
        if ($artifact) {
            $hash = [string]$artifact.sha256
            $size = [long]$artifact.size
            if ($hash -cnotmatch '\A[a-f0-9]{64}\z' -or $size -le 0 -or $size -gt 536870912) { throw 'Invalid installer information / 安装包信息无效' }
            $cache = Join-Path $env:LOCALAPPDATA 'uTerm/installer-cache-v1'
            New-Item -ItemType Directory -Path $cache -Force | Out-Null
            $cacheLock = [IO.File]::Open((Join-Path $cache 'installer.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $installer = Join-Path $cache "windows-x86_64-$hash.part"
            $cached = @(Get-ChildItem -LiteralPath $cache -Filter '*.part' -File | Where-Object { $_.FullName -ne $installer } | Sort-Object LastWriteTime -Descending)
            for ($index = 0; $index -lt $cached.Length; $index++) {
                if ($index -ge 3 -or $cached[$index].LastWriteTime -lt (Get-Date).AddDays(-7)) { Remove-Item -LiteralPath $cached[$index].FullName -Force }
            }
        }
        Write-Host "Downloading uTerm $version / 正在下载 uTerm $version"
        Get-UtermInstaller "$base/uTerm-v$version/uTerm-$version-windows-x86_64-setup.exe" $installer $hash $size
        $executable = Join-Path $work 'uTerm-setup.exe'
        if ($installer -ne $executable) { Copy-Item -LiteralPath $installer -Destination $executable }
        Write-Host 'Follow the installation wizard. / 请按照安装向导完成安装。'
        $process = Start-Process -FilePath $executable -Wait -PassThru
        if ($process.ExitCode -notin @(0, 3010)) { throw "Installer exited with code $($process.ExitCode). / 安装程序退出码：$($process.ExitCode)。" }
        Write-Host 'Installer completed. / 安装程序已完成。'
    }
    catch {
        Write-Host 'Manual download / 手动下载: https://github.com/YondFane/uTerm/releases/latest'
        throw
    }
    finally {
        if ($cacheLock) { $cacheLock.Dispose() }
        $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($work)).TrimEnd('\', '/') -ne $temporaryRoot) { throw 'Invalid temporary download directory / 临时下载目录无效' }
        Remove-Item -LiteralPath $work -Recurse -Force
    }
}
