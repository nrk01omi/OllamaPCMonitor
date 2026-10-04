$ErrorActionPreference = 'Stop'
$root = 'C:\Apps\Strata'
$config = Join-Path $root 'strata-iq2_xs.json'
$launcher = Join-Path $PSScriptRoot 'Start-Strata-128K.ps1'
$pidFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'data\strata-managed.pid'

if (-not (Test-Path -LiteralPath $launcher)) { throw "Strata launcher missing: $launcher" }
if (-not (Test-Path -LiteralPath $config)) { throw "Strata config missing: $config" }
if (Test-Path -LiteralPath $pidFile) {
    $saved = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $oldPid = [int]$saved.pid
    if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { throw "Managed Strata process $oldPid is already running" }
    Remove-Item -LiteralPath $pidFile
}
if (Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 8082 is already in use' }

$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $launcher + '"')) -WindowStyle Hidden -PassThru
@{ pid = $process.Id; startedAt = $process.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $pidFile -NoNewline
Start-Sleep -Seconds 2
if ($process.HasExited) {
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
    throw "Strata launcher exited immediately (code $($process.ExitCode))"
}
Write-Host "Strata 128K launch started (PID $($process.Id), API http://127.0.0.1:8082/v1)"
