$ErrorActionPreference = 'Stop'
$pidFile = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\data\deepseek-managed.pid'))
if (-not (Test-Path -LiteralPath $pidFile)) {
  if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) { throw 'Project Maya is running without a verified DeepSeek PID; stop it manually.' }
  exit 0
}

$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$process = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
if ($process) {
  if ($process.StartTime.ToUniversalTime().Ticks -ne [long]$record.started_utc_ticks) { throw 'DeepSeek PID was reused; refusing to stop an unrelated process.' }
  if ($process.Path -and [System.IO.Path]::GetFullPath($process.Path) -ne [System.IO.Path]::GetFullPath([string]$record.executable)) {
    throw 'DeepSeek PID belongs to another executable; refusing to stop it.'
  }
  & taskkill.exe /PID ([int]$record.pid) /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not stop DeepSeek process tree (PID $($record.pid))" }
}

$deadline = (Get-Date).AddSeconds(30)
while ((Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) { throw 'DeepSeek port 8080 did not close' }
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
if ($record.sleep_guard_pid -and $record.sleep_guard_started_utc_ticks) {
  $guard = Get-Process -Id ([int]$record.sleep_guard_pid) -ErrorAction SilentlyContinue
  if ($guard -and $guard.StartTime.ToUniversalTime().Ticks -eq [long]$record.sleep_guard_started_utc_ticks) {
    $expectedPowerShell = [string]$record.sleep_guard_executable
    if ($guard.Path -and [System.IO.Path]::GetFullPath($guard.Path) -eq $expectedPowerShell) {
      Stop-Process -Id $guard.Id -Force -ErrorAction SilentlyContinue
    }
  }
}
Remove-Item -LiteralPath (Join-Path $PSScriptRoot '..\data\deepseek-sleep-guard.ready') -Force -ErrorAction SilentlyContinue
Write-Output 'Project Maya DeepSeek stopped and port 8080 is closed.'
