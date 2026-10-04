$ErrorActionPreference = 'Stop'
$pidFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'data\strata-managed.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
    if (Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue) { throw 'Strata is running outside dashboard control; stop it manually' }
    return
}
$saved = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$managedPid = [int]$saved.pid
$parent = Get-Process -Id $managedPid -ErrorAction SilentlyContinue
if ($parent -and $saved.startedAt -and [math]::Abs(($parent.StartTime.ToUniversalTime() - ([datetime]$saved.startedAt).ToUniversalTime()).TotalSeconds) -lt 2) {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId)
    $descendants = New-Object System.Collections.Generic.List[int]
    $frontier = @($managedPid)
    while ($frontier.Count -gt 0) {
        $next = @($processes | Where-Object { $frontier -contains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId })
        foreach ($id in $next) { $descendants.Add($id) }
        $frontier = $next
    }
    for ($i = $descendants.Count - 1; $i -ge 0; $i--) { Stop-Process -Id $descendants[$i] -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $managedPid -Force -ErrorAction SilentlyContinue
} elseif (Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Strata process ownership could not be verified; stop it manually'
}
Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Seconds 1
}
throw 'Strata port 8082 did not close after stopping the managed process'
