param([Parameter(Mandatory = $true)][int]$ParentPid)

# Resident probe for OllamaPCMonitor. Talks to the Node parent over stdout,
# one ASCII line per message: READY | S <idleSec> <locked 0/1> | R <remote-state> | E suspend | E resume

# Load C# code for GetLastInputInfo only once
if (-not ([System.Management.Automation.PSTypeName]'LastInputHelper').Type) {
    Add-Type -TypeDefinition @"
        using System;
        using System.Runtime.InteropServices;
        using System.Threading;
        using System.Windows.Forms;
        public class LastInputHelper {
            [StructLayout(LayoutKind.Sequential)]
            public struct LASTINPUTINFO {
                public uint cbSize;
                public uint dwTime;
            }
        [DllImport("user32.dll")]
        static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [StructLayout(LayoutKind.Sequential)]
        struct WTS_SESSION_INFO { public int SessionID; public IntPtr pWinStationName; public int State; }
        [DllImport("wtsapi32.dll", SetLastError=true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool WTSEnumerateSessions(IntPtr hServer, uint Reserved, uint Version, out IntPtr ppSessionInfo, out int pCount);
        [DllImport("wtsapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool WTSQuerySessionInformation(IntPtr hServer, int sessionId, int infoClass, out IntPtr ppBuffer, out int pBytesReturned);
        [DllImport("wtsapi32.dll")]
        static extern void WTSFreeMemory(IntPtr memory);
        const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
        const int WM_KEYDOWN = 0x0100, WM_SYSKEYDOWN = 0x0104, WM_MOUSEMOVE = 0x0200,
                  WM_LBUTTONDOWN = 0x0201, WM_RBUTTONDOWN = 0x0204, WM_MBUTTONDOWN = 0x0207;
        const uint LLKHF_INJECTED = 0x10, LLMHF_INJECTED = 0x01;
        delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
        [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr dwExtraInfo; }
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr module, uint threadId);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
        static HookProc keyboardCallback = KeyboardHook, mouseCallback = MouseHook;
        static IntPtr keyboardHook, mouseHook;
            public static int GetIdleSeconds() {
                LASTINPUTINFO lii = new LASTINPUTINFO();
                lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
                if (!GetLastInputInfo(ref lii)) return -1;
                uint idleMs = unchecked((uint)Environment.TickCount - lii.dwTime);
            return (int)(idleMs / 1000);
        }
        public static int GetForegroundProcessId() {
            uint pid;
            GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            return (int)pid;
        }
        // WTS_CONNECTSTATE_CLASS: Active=0, Disconnected=4.
        // WTS_INFO_CLASS WTSClientProtocolType=16; protocol 2 is RDP, 0 is console.
        public static string GetRemoteSessionState() {
            IntPtr sessions = IntPtr.Zero;
            int count = 0;
            if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out sessions, out count)) return "unknown";
            bool active = false, disconnected = false, queryFailed = false;
            try {
                int size = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
                for (int i = 0; i < count; i++) {
                    IntPtr current = IntPtr.Add(sessions, i * size);
                    WTS_SESSION_INFO info = (WTS_SESSION_INFO)Marshal.PtrToStructure(current, typeof(WTS_SESSION_INFO));
                    if (info.State != 0 && info.State != 4) continue;
                    IntPtr buffer = IntPtr.Zero;
                    int bytes = 0;
                    if (!WTSQuerySessionInformation(IntPtr.Zero, info.SessionID, 16, out buffer, out bytes) || buffer == IntPtr.Zero || bytes < 2) {
                        if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);
                        queryFailed = true;
                        continue;
                    }
                    try {
                        int protocol = (int)Marshal.ReadInt16(buffer);
                        if (protocol == 2) {
                            if (info.State == 0) active = true;
                            else if (info.State == 4) disconnected = true;
                        }
                    } finally { WTSFreeMemory(buffer); }
                }
            } finally { WTSFreeMemory(sessions); }
            if (active) return "active";
            if (queryFailed) return "unknown";
            return disconnected ? "disconnected" : "none";
        }
        static void Report(string kind) { Console.Out.WriteLine("I " + kind + " injected"); Console.Out.Flush(); }
        static IntPtr KeyboardHook(int code, IntPtr wParam, IntPtr lParam) {
            if (code >= 0 && ((int)wParam == WM_KEYDOWN || (int)wParam == WM_SYSKEYDOWN)) {
                var info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                if ((info.flags & LLKHF_INJECTED) != 0) Report("keyboard");
            }
            return CallNextHookEx(keyboardHook, code, wParam, lParam);
        }
        static IntPtr MouseHook(int code, IntPtr wParam, IntPtr lParam) {
            if (code >= 0) {
                var message = (int)wParam;
                var info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                if ((info.flags & LLMHF_INJECTED) != 0 && (message == WM_MOUSEMOVE || message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN)) Report("mouse");
            }
            return CallNextHookEx(mouseHook, code, wParam, lParam);
        }
        public static void StartInputTrace() {
            var thread = new Thread(() => {
                var module = GetModuleHandle(null);
                keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardCallback, module, 0);
                mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseCallback, module, 0);
                Application.Run();
            });
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
        }
        }
"@ -ReferencedAssemblies 'System.Windows.Forms' -ErrorAction Stop
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

# Passive diagnostic only: records inputs Windows marks as SendInput-style injection.
[LastInputHelper]::StartInputTrace()

Send-Line 'READY'

while ($true) {
    try {
        # Exit when the Node parent is gone
        if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }

        $idleSec = [LastInputHelper]::GetIdleSeconds()
        # LogonUI.exe is alive while the session is locked
        $locked = if (Get-Process -Name LogonUI -ErrorAction SilentlyContinue) { 1 } else { 0 }
        # Unmeasurable idle time (-1) is not reported: "unknown" must not look like "0"
        if ($idleSec -ge 0) {
            $foreground = ''
            try { $foreground = (Get-Process -Id ([LastInputHelper]::GetForegroundProcessId()) -ErrorAction Stop).ProcessName } catch { }
            # Process names are used only as local diagnosis metadata. Keep the protocol one-line and ASCII-safe.
            $foreground = ($foreground -replace '[^A-Za-z0-9._-]', '').Substring(0, [Math]::Min(80, $foreground.Length))
            Send-Line "S $idleSec $locked $foreground"
        }
        $remoteSession = 'unknown'
        try { $remoteSession = [LastInputHelper]::GetRemoteSessionState() } catch { }
        Send-Line "R $remoteSession"
    }
    catch { }
    Start-Sleep -Milliseconds 1000
}
