# This process exists only while SGLang is loading or serving.  The request is
# per-thread; ending this process releases it even if the monitor crashes.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SleepGuard {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

$ES_CONTINUOUS = [uint32]0x80000000
$ES_SYSTEM_REQUIRED = [uint32]0x00000001
[void][SleepGuard]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
try {
  while ($true) {
    Start-Sleep -Seconds 30
    # Refresh the request so it remains valid across long-running sessions.
    [void][SleepGuard]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
  }
}
finally {
  [void][SleepGuard]::SetThreadExecutionState($ES_CONTINUOUS)
}
