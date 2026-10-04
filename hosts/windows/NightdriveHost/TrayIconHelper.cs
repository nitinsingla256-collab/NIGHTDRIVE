using System;
using System.Drawing;
using System.Windows.Forms;
using WpfApp = System.Windows.Application;

namespace NightdriveHost;

/// <summary>
/// Minimal system-tray icon.
/// Right-click → "Exit NIGHTDRIVE" to close the app.
/// </summary>
public class TrayIconHelper : IDisposable
{
    private NotifyIcon? _icon;

    public void Show()
    {
        _icon = new NotifyIcon
        {
            Text    = "NIGHTDRIVE Wallpaper",
            Visible = true,
            Icon    = CreateIcon()
        };

        var menu = new ContextMenuStrip();

        var titleItem = new ToolStripMenuItem("NIGHTDRIVE") { Enabled = false };
        
        var startupItem = new ToolStripMenuItem("Start with Windows");
        startupItem.CheckOnClick = true;
        startupItem.Checked = IsStartupEnabled();
        startupItem.CheckedChanged += (_, _) => SetStartup(startupItem.Checked);

        var exitItem  = new ToolStripMenuItem("Exit NIGHTDRIVE");
        exitItem.Click += (_, _) =>
        {
            _icon!.Visible = false;
            WpfApp.Current.Shutdown();
        };

        menu.Items.Add(titleItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(startupItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);

        _icon.ContextMenuStrip = menu;
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

    private static void SetStartup(bool enable)
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey, true);
            if (key == null) return;

            if (enable)
            {
                string exePath = $"\"{System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName}\"";
                key.SetValue(AppName, exePath);
            }
            else
            {
                key.DeleteValue(AppName, false);
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"Failed to set startup: {ex.Message}");
        }
    }

    /// <summary>
    /// Creates a simple programmatic car silhouette icon (16×16).
    /// Avoids requiring an external .ico file.
    /// </summary>
    private static Icon CreateIcon()
    {
        using var bmp = new Bitmap(16, 16);
        using var g   = Graphics.FromImage(bmp);
        g.Clear(Color.FromArgb(0, 0, 0));           // black background

        // Simple car silhouette in accent gold
        using var brush = new SolidBrush(Color.FromArgb(196, 154, 74));
        // body
        g.FillRectangle(brush, 1, 9, 14, 4);
        // roof
        g.FillRectangle(brush, 4, 5, 8, 5);
        // wheels
        g.FillEllipse(Brushes.White, 1, 11, 4, 4);
        g.FillEllipse(Brushes.White, 11, 11, 4, 4);

        IntPtr hIcon = bmp.GetHicon();
        return Icon.FromHandle(hIcon);
    }

    public void Dispose()
    {
        _icon?.Dispose();
    }
}
