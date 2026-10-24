using System;
using System.Runtime.InteropServices;

namespace NightdriveHost;

/// <summary>
/// Attaches the WPF window to the WorkerW window so it renders behind desktop
/// icons but above the static wallpaper. The attachment is deliberately kept
/// separate from DesktopInteraction: at rest this window must remain a WorkerW
/// child, while the controls drawer temporarily raises it as a normal window.
/// </summary>
public static class WallpaperHelper
{
    public static Action<string>? Logger { get; set; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindow(string? lpClassName, string? lpWindowName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam,
        uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindowEx(
        IntPtr hwndParent, IntPtr hwndChildAfter, string? lpszClass, string? lpszWindow);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetParent(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLong", SetLastError = true)]
    private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", EntryPoint = "SetWindowLong", SetLastError = true)]
    private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    private const uint SMTO_NORMAL = 0x0000;
    private const uint WM_SPAWN_WORKER = 0x052C;
    private const int GWL_STYLE = -16;
    private const long WS_CHILD = 0x40000000L;
    private const long WS_POPUP = 0x80000000L;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private static readonly IntPtr HWND_BOTTOM = new(1);

    /// <summary>
    /// Finds WorkerW, reparents the WPF HWND, and records the parent for the
    /// raise/sink bridge. The caller is responsible for sizing the child after
    /// this returns true.
    /// </summary>
    public static bool AttachToDesktop(IntPtr wpfHwnd)
    {
        try
        {
            Log($"AttachToDesktop begin: hwnd={Hex(wpfHwnd)}");
            if (!IsWindow(wpfHwnd))
            {
                Log($"AttachToDesktop refused: hwnd={Hex(wpfHwnd)} is not a window");
                return false;
            }

            IntPtr progman = FindWindow("Progman", null);
            Log($"FindWindow Progman={Hex(progman)}, error={Marshal.GetLastWin32Error()}");
            if (progman == IntPtr.Zero) return false;

            SetLastErrorForDiagnostics();
            IntPtr messageResult = SendMessageTimeout(
                progman,
                WM_SPAWN_WORKER,
                UIntPtr.Zero,
                IntPtr.Zero,
                SMTO_NORMAL,
                1000,
                out UIntPtr result);
            Log($"SendMessageTimeout WM_SPAWN_WORKER returned={Hex(messageResult)}, result=0x{result.ToUInt64():X}, " +
                $"error={Marshal.GetLastWin32Error()}");

            IntPtr workerW = FindWorkerW();
            Log($"FindWorkerW result={Hex(workerW)}");
            if (workerW == IntPtr.Zero || !IsWindow(workerW))
            {
                Log($"WorkerW invalid: hwnd={Hex(workerW)}, isWindow={IsWindow(workerW)}");
                return false;
            }

            // Make the HWND a real child before setting the parent. Explicitly
            // changing the style is important when the HWND is later detached
            // again by DesktopInteraction.Raise.
            if (!SetWindowStyle(wpfHwnd, MakeChildStyle(GetWindowStyle(wpfHwnd))))
            {
                Log("AttachToDesktop failed to apply WS_CHILD style");
                return false;
            }

            SetLastErrorForDiagnostics();
            IntPtr previousParent = SetParent(wpfHwnd, workerW);
            int parentError = Marshal.GetLastWin32Error();
            IntPtr actualParent = GetParent(wpfHwnd);
            bool attached = actualParent == workerW;
            Log($"SetParent attach: requested={Hex(workerW)}, returned={Hex(previousParent)}, " +
                $"lastError={parentError}, actualParent={Hex(actualParent)}, success={attached}");

            LogWindowState(wpfHwnd, "after AttachToDesktop SetParent");
            if (!attached)
            {
                SetWindowStyle(wpfHwnd, MakeTopLevelStyle(GetWindowStyle(wpfHwnd)));
                return false;
            }

            DesktopInteraction.RememberDesktopParent(wpfHwnd, workerW);
            return true;
        }
        catch (Exception ex)
        {
            Log($"AttachToDesktop exception: {ex}");
            return false;
        }
    }

    /// <summary>
    /// Sizes the HWND to the virtual screen. A WorkerW child uses coordinates
    /// relative to its parent; a raised/top-level window uses screen coordinates.
    /// </summary>
    public static void FillVirtualScreen(IntPtr wpfHwnd)
    {
        try
        {
            int x = System.Windows.Forms.SystemInformation.VirtualScreen.X;
            int y = System.Windows.Forms.SystemInformation.VirtualScreen.Y;
            int width = System.Windows.Forms.SystemInformation.VirtualScreen.Width;
            int height = System.Windows.Forms.SystemInformation.VirtualScreen.Height;
            IntPtr parent = GetParent(wpfHwnd);

            if (parent != IntPtr.Zero && IsWindow(parent) && GetClientRect(parent, out RECT client) &&
                client.Right > client.Left && client.Bottom > client.Top)
            {
                x = 0;
                y = 0;
                width = client.Right - client.Left;
                height = client.Bottom - client.Top;
                Log($"FillVirtualScreen using WorkerW client: parent={Hex(parent)}, rect={RectText(client)}");
            }
            else
            {
                if (parent != IntPtr.Zero)
                {
                    // A shell window can report a zero client rectangle while
                    // it is still being created. Child coordinates are still
                    // parent-relative, so do not pass negative virtual-screen
                    // coordinates in that case.
                    x = 0;
                    y = 0;
                    Log($"FillVirtualScreen using virtual dimensions relative to parent={Hex(parent)}");
                }
                else
                {
                    Log($"FillVirtualScreen using virtual screen: parent={Hex(parent)}, " +
                        $"x={x}, y={y}, width={width}, height={height}");
                }
            }

            bool positioned = SetWindowPos(
                wpfHwnd,
                HWND_BOTTOM,
                x,
                y,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW);
            Log($"FillVirtualScreen SetWindowPos result={positioned}, error={Marshal.GetLastWin32Error()}");
            LogWindowState(wpfHwnd, "after FillVirtualScreen");
        }
        catch (Exception ex)
        {
            Log($"FillVirtualScreen exception: {ex}");
        }
    }

    /// <summary>
    /// Emits the native state needed to diagnose desktop hierarchy and z-order
    /// problems without a debugger attached.
    /// </summary>
    public static void LogWindowState(IntPtr hwnd, string label)
    {
        try
        {
            bool isWindow = IsWindow(hwnd);
            bool visible = isWindow && IsWindowVisible(hwnd);
            IntPtr parent = isWindow ? GetParent(hwnd) : IntPtr.Zero;
            bool haveRect = isWindow && GetWindowRect(hwnd, out RECT rect);
            string bounds = haveRect ? RectText(rect) : "<unavailable>";
            Log($"{label}: hwnd={Hex(hwnd)}, IsWindow={isWindow}, IsWindowVisible={visible}, " +
                $"GetParent={Hex(parent)}, GetWindowRect={bounds}, error={Marshal.GetLastWin32Error()}");
        }
        catch (Exception ex)
        {
            Log($"LogWindowState exception ({label}): {ex}");
        }
    }

    private static IntPtr FindWorkerW()
    {
        IntPtr workerW = IntPtr.Zero;
        bool enumerated = EnumWindows((topHwnd, _) =>
        {
            try
            {
                IntPtr shell = FindWindowEx(topHwnd, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (shell != IntPtr.Zero)
                {
                    // The WorkerW immediately after the shell view is the
                    // desktop layer that sits behind the icon view.
                    workerW = FindWindowEx(IntPtr.Zero, topHwnd, "WorkerW", null);
                    Log($"FindWorkerW: top={Hex(topHwnd)}, shell={Hex(shell)}, candidate={Hex(workerW)}");
                }
            }
            catch (Exception ex)
            {
                Log($"FindWorkerW enumeration exception: {ex}");
            }
            return true;
        }, IntPtr.Zero);

        Log($"FindWorkerW EnumWindows result={enumerated}, selected={Hex(workerW)}, error={Marshal.GetLastWin32Error()}");
        return workerW;
    }

    private static long GetWindowStyle(IntPtr hwnd)
    {
        IntPtr value = IntPtr.Size == 8
            ? GetWindowLongPtr64(hwnd, GWL_STYLE)
            : new IntPtr(GetWindowLong32(hwnd, GWL_STYLE));
        Log($"GetWindowLong style: hwnd={Hex(hwnd)}, value=0x{value.ToInt64():X}, error={Marshal.GetLastWin32Error()}");
        return value.ToInt64();
    }

    private static long MakeChildStyle(long style) => (style | WS_CHILD) & ~WS_POPUP;
    private static long MakeTopLevelStyle(long style) => (style & ~WS_CHILD) | WS_POPUP;

    private static bool SetWindowStyle(IntPtr hwnd, long style)
    {
        IntPtr previous = IntPtr.Size == 8
            ? SetWindowLongPtr64(hwnd, GWL_STYLE, new IntPtr(style))
            : new IntPtr(SetWindowLong32(hwnd, GWL_STYLE, unchecked((int)style)));
        int error = Marshal.GetLastWin32Error();
        Log($"SetWindowLong style: hwnd={Hex(hwnd)}, previous=0x{previous.ToInt64():X}, " +
            $"requested=0x{style:X}, error={error}");
        return GetWindowStyle(hwnd) == style;
    }

    private static void SetLastErrorForDiagnostics() { }

    private static string RectText(RECT rect) =>
        $"({rect.Left},{rect.Top})-({rect.Right},{rect.Bottom}) " +
        $"{rect.Right - rect.Left}x{rect.Bottom - rect.Top}";

    private static string Hex(IntPtr value) => $"0x{value.ToInt64():X}";

    private static void Log(string message)
    {
        try { Logger?.Invoke("[Wallpaper] " + message); }
        catch { /* diagnostics must never take down the host */ }
    }
}
