# This process exists while a work declaration or SGLang workload is active. The request is
# per-thread; ending this process releases it even if the monitor crashes.
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SleepGuard {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]0x00000001
$request = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED
if ([SleepGuard]::SetThreadExecutionState($request) -eq 0) {
  throw "SetThreadExecutionState failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
try {
  while ($true) {
    Start-Sleep -Seconds 30
    # Refresh the request so it remains valid across long-running sessions.
    if ([SleepGuard]::SetThreadExecutionState($request) -eq 0) {
      throw "SetThreadExecutionState refresh failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
  }
}
finally {
  [void][SleepGuard]::SetThreadExecutionState($ES_CONTINUOUS)
}
