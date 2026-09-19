param([Parameter(Mandatory = $true)][int]$ParentPid)

# Resident probe for OllamaPCMonitor. Talks to the Node parent over stdout,
# one ASCII line per message:  READY | S <idleSec> <locked 0/1> | E suspend | E resume

# Load C# code for GetLastInputInfo only once
if (-not ([System.Management.Automation.PSTypeName]'LastInputHelper').Type) {
    Add-Type -TypeDefinition @"
        using System;
        using System.Runtime.InteropServices;
        public class LastInputHelper {
            [StructLayout(LayoutKind.Sequential)]
            public struct LASTINPUTINFO {
                public uint cbSize;
                public uint dwTime;
            }
            [DllImport("user32.dll")]
            static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
            public static int GetIdleSeconds() {
                LASTINPUTINFO lii = new LASTINPUTINFO();
                lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
                if (!GetLastInputInfo(ref lii)) return -1;
                uint idleMs = unchecked((uint)Environment.TickCount - lii.dwTime);
                return (int)(idleMs / 1000);
            }
        }
"@ -ErrorAction Stop
}

function Send-Line([string]$text) {
    [Console]::Out.WriteLine($text)
    [Console]::Out.Flush()
}

# Power events (Write-Output inside -Action does not reach stdout, so use Console directly)
Register-ObjectEvent -InputObject ([Microsoft.Win32.SystemEvents]) -EventName PowerModeChanged -Action {
    switch ($EventArgs.Mode) {
        'Suspend' { [Console]::Out.WriteLine('E suspend'); [Console]::Out.Flush() }
        'Resume'  { [Console]::Out.WriteLine('E resume');  [Console]::Out.Flush() }
    }
} | Out-Null

Send-Line 'READY'

while ($true) {
    try {
        # Exit when the Node parent is gone
        if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }

        $idleSec = [LastInputHelper]::GetIdleSeconds()
        # LogonUI.exe is alive while the session is locked
        $locked = if (Get-Process -Name LogonUI -ErrorAction SilentlyContinue) { 1 } else { 0 }
        # Unmeasurable idle time (-1) is not reported: "unknown" must not look like "0"
        if ($idleSec -ge 0) { Send-Line "S $idleSec $locked" }
    }
    catch { }
    Start-Sleep -Milliseconds 1000
}
