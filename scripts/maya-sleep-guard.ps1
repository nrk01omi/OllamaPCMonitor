param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][long]$ProcessStartUtcTicks,
  [Parameter(Mandatory = $true)][string]$ReadyFile
)

$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MayaSleepGuard {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]0x00000001
$request = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED

function Test-MayaProcess {
  try {
    $target = Get-Process -Id $ProcessId -ErrorAction Stop
    return $target.StartTime.ToUniversalTime().Ticks -eq $ProcessStartUtcTicks
  } catch { return $false }
}

if (-not (Test-MayaProcess)) { throw "Maya process $ProcessId is not running with the expected start time." }
if ([MayaSleepGuard]::SetThreadExecutionState($request) -eq 0) {
  throw "SetThreadExecutionState failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
try {
  Set-Content -LiteralPath $ReadyFile -Value "$PID $ProcessId $ProcessStartUtcTicks" -Encoding ascii
  while (Test-MayaProcess) {
    Start-Sleep -Seconds 15
    if (-not (Test-MayaProcess)) { break }
    if ([MayaSleepGuard]::SetThreadExecutionState($request) -eq 0) {
      throw "SetThreadExecutionState refresh failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
  }
} finally {
  Remove-Item -LiteralPath $ReadyFile -Force -ErrorAction SilentlyContinue
  [void][MayaSleepGuard]::SetThreadExecutionState($ES_CONTINUOUS)
}
