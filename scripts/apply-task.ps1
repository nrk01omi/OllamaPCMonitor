$ErrorActionPreference = 'Stop'

$installer = Join-Path $PSScriptRoot 'install-task.ps1'
if (Get-ScheduledTask -TaskName 'OllamaPCMonitor' -ErrorAction SilentlyContinue) {
    & $installer -EnableSelfHeal
} else {
    & $installer
}

& (Join-Path $PSScriptRoot 'restart-monitor.ps1')
