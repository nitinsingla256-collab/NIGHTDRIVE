using System;
using System.Drawing;
using System.Windows.Forms;
using WpfApp = System.Windows.Application;

namespace NightdriveHost;

/// <summary>
/// System-tray entry point for a wallpaper window that is normally hidden
/// behind Explorer's desktop icons.
/// </summary>
public class TrayIconHelper : IDisposable
{
    private NotifyIcon? _icon;
    private ContextMenuStrip? _menu;

    public Action? OpenSettingsRequested { get; set; }
    public Action<string>? OnLogTime { get; set; }

    public void Show()
    {
        try
        {
            _icon = new NotifyIcon
            {
                Text = "NIGHTDRIVE Wallpaper",
                Visible = true,
                Icon = CreateIcon()
            };

            _menu = new ContextMenuStrip();
            var titleItem = new ToolStripMenuItem("NIGHTDRIVE") { Enabled = false };

            var settingsItem = new ToolStripMenuItem("Open settings");
            settingsItem.Click += OnOpenSettingsClick;

            var startupItem = new ToolStripMenuItem("Start with Windows")
            {
                CheckOnClick = true,
                Checked = IsStartupEnabled()
            };
            startupItem.CheckedChanged += OnStartupChanged;

            var exitItem = new ToolStripMenuItem("Exit NIGHTDRIVE");
            exitItem.Click += OnExitClick;

            _menu.Items.Add(titleItem);
            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add(settingsItem);
            _menu.Items.Add(startupItem);
            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add(exitItem);
            _icon.ContextMenuStrip = _menu;
            Log("tray icon ready");
        }
        catch (Exception ex)
        {
            Log($"tray setup exception: {ex}");
        }
    }

    private void OnOpenSettingsClick(object? sender, EventArgs e)
    {
        try
        {
            Log("tray requested open settings");
            OpenSettingsRequested?.Invoke();
        }
        catch (Exception ex)
        {
            Log($"tray open settings exception: {ex}");
        }
    }

    private void OnStartupChanged(object? sender, EventArgs e)
    {
        try
        {
            if (sender is ToolStripMenuItem item) SetStartup(item.Checked);
        }
        catch (Exception ex)
        {
            Log($"tray startup toggle exception: {ex}");
        }
    }

    private void OnExitClick(object? sender, EventArgs e)
    {
        try
        {
            Log("tray requested exit");
            if (_icon != null) _icon.Visible = false;
            WpfApp.Current.Shutdown();
        }
        catch (Exception ex)
        {
            Log($"tray exit exception: {ex}");
        }
    }

    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string AppName = "NightdriveWallpaper";

    private static bool IsStartupEnabled()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey, false);
            return key?.GetValue(AppName) != null;
        }
        catch
        {
            return false;
        }
    }

    private void SetStartup(bool enable)
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey, true);
            if (key == null)
            {
                Log("startup toggle skipped: Run registry key unavailable");
                return;
            }

            if (enable)
            {
                string exePath = $"\"{System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName}\"";
                key.SetValue(AppName, exePath);
            }
            else
            {
                key.DeleteValue(AppName, false);
            }
            Log($"start with Windows={(enable ? "on" : "off")}");
        }
        catch (Exception ex)
        {
            Log($"startup registry exception: {ex}");
        }
    }

    /// <summary>
    /// Creates a small programmatic car silhouette icon, avoiding another
    /// packaged asset and keeping the tray entry available in a published build.
    /// </summary>
    private static Icon CreateIcon()
    {
        using var bmp = new Bitmap(16, 16);
        using var g = Graphics.FromImage(bmp);
        g.Clear(Color.FromArgb(0, 0, 0));

        using var brush = new SolidBrush(Color.FromArgb(196, 154, 74));
        g.FillRectangle(brush, 1, 9, 14, 4);
        g.FillRectangle(brush, 4, 5, 8, 5);
        g.FillEllipse(Brushes.White, 1, 11, 4, 4);
        g.FillEllipse(Brushes.White, 11, 11, 4, 4);

        IntPtr hIcon = bmp.GetHicon();
        return Icon.FromHandle(hIcon);
    }

    public void Dispose()
    {
        try
        {
            if (_icon != null) _icon.Visible = false;
            _icon?.Dispose();
            _menu?.Dispose();
            _icon = null;
            _menu = null;
        }
        catch (Exception ex)
        {
            Log($"tray dispose exception: {ex}");
        }
    }

    private void Log(string message)
    {
        try { OnLogTime?.Invoke("[Tray] " + message); }
        catch { /* logging must never take down the host */ }
    }
}
