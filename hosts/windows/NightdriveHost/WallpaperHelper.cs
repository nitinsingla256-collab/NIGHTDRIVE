using System;
using System.Runtime.InteropServices;

namespace NightdriveHost;

/// <summary>
/// Attaches a WPF window to the Windows WorkerW window so it renders
/// BEHIND desktop icons but ABOVE the static wallpaper.
///
/// Technique (known as "WorkerW injection", used by Wallpaper Engine etc.):
/// 1. Find Progman.
/// 2. Send 0x052C to create a WorkerW child if one doesn't exist.
/// 3. Enumerate top-level windows to find the WorkerW.
/// 4. SetParent our HWND into that WorkerW.
///
/// Tested on Windows 10 (build 1903+). May need adaptation on Windows 11.
/// </summary>
public static class WallpaperHelper
{
    // ── Win32 imports ──────────────────────────────────────────────────────
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr FindWindow(string lpClassName, string? lpWindowName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam,
        uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr FindWindowEx(
        IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string? lpszWindow);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    private static extern int GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    private const uint SMTO_NORMAL   = 0x0000;
    private const uint WM_SPAWN_WORKER = 0x052C;
    private const int  GWL_EXSTYLE   = -20;
    private const int  WS_EX_NOACTIVATE = 0x08000000;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOZORDER = 0x0004;
    private static readonly IntPtr HWND_BOTTOM = new IntPtr(1);

    // ── Public API ─────────────────────────────────────────────────────────

    /// <summary>
    /// Attaches <paramref name="wpfHwnd"/> to the WorkerW window.
    /// Returns true if the attachment succeeded.
    /// </summary>
    public static bool AttachToDesktop(IntPtr wpfHwnd)
    {
        IntPtr progman = FindWindow("Progman", null);
        if (progman == IntPtr.Zero) return false;

        // Ask Progman to spawn the WorkerW
        SendMessageTimeout(progman, WM_SPAWN_WORKER, UIntPtr.Zero, IntPtr.Zero,
            SMTO_NORMAL, 1000, out _);

        // Find the WorkerW that was created behind the desktop icons
        IntPtr workerW = FindWorkerW();
        if (workerW == IntPtr.Zero) return false;

        // Reparent our window inside WorkerW
        SetParent(wpfHwnd, workerW);

        // Make the window non-activatable so it doesn't steal focus
        int exStyle = GetWindowLong(wpfHwnd, GWL_EXSTYLE);
        SetWindowLong(wpfHwnd, GWL_EXSTYLE, exStyle | WS_EX_NOACTIVATE);

        return true;
    }

    /// <summary>
    /// Sizes and positions <paramref name="wpfHwnd"/> to fill the
    /// virtual screen (all monitors).
    /// </summary>
    public static void FillVirtualScreen(IntPtr wpfHwnd)
    {
        int x = System.Windows.Forms.SystemInformation.VirtualScreen.X;
        int y = System.Windows.Forms.SystemInformation.VirtualScreen.Y;
        int w = System.Windows.Forms.SystemInformation.VirtualScreen.Width;
        int h = System.Windows.Forms.SystemInformation.VirtualScreen.Height;
        SetWindowPos(wpfHwnd, HWND_BOTTOM, x, y, w, h, 0);
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private static IntPtr FindWorkerW()
    {
        IntPtr workerW = IntPtr.Zero;

        EnumWindows((topHwnd, _) =>
        {
            IntPtr shell = FindWindowEx(topHwnd, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (shell != IntPtr.Zero)
            {
                // The WorkerW we want is the NEXT window after this one
                workerW = FindWindowEx(IntPtr.Zero, topHwnd, "WorkerW", null);
            }
            return true; // continue enumeration
        }, IntPtr.Zero);

        return workerW;
    }
}
