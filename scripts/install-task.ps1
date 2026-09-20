<#
  Registers "OllamaPCMonitor" in Task Scheduler: start at logon of the current user (auto-logon is enabled on this PC).
  Run from a normal (non-admin) PowerShell:   powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
  Remove:                                     powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Uninstall

  Settings come from USER environment variables, so the API key is never written to the repo or to the task:
    [Environment]::SetEnvironmentVariable('NKS_URL',     'http://192.168.0.198:8000', 'User')
    [Environment]::SetEnvironmentVariable('NKS_API_KEY', '<key from the owner>',      'User')
    [Environment]::SetEnvironmentVariable('NKS_HOST_ID', '5090',                      'User')   # '3090' on the other machine
  The task must run in the logged-on user's session (GetLastInputInfo does not work from session 0 / a service).
#>
param([switch]$Uninstall)

$taskName = 'OllamaPCMonitor'
if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed task '$taskName'."
    return
}

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$log = Join-Path $root 'data\monitor.log'

# Hidden window; stdout/stderr are appended to data\monitor.log (git-ignored)
$command = "& '$node' 'server.js' *>> '$log'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$command`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Ollama PC Monitor: proxy, dashboard and NKS presence heartbeat' -Force | Out-Null
Write-Host "Registered task '$taskName' (at logon). Start now with: Start-ScheduledTask -TaskName $taskName"

foreach ($name in 'NKS_URL', 'NKS_API_KEY', 'NKS_HOST_ID') {
    if (-not [Environment]::GetEnvironmentVariable($name, 'User')) { Write-Warning "User environment variable $name is not set: the monitor will run without NKS reporting." }
}
