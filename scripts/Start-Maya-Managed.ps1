param([switch]$Vision)
$ErrorActionPreference = 'Stop'
$root = 'C:\Apps\ProjectMaya'
$python = Join-Path $root '.venv\Scripts\python.exe'
$engine = Join-Path $root 'build\maya.exe'
$config = Join-Path $root $(if ($Vision) { 'maya-maya-xs-iq1_s-vision.json' } else { 'maya-maya-xs-iq1_s.json' })
$pidFile = Join-Path $PSScriptRoot '..\data\maya-managed.pid'
$logBase = Join-Path $PSScriptRoot '..\data\maya-managed'
$guardScript = Join-Path $PSScriptRoot 'maya-sleep-guard.ps1'

if (-not (Test-Path -LiteralPath $python)) { throw 'Project Maya setup has not created its Python environment yet' }
if (-not (Test-Path -LiteralPath $engine)) { throw 'Project Maya engine has not been built yet. Use the dashboard setup button first.' }
if (-not (Test-Path -LiteralPath $config)) { throw "Project Maya mode is not prepared. Use the dashboard setup button first: $config" }
if (-not (Test-Path -LiteralPath $guardScript)) { throw 'Maya sleep guard script is missing; refusing to start an unguarded session.' }
if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 8080 is already in use' }
$freeMiB = [int]((& nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | Select-Object -First 1).Trim())
if ($freeMiB -lt 24576) { throw "Project Maya needs at least 24576 MiB free on GPU 0; currently $freeMiB MiB are free." }

$env:PYTHONIOENCODING = 'utf-8'
$process = Start-Process -FilePath $python -ArgumentList @((Join-Path $root 'maya.py'), '--config', $config) `
  -WorkingDirectory $root -RedirectStandardOutput "$logBase.out.log" -RedirectStandardError "$logBase.err.log" `
  -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$process.Refresh()
if ($process.HasExited) { throw "Project Maya exited during startup. See $logBase.err.log" }
$fullPidFile = [System.IO.Path]::GetFullPath($pidFile)
$dataDir = Split-Path -Parent $fullPidFile
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$readyFile = Join-Path $dataDir 'maya-sleep-guard.ready'
$guardErrLog = "$logBase.sleep-guard.err.log"
Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
$startedTicks = $process.StartTime.ToUniversalTime().Ticks
try {
  $guard = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $guardScript,
    '-ProcessId', $process.Id, '-ProcessStartUtcTicks', $startedTicks, '-ReadyFile', $readyFile
  ) -RedirectStandardError $guardErrLog -PassThru -WindowStyle Hidden
} catch {
  & taskkill.exe /PID $process.Id /T /F | Out-Null
  throw "Could not start Maya sleep prevention; Maya was stopped. $($_.Exception.Message)"
}
$guardDeadline = (Get-Date).AddSeconds(8)
while (-not (Test-Path -LiteralPath $readyFile) -and (Get-Date) -lt $guardDeadline) {
  $guard.Refresh()
  if ($guard.HasExited) { break }
  Start-Sleep -Milliseconds 100
}
$process.Refresh()
$guard.Refresh()
if (-not (Test-Path -LiteralPath $readyFile) -or $process.HasExited -or $guard.HasExited) {
  if (-not $guard.HasExited) { Stop-Process -Id $guard.Id -Force -ErrorAction SilentlyContinue }
  & taskkill.exe /PID $process.Id /T /F | Out-Null
  Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
  $detail = if (Test-Path -LiteralPath $guardErrLog) { Get-Content -LiteralPath $guardErrLog -Raw } else { '' }
  throw "Could not confirm Maya sleep prevention; Maya was stopped. $detail"
}
Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
$guard.Refresh()
$record = @{ pid = $process.Id; executable = $python; started_utc_ticks = $startedTicks;
  sleep_guard_pid = $guard.Id; sleep_guard_executable = $guard.Path;
  sleep_guard_started_utc_ticks = $guard.StartTime.ToUniversalTime().Ticks }
$record | ConvertTo-Json | Set-Content -LiteralPath $fullPidFile -Encoding ascii
Write-Output "Project Maya started (PID $($process.Id), API http://127.0.0.1:8080/v1); sleep prevention confirmed (PID $($guard.Id))."
