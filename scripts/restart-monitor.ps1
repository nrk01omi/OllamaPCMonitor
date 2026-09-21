$ErrorActionPreference = 'Stop'

$taskName = 'OllamaPCMonitor'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop

if ($task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    } while ($task.State -eq 'Running' -and (Get-Date) -lt $deadline)
    if ($task.State -eq 'Running') { throw "Timed out stopping scheduled task '$taskName'." }
}

Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
Write-Host "Restarted scheduled task '$taskName'."
