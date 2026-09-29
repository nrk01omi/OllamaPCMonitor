<#
  Registers "OllamaPCMonitor" in Task Scheduler: start at logon of the current user (auto-logon is enabled on this PC).
  Run directly from an elevated PowerShell, or use the VS Code menu which prompts for elevation.
  Install/update:     powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
  Apply to task:      powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -EnableSelfHeal
  Undo self-heal:     powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -DisableSelfHeal
  Remove whole task:  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Uninstall

  Settings come from USER environment variables, so the API key is never written to the repo or to the task:
    [Environment]::SetEnvironmentVariable('NKS_URL',     'http://192.168.0.198:8000', 'User')
    [Environment]::SetEnvironmentVariable('NKS_API_KEY', '<key from the owner>',      'User')
    [Environment]::SetEnvironmentVariable('NKS_HOST_ID', '5090',                      'User')   # '3090' on the other machine
  The task must run in the logged-on user's session (GetLastInputInfo does not work from session 0 / a service).
#>
param(
    [switch]$Uninstall,
    [switch]$EnableSelfHeal,
    [switch]$DisableSelfHeal
)

if (([int][bool]$Uninstall + [int][bool]$EnableSelfHeal + [int][bool]$DisableSelfHeal) -gt 1) {
    throw 'Specify only one of -Uninstall, -EnableSelfHeal, or -DisableSelfHeal.'
}

$taskName = 'OllamaPCMonitor'

# The task runs at the highest run level.  Updating or removing that task also
# requires an elevated PowerShell process.  Re-launch ourselves so this works
# from the VS Code launch configuration as well as a regular terminal.
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal = [Security.Principal.WindowsPrincipal]::new($currentIdentity)
$isAdministrator = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdministrator) {
    $elevatedArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
    if ($Uninstall) {
        $elevatedArguments += '-Uninstall'
    } elseif ($EnableSelfHeal) {
        $elevatedArguments += '-EnableSelfHeal'
    } elseif ($DisableSelfHeal) {
        $elevatedArguments += '-DisableSelfHeal'
    }

    Write-Host "Requesting administrator approval to manage '$taskName'..."
    $elevated = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList $elevatedArguments
    if ($elevated.ExitCode -ne 0) {
        throw "Elevated task management failed with exit code $($elevated.ExitCode)."
    }
    return
}

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed task '$taskName'."
    return
}

function Set-SelfHeal {
    param([bool]$Enabled)

    # COM exposes session-state triggers, which New-ScheduledTaskTrigger cannot create.
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $folder = $service.GetFolder('\')
    $task = $folder.GetTask($taskName)
    $definition = $task.Definition
    $triggers = $definition.Triggers
    $ids = @('OllamaPCMonitor-SelfHeal-Time', 'OllamaPCMonitor-SelfHeal-RemoteConnect', 'OllamaPCMonitor-SelfHeal-SessionUnlock')

    # Iterate backward because removing a trigger shifts subsequent COM indices.
    for ($i = $triggers.Count; $i -ge 1; $i--) {
        $existing = $triggers.Item($i)
        $isLegacyTime = $existing.Type -eq 1 -and $existing.Repetition.Interval -eq 'PT5M' -and -not $existing.Repetition.Duration
        $isLegacySession = $existing.Type -eq 11 -and $existing.StateChange -in @(3, 8) -and `
            $existing.UserId -eq $definition.Principal.UserId
        if (($ids -contains $existing.Id) -or ($isLegacyTime -and -not $existing.Id) -or ($isLegacySession -and -not $existing.Id)) {
            $triggers.Remove($i)
        }
    }

    if ($Enabled) {
        $time = $triggers.Create(1) # TASK_TRIGGER_TIME
        $time.Id = $ids[0]
        $time.StartBoundary = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
        $time.Repetition.Interval = 'PT5M'
        $time.Repetition.Duration = '' # Unlimited

        $remote = $triggers.Create(11) # TASK_TRIGGER_SESSION_STATE_CHANGE
        $remote.Id = $ids[1]
        $remote.UserId = $definition.Principal.UserId
        $remote.StateChange = 3 # RemoteConnect

        $unlock = $triggers.Create(11)
        $unlock.Id = $ids[2]
        $unlock.UserId = $definition.Principal.UserId
        $unlock.StateChange = 8 # SessionUnlock
    }

    $definition.Settings.MultipleInstances = 2 # IgnoreNew
    $definition.Settings.RestartInterval = 'PT1M'
    $definition.Settings.RestartCount = $(if ($Enabled) { 999 } else { 3 })
    $folder.RegisterTaskDefinition($taskName, $definition, 6, $null, $null, 3, $null) | Out-Null

    $saved = $folder.GetTask($taskName).Definition
    $savedIds = @()
    for ($i = 1; $i -le $saved.Triggers.Count; $i++) { $savedIds += $saved.Triggers.Item($i).Id }
    if ($saved.Settings.RestartCount -ne $(if ($Enabled) { 999 } else { 3 })) { throw 'RestartCount verification failed.' }
    foreach ($id in $ids) {
        if (($id -in $savedIds) -ne $Enabled) { throw "Trigger verification failed: $id" }
    }
    Write-Host "Self-heal $(if ($Enabled) { 'enabled' } else { 'disabled' }) for '$taskName' (triggers: $($saved.Triggers.Count), restart count: $($saved.Settings.RestartCount))."
}

if ($EnableSelfHeal -or $DisableSelfHeal) {
    Set-SelfHeal -Enabled ([bool]$EnableSelfHeal)
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
Set-SelfHeal -Enabled $true
Write-Host "Registered task '$taskName' (logon and self-heal). Start now with: Start-ScheduledTask -TaskName $taskName"

foreach ($name in 'NKS_URL', 'NKS_API_KEY', 'NKS_HOST_ID') {
    if (-not [Environment]::GetEnvironmentVariable($name, 'User')) { Write-Warning "User environment variable $name is not set: the monitor will run without NKS reporting." }
}
