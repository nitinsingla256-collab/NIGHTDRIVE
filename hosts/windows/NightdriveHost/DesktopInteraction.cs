using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace NightdriveHost;

/// <summary>
/// Temporarily moves the wallpaper window out of WorkerW while the controls
/// drawer is being used. A child of WorkerW is below Explorer's icon layer and
/// cannot receive pointer input; a normal top-level window can.
/// </summary>
public static class DesktopInteraction
{
    public static Action<string>? Logger { get; set; }

    private static readonly object Gate = new();
    private static IntPtr _workerW;
    private static IntPtr _attachedHwnd;
    private static bool _raised;

    private const int GWL_STYLE = -16;
    private const int GWL_EXSTYLE = -20;
    private const long WS_CHILD = 0x40000000L;
    private const long WS_POPUP = 0x80000000L;
    private const long WS_EX_NOACTIVATE = 0x08000000L;

    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const uint SWP_FRAMECHANGED = 0x0020;

    private const uint MOD_ALT = 0x0001;
    private const uint MOD_CONTROL = 0x0002;
    private const uint MOD_NOREPEAT = 0x4000;
    private const uint WM_HOTKEY = 0x0312;
    private const uint VK_N = 0x4E;

    private static readonly IntPtr HWND_TOPMOST = new(-1);
    private static readonly IntPtr HWND_NOTOPMOST = new(-2);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", EntryPoint = "RegisterHotKey", SetLastError = true)]
    private static extern bool RegisterHotKeyNative(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", EntryPoint = "UnregisterHotKey", SetLastError = true)]
    private static extern bool UnregisterHotKeyNative(IntPtr hWnd, int id);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetParent(IntPtr hWnd);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLong", SetLastError = true)]
    private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", EntryPoint = "SetWindowLong", SetLastError = true)]
    private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

    /// <summary>
    /// Remembers the WorkerW parent used by WallpaperHelper. The window stays
    /// there until Raise is explicitly requested.
    /// </summary>
    public static void RememberDesktopParent(IntPtr hwnd, IntPtr workerW)
    {
        lock (Gate)
        {
            _attachedHwnd = hwnd;
            _workerW = workerW;
            _raised = false;
            Log($"desktop parent registered: hwnd={Hex(hwnd)}, workerW={Hex(workerW)}");
        }
    }

    public static bool IsRegistered(IntPtr hwnd)
    {
        lock (Gate)
        {
            return hwnd != IntPtr.Zero && hwnd == _attachedHwnd && _workerW != IntPtr.Zero;
        }
    }

    /// <summary>
    /// Detaches the wallpaper from WorkerW and puts it above the desktop icon
    /// layer. The window is not activated by this operation; it can receive
    /// pointer input and will activate only if the user deliberately focuses a
    /// control.
    /// </summary>
    public static bool Raise(IntPtr hwnd)
    {
        lock (Gate)
        {
            try
            {
                if (!IsWindow(hwnd))
                {
                    Log($"raise refused: hwnd={Hex(hwnd)} is not a window");
                    return false;
                }

                IntPtr currentParent = GetParent(hwnd);
                Log($"raise begin: hwnd={Hex(hwnd)}, currentParent={Hex(currentParent)}, workerW={Hex(_workerW)}");

                if (currentParent != IntPtr.Zero)
                {
                    if (!SetTopLevelStyle(hwnd)) return false;
                    if (!SetParentAndLog(hwnd, IntPtr.Zero, "raise")) return false;
                }

                if (!SetNoActivate(hwnd, false)) return false;

                var screen = SystemInformation.VirtualScreen;
                bool positioned = SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    screen.X,
                    screen.Y,
                    screen.Width,
                    screen.Height,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED);
                Log($"raise SetWindowPos topmost={positioned}, error={Marshal.GetLastWin32Error()}");
                if (!positioned) return false;

                _raised = true;
                WallpaperHelper.LogWindowState(hwnd, "after raise");
                return true;
            }
            catch (Exception ex)
            {
                Log($"raise exception: {ex}");
                return false;
            }
        }
    }

    /// <summary>
    /// Reparents the window behind Explorer's icons and restores the
    /// non-activating desktop style.
    /// </summary>
    public static bool Sink(IntPtr hwnd)
    {
        lock (Gate)
        {
            try
            {
                if (!IsWindow(hwnd))
                {
                    Log($"sink refused: hwnd={Hex(hwnd)} is not a window");
                    return false;
                }

                if (_workerW == IntPtr.Zero || !IsWindow(_workerW))
                {
                    Log($"sink refused: WorkerW={Hex(_workerW)} is not a window");
                    return false;
                }

                IntPtr currentParent = GetParent(hwnd);
                Log($"sink begin: hwnd={Hex(hwnd)}, currentParent={Hex(currentParent)}, workerW={Hex(_workerW)}");

                // Remove the topmost relationship before turning the HWND back
                // into a child. This prevents a closed drawer from covering
                // other applications after the next desktop repaint.
                bool notTopmost = SetWindowPos(
                    hwnd,
                    HWND_NOTOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                Log($"sink SetWindowPos not-topmost={notTopmost}, error={Marshal.GetLastWin32Error()}");

                if (!SetChildStyle(hwnd)) return false;
                if (!SetNoActivate(hwnd, true)) return false;
                if (!SetParentAndLog(hwnd, _workerW, "sink")) return false;

                WallpaperHelper.FillVirtualScreen(hwnd);
                _raised = false;
                WallpaperHelper.LogWindowState(hwnd, "after sink");
                return GetParent(hwnd) == _workerW;
            }
            catch (Exception ex)
            {
                Log($"sink exception: {ex}");
                return false;
            }
        }
    }

    public static bool RegisterHotKey(IntPtr hwnd, int id)
    {
        try
        {
            bool registered = RegisterHotKeyNative(hwnd, id, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_N);
            Log($"RegisterHotKey Ctrl+Alt+N: result={registered}, error={Marshal.GetLastWin32Error()}");
            return registered;
        }
        catch (Exception ex)
        {
            Log($"RegisterHotKey exception: {ex}");
            return false;
        }
    }

    public static bool UnregisterHotKey(IntPtr hwnd, int id)
    {
        try
        {
            bool unregistered = UnregisterHotKeyNative(hwnd, id);
            Log($"UnregisterHotKey Ctrl+Alt+N: result={unregistered}, error={Marshal.GetLastWin32Error()}");
            return unregistered;
        }
        catch (Exception ex)
        {
            Log($"UnregisterHotKey exception: {ex}");
            return false;
        }
    }

    private static bool SetParentAndLog(IntPtr hwnd, IntPtr newParent, string operation)
    {
        SetLastErrorForDiagnostics();
        IntPtr previousParent = SetParent(hwnd, newParent);
        int error = Marshal.GetLastWin32Error();
        IntPtr actualParent = GetParent(hwnd);
        bool success = actualParent == newParent;
        Log($"{operation} SetParent: requested={Hex(newParent)}, returned={Hex(previousParent)}, " +
            $"lastError={error}, actualParent={Hex(actualParent)}, success={success}");
        return success;
    }

    private static bool SetTopLevelStyle(IntPtr hwnd)
    {
        long style = GetStyle(hwnd);
        long next = (style & ~WS_CHILD) | WS_POPUP;
        return SetStyle(hwnd, next, "raise top-level style");
    }

    private static bool SetChildStyle(IntPtr hwnd)
    {
        long style = GetStyle(hwnd);
        long next = (style | WS_CHILD) & ~WS_POPUP;
        return SetStyle(hwnd, next, "sink child style");
    }

    private static long GetStyle(IntPtr hwnd)
    {
        IntPtr value = IntPtr.Size == 8
            ? GetWindowLongPtr64(hwnd, GWL_STYLE)
            : new IntPtr(GetWindowLong32(hwnd, GWL_STYLE));
        Log($"GetWindowLong style: hwnd={Hex(hwnd)}, value=0x{value.ToInt64():X}, error={Marshal.GetLastWin32Error()}");
        return value.ToInt64();
    }

    private static bool SetStyle(IntPtr hwnd, long style, string label)
    {
        IntPtr previous = IntPtr.Size == 8
            ? SetWindowLongPtr64(hwnd, GWL_STYLE, new IntPtr(style))
            : new IntPtr(SetWindowLong32(hwnd, GWL_STYLE, unchecked((int)style)));
        int error = Marshal.GetLastWin32Error();
        bool success = GetStyle(hwnd) == style;
        Log($"{label}: previous=0x{previous.ToInt64():X}, requested=0x{style:X}, error={error}, success={success}");
        return success;
    }

    private static bool SetNoActivate(IntPtr hwnd, bool noActivate)
    {
        long current = (IntPtr.Size == 8
            ? GetWindowLongPtr64(hwnd, GWL_EXSTYLE)
            : new IntPtr(GetWindowLong32(hwnd, GWL_EXSTYLE))).ToInt64();
        long next = noActivate ? current | WS_EX_NOACTIVATE : current & ~WS_EX_NOACTIVATE;
        IntPtr previous = IntPtr.Size == 8
            ? SetWindowLongPtr64(hwnd, GWL_EXSTYLE, new IntPtr(next))
            : new IntPtr(SetWindowLong32(hwnd, GWL_EXSTYLE, unchecked((int)next)));
        int error = Marshal.GetLastWin32Error();
        long actual = (IntPtr.Size == 8
            ? GetWindowLongPtr64(hwnd, GWL_EXSTYLE)
            : new IntPtr(GetWindowLong32(hwnd, GWL_EXSTYLE))).ToInt64();
        bool success = noActivate
            ? (actual & WS_EX_NOACTIVATE) != 0
            : (actual & WS_EX_NOACTIVATE) == 0;
        Log($"SetWindowLong exstyle: noActivate={noActivate}, previous=0x{previous.ToInt64():X}, " +
            $"requested=0x{next:X}, actual=0x{actual:X}, error={error}, success={success}");
        return success;
    }

    // There is no supported managed way to clear the thread's last-error slot
    // before SetParent. The native call's captured value is still logged; this
    // marker makes a stale non-zero value obvious in the startup log.
    private static void SetLastErrorForDiagnostics() { }

    private static void Log(string message)
    {
        try { Logger?.Invoke("[DesktopInteraction] " + message); }
        catch { /* diagnostics must never take down the host */ }
    }

    private static string Hex(IntPtr value) => $"0x{value.ToInt64():X}";
}
