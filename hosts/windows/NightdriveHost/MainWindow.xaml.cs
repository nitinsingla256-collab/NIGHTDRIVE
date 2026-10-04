using System;
using System.IO;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using WpfApp = System.Windows.Application;

namespace NightdriveHost;

public partial class MainWindow : Window
{
    private BatteryHelper?  _battery;
    private ConnectivityHelper? _connectivity;
    private TrayIconHelper? _tray;
    private bool _desktopAttached = false;

    // Path to the NIGHTDRIVE web root
    private static string WebRoot
    {
        get
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null)
            {
                string engineDir = Path.Combine(dir.FullName, "engine");
                if (File.Exists(Path.Combine(engineDir, "index.html")))
                {
                    return engineDir;
                }
                dir = dir.Parent;
            }
            return AppContext.BaseDirectory; // fallback
        }
    }

    private static readonly System.Diagnostics.Stopwatch _sw = System.Diagnostics.Stopwatch.StartNew();
    private void LogTime(string step)
    {
        try
        {
            long ms = _sw.ElapsedMilliseconds;
            string logFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Desktop), "NIGHTDRIVE_STARTUP.log");
            File.AppendAllText(logFile, $"[T+{ms,4}ms] {step}{Environment.NewLine}");
        }
        catch { }
    }

    public MainWindow()
    {
        LogTime("1. Process launch / Native host initialization started");
        InitializeComponent();

        // Stage 1 Fast Startup: Show fallback image immediately
        try
        {
            string fallbackPath = Path.Combine(WebRoot, "assets", "dusk", "sky.jpg");
            if (File.Exists(fallbackPath))
            {
                FallbackImage.Source = new System.Windows.Media.Imaging.BitmapImage(new Uri(fallbackPath, UriKind.Absolute));
            }
        }
        catch { }
        LogTime("2. Native host initialization complete (Fallback image ready)");

        // Tray icon — must be created before the window shows
        _tray = new TrayIconHelper();
        _tray.Show();

        Loaded += OnLoaded;
        Closed += OnClosed;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        // ── 0. Validate Web Root ───────────────────────────────────────────
        string[] requiredFiles = {
            "index.html",
            "script.js",
            "styles.css",
            @"assets\morning\scene.jpg",
            @"assets\day\scene.jpg",
            @"assets\golden-hour\scene.jpg",
            @"assets\dusk\scene.jpg",
            @"assets\night\scene.jpg",
            @"assets\midnight\scene.jpg"
        };

        foreach (string file in requiredFiles)
        {
            string fullPath = Path.Combine(WebRoot, file);
            if (!File.Exists(fullPath))
            {
                System.Windows.MessageBox.Show($"Could not find essential NIGHTDRIVE project file:\n\n{file}\n\nExpected at:\n{WebRoot}\n\nPlease ensure the application and its artwork are placed correctly.", "NIGHTDRIVE Error", System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Error);
                WpfApp.Current.Shutdown();
                return;
            }
        }

        // ── 1. Configure WebView2 ──────────────────────────────────────────
        string userDataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "NightdriveHost");

        var options = new CoreWebView2EnvironmentOptions();
        options.AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required";

        LogTime("4a. WebView2 initialization started");
        var env = await CoreWebView2Environment.CreateAsync(
            browserExecutableFolder: null,
            userDataFolder:          userDataDir,
            options:                 options);

        await WebView.EnsureCoreWebView2Async(env);
        
        // Clear cache so ?v=3 is applied immediately
        await WebView.CoreWebView2.Profile.ClearBrowsingDataAsync(Microsoft.Web.WebView2.Core.CoreWebView2BrowsingDataKinds.CacheStorage | Microsoft.Web.WebView2.Core.CoreWebView2BrowsingDataKinds.DiskCache);
        LogTime("4b. WebView2 initialization complete");

        // Security: allow local file access (web root is a local folder)
        WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "nightdrive.local",
            WebRoot,
            CoreWebView2HostResourceAccessKind.Allow);

        // Disable dev tools, right-click menu, and status bar in final build
#if !DEBUG
        WebView.CoreWebView2.Settings.AreDevToolsEnabled          = false;
        WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        WebView.CoreWebView2.Settings.IsStatusBarEnabled          = false;
        WebView.CoreWebView2.Settings.IsZoomControlEnabled        = false;
#endif
        // Prevent navigation away from the wallpaper
        WebView.CoreWebView2.NavigationStarting += (_, args) =>
        {
            // Allow only the initial load
            if (!args.Uri.Contains("nightdrive.local") && !args.Uri.StartsWith("file://"))
                args.Cancel = true;
        };

        // ── 2. Navigate to the wallpaper ──────────────────────────────────

        // Load via virtual host (avoids CORS issues with fetch() for images)
        WebView.CoreWebView2.Navigate($"https://nightdrive.local/index.html?v={DateTime.Now.Ticks}");

        // ── 3. System Status Bridges ──────────────────────────────────────
        _battery = new BatteryHelper(WebView);
        _connectivity = new ConnectivityHelper(WebView);

        // Start reporting after the page finishes loading
        WebView.CoreWebView2.DOMContentLoaded += (_, _) =>
        {
            _battery.Start();
            _connectivity.Start();
        };

        _connectivity.OnHideFallback = () =>
        {
            Dispatcher.Invoke(() =>
            {
                FallbackImage.Visibility = System.Windows.Visibility.Hidden;
            });
        };

        _connectivity.OnLogTime = (msg) =>
        {
            LogTime(msg);
        };

        // ── 4. Attach to the Windows desktop ──────────────────────────────
        AttachToDesktop();
    }

    private async void AttachToDesktop()
    {
        try
        {
            var helper = new WindowInteropHelper(this);
            IntPtr hwnd = helper.Handle;

            // Stage 1 Fast Startup: immediately stretch across the screen and put at the bottom Z-order
            WallpaperHelper.FillVirtualScreen(hwnd);
            LogTime("3. Fallback background stretched to virtual screen");

            bool attached = false;
            for (int i = 0; i < 15; i++)
            {
                attached = WallpaperHelper.AttachToDesktop(hwnd);
                if (attached)
                {
                    WallpaperHelper.FillVirtualScreen(hwnd);
                    _desktopAttached = true;
                    System.Diagnostics.Debug.WriteLine("[Wallpaper] Attached to WorkerW.");
                    break;
                }
                
                System.Diagnostics.Debug.WriteLine($"[Wallpaper] Desktop not ready, retrying... ({i + 1}/15)");
                await System.Threading.Tasks.Task.Delay(1000);
            }

            if (!attached)
            {
                System.Diagnostics.Debug.WriteLine("[Wallpaper] WorkerW not found after retries — running in window mode.");
                System.Windows.MessageBox.Show("NIGHTDRIVE could not attach to the desktop background after multiple attempts. It is running in a standard window.", "Startup Warning", System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Warning);
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[Wallpaper] Attach failed: {ex.Message}");
        }
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        _battery?.Dispose();
        _connectivity?.Dispose();
        _tray?.Dispose();
    }

    // ── Keyboard shortcut: Escape exits ────────────────────────────────────
    protected override void OnKeyDown(System.Windows.Input.KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (e.Key == System.Windows.Input.Key.Escape)
        {
            WpfApp.Current.Shutdown();
        }
    }
}
