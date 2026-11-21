$ErrorActionPreference = 'Stop'
$root = 'C:\Apps\ProjectMaya'
$configPath = Join-Path $root 'maya-ds4.json'
$python = Join-Path $root '.venv\Scripts\python.exe'
$pidFile = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\data\deepseek-managed.pid'))
$logBase = Join-Path $PSScriptRoot '..\data\deepseek-managed'
$guardScript = Join-Path $PSScriptRoot 'maya-sleep-guard.ps1'

foreach ($path in @($configPath, $python, $guardScript)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "DeepSeek setup file is missing: $path" }
}
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$packArg = [Array]::IndexOf([string[]]$config.args, '--pack')
if ($config.model_name -ne 'deepseek-v4.1-flash' -or [int]$config.port -ne 8080 -or $packArg -lt 0) {
  throw 'Project Maya DeepSeek config does not match the expected model or port.'
}
$pack = [string]$config.args[$packArg + 1]
if (-not (Test-Path -LiteralPath $config.exe) -or -not (Test-Path -LiteralPath $pack) -or
    -not (Test-Path -LiteralPath (Join-Path $pack 'tokenizer')) -or
    -not (Test-Path -LiteralPath 'D:\ProjectMaya\Models\DeepSeek-V4.1-Flash-1017-GGUF\vision\vision.bin')) {
  throw 'DeepSeek engine, pack, tokenizer, or vision tower is missing.'
}
if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 8080 is already in use' }
$freeMiB = [int]((& nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | Select-Object -First 1).Trim())
if ($freeMiB -lt 24576) { throw "Project Maya needs at least 24576 MiB free on GPU 0; currently $freeMiB MiB are free." }

$env:PYTHONIOENCODING = 'utf-8'
$process = Start-Process -FilePath $python -ArgumentList @((Join-Path $root 'maya.py'), '--config', $configPath) `
  -WorkingDirectory $root -RedirectStandardOutput "$logBase.out.log" -RedirectStandardError "$logBase.err.log" `
  -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$process.Refresh()
if ($process.HasExited) { throw "Project Maya DeepSeek exited during startup. See $logBase.err.log" }
$dataDir = Split-Path -Parent $pidFile
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$readyFile = Join-Path $dataDir 'deepseek-sleep-guard.ready'
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
  throw "Could not start Maya sleep prevention; DeepSeek was stopped. $($_.Exception.Message)"
}
$guardDeadline = (Get-Date).AddSeconds(8)
while (-not (Test-Path -LiteralPath $readyFile) -and (Get-Date) -lt $guardDeadline) {
  $guard.Refresh()
  if ($guard.HasExited) { break }
  Start-Sleep -Milliseconds 100
}
$process.Refresh(); $guard.Refresh()
if (-not (Test-Path -LiteralPath $readyFile) -or $process.HasExited -or $guard.HasExited) {
  if (-not $guard.HasExited) { Stop-Process -Id $guard.Id -Force -ErrorAction SilentlyContinue }
  & taskkill.exe /PID $process.Id /T /F | Out-Null
  Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
  $detail = if (Test-Path -LiteralPath $guardErrLog) { Get-Content -LiteralPath $guardErrLog -Raw } else { '' }
  throw "Could not confirm Maya sleep prevention; DeepSeek was stopped. $detail"
}
Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
$guard.Refresh()
@{ pid = $process.Id; executable = $python; started_utc_ticks = $startedTicks;
  sleep_guard_pid = $guard.Id; sleep_guard_executable = $guard.Path;
  sleep_guard_started_utc_ticks = $guard.StartTime.ToUniversalTime().Ticks } |
  ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding ascii
Write-Output "Project Maya DeepSeek started (PID $($process.Id), API http://127.0.0.1:8080/v1); sleep prevention confirmed (PID $($guard.Id))."
