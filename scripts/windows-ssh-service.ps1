param([ValidateSet('Start', 'Stop', 'Status')][string]$Action, [string]$Root)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This isolated SSH fixture only runs on disposable GitHub runners.' }
$manifest = Join-Path $Root 'owned-service.json'
if ($Action -eq 'Status') {
    $owned = Get-Content -Raw $manifest | ConvertFrom-Json
    $task = Get-ScheduledTask -TaskName $owned.task
    $info = Get-ScheduledTaskInfo -TaskName $owned.task
    @{state=[string]$task.State;lastResult=$info.LastTaskResult;lastRun=$info.LastRunTime.ToString('o')} | ConvertTo-Json
    return
}
if ($Action -eq 'Stop') {
    if (!(Test-Path $manifest)) { return }
    $owned = Get-Content -Raw $manifest | ConvertFrom-Json
    if ($owned.task -notmatch '^uterm-ssh-qa-[0-9a-f]{32}$' -or $owned.user -notmatch '^utssh[0-9a-f]{12}$') { throw 'Invalid SSH fixture ownership' }
    Stop-ScheduledTask -TaskName $owned.task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $owned.task -Confirm:$false -ErrorAction SilentlyContinue
    $user = Get-LocalUser -Name $owned.user -ErrorAction SilentlyContinue
    if ($user -and $user.SID.Value -eq $owned.sid) {
        try {
            $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$($owned.sid)'"
            if ($profile) {
                if ($profile.Special) { throw 'Refuse to remove a special Windows profile' }
                $profile | Remove-CimInstance
            }
        } finally { Remove-LocalUser -Name $owned.user }
    }
    Remove-Item $manifest
    return
}
if (Test-Path $manifest) { throw 'SSH fixture already exists' }
$settings = Get-Content -Raw (Join-Path $Root 'server-settings.json') | ConvertFrom-Json
$version = '10.4.0.0p1-Preview'
$archive = Join-Path $Root 'openssh.zip'
Invoke-WebRequest -Uri "https://github.com/PowerShell/Win32-OpenSSH/releases/download/$version/OpenSSH-Win64.zip" -OutFile $archive
if ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant() -ne 'b67ff8becd203502190ec42ac7787c24c2cd3325ed7700485fe7a1c83d2a7957') { throw 'OpenSSH fixture checksum mismatch' }
Expand-Archive $archive (Join-Path $Root 'server')
$server = Join-Path $Root 'server/OpenSSH-Win64/sshd.exe'
$task = 'uterm-ssh-qa-' + [Guid]::NewGuid().ToString('N')
$username = 'utssh' + [Guid]::NewGuid().ToString('N').Substring(0,12)
$user = New-LocalUser -Name $username -Password (ConvertTo-SecureString $env:UTERM_QA_PASSWORD -AsPlainText -Force) -AccountNeverExpires -PasswordNeverExpires
@{task=$task;user=$username;sid=$user.SID.Value} | ConvertTo-Json | Set-Content -Encoding UTF8 $manifest
try {
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
    # Only the generated account gets access to the temporary remote directory. 仅生成的账户获得临时远端目录权限。
    $acl = Get-Acl $settings.remote
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user.SID, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl $settings.remote $acl
    $keyAcl = [System.Security.AccessControl.FileSecurity]::new()
    $keyAcl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    $keyAcl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $keyAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'Allow'))
    }
    Set-Acl (Join-Path $Root 'host') $keyAcl
    $clientAcl = [System.Security.AccessControl.FileSecurity]::new()
    $clientOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $clientAcl.SetOwner($clientOwner)
    $clientAcl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($clientOwner.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $clientAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'Allow'))
    }
    Set-Acl (Join-Path $Root 'client') $clientAcl
    $config = Join-Path $Root 'sshd_config'
    $path = $Root.Replace('\', '/')
    @"
ListenAddress 127.0.0.1
Port $($settings.port)
HostKey "$path/host"
HostCertificate "$path/host-cert.pub"
PidFile "$path/server.pid"
AuthorizedKeysFile "$path/authorized_keys"
StrictModes no
PasswordAuthentication yes
KbdInteractiveAuthentication no
AllowUsers $($settings.runner.ToLowerInvariant()) $username
LogLevel VERBOSE
Subsystem sftp internal-sftp
"@ | Set-Content -Encoding ASCII $config
    & $server -t -f $config
    if ($LASTEXITCODE -ne 0) { throw 'Invalid isolated sshd configuration' }
    $arguments = '-D -f "' + $config + '" -E "' + $settings.log + '"'
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $taskAction = New-ScheduledTaskAction -Execute $server -Argument $arguments -WorkingDirectory (Split-Path $server)
    Register-ScheduledTask -TaskName $task -Action $taskAction -Principal $principal | Out-Null
    Start-ScheduledTask -TaskName $task
} catch {
    & $PSCommandPath -Action Stop -Root $Root
    throw
}
