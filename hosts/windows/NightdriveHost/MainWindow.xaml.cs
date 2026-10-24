using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using WpfApp = System.Windows.Application;

namespace NightdriveHost;

public partial class MainWindow : Window
{
    private BatteryHelper? _battery;
    private ConnectivityHelper? _connectivity;
    private TrayIconHelper? _tray;
    private HwndSource? _hwndSource;
    private bool _desktopAttached;
    private bool _drawerRaised;
    private bool _drawerOpenPending;
    private bool _domReady;
    private bool _bridgesStarted;
    private bool _hotKeyRegistered;
    private bool _loaded;
    private bool _startupAborted;

    private const int DrawerHotKeyId = 0x4E44;
    private const uint WM_HOTKEY = 0x0312;

    // Path to the NIGHTDRIVE web root. Published builds contain a sibling
    // `engine` directory; walking upwards also keeps a repo checkout runnable.
    private static string WebRoot
    {
        get
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null)
            {
                string engineDir = Path.Combine(dir.FullName, "engine");
                if (File.Exists(Path.Combine(engineDir, "index.html"))) return engineDir;
                dir = dir.Parent;
            }
            return AppContext.BaseDirectory;
        }
    }

    private static readonly System.Diagnostics.Stopwatch Stopwatch =
        System.Diagnostics.Stopwatch.StartNew();

    public MainWindow()
    {
        WallpaperHelper.Logger = LogTime;
        DesktopInteraction.Logger = LogTime;
        LogTime("constructor: begin");

        try
        {
            InitializeComponent();
            SourceInitialized += OnSourceInitialized;
            Loaded += OnLoaded;
            Closed += OnClosed;

            // Use a real shipped plate for the fast first-paint fallback. This
            // is deliberately hidden only after the engine posts hide_fallback.
            string fallbackPath = Path.Combine(WebRoot, "assets", "dusk", "scene.jpg");
            try
            {
                if (File.Exists(fallbackPath))
                {
                    var image = new BitmapImage();
                    image.BeginInit();
                    image.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
                    image.UriSource = new Uri(fallbackPath, UriKind.Absolute);
                    image.EndInit();
                    FallbackImage.Source = image;
                    LogTime($"fallback image ready: {fallbackPath}");
                }
                else
                {
                    LogTime($"fallback image missing: {fallbackPath}");
                }
            }
            catch (Exception ex)
            {
                LogTime($"fallback image exception: {ex}");
            }

            _tray = new TrayIconHelper
            {
                OpenSettingsRequested = OpenDrawerFromHost,
                OnLogTime = LogTime
            };
            _tray.Show();
            LogTime("constructor: complete");
        }
        catch (Exception ex)
        {
            LogTime($"constructor exception: {ex}");
            _startupAborted = true;
            try { WpfApp.Current.Shutdown(); }
            catch (Exception shutdownEx) { LogTime($"constructor shutdown exception: {shutdownEx}"); }
        }
    }

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        try
        {
            var helper = new WindowInteropHelper(this);
            IntPtr hwnd = helper.Handle;
            LogTime($"SourceInitialized: hwnd={Hex(hwnd)}");
            WallpaperHelper.LogWindowState(hwnd, "SourceInitialized");

            _hwndSource = HwndSource.FromHwnd(hwnd);
            if (_hwndSource != null) _hwndSource.AddHook(WindowMessageHook);
            else LogTime("SourceInitialized: HwndSource unavailable");

            _hotKeyRegistered = DesktopInteraction.RegisterHotKey(hwnd, DrawerHotKeyId);
            LogTime($"Ctrl+Alt+N registration: {_hotKeyRegistered}");
        }
        catch (Exception ex)
        {
            LogTime($"SourceInitialized handler exception: {ex}");
        }
    }

    private IntPtr WindowMessageHook(
        IntPtr hwnd,
        int msg,
        IntPtr wParam,
        IntPtr lParam,
        ref bool handled)
    {
        try
        {
            if (msg == WM_HOTKEY && wParam.ToInt64() == DrawerHotKeyId)
            {
                handled = true;
                LogTime("WM_HOTKEY Ctrl+Alt+N received");
                Dispatcher.BeginInvoke(new Action(OpenDrawerFromHost));
            }
        }
        catch (Exception ex)
        {
            LogTime($"window message hook exception: {ex}");
        }

        return IntPtr.Zero;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        if (_loaded) return;
        _loaded = true;

        try
        {
            LogTime("Loaded handler: begin");
            bool webViewReady = await InitializeWebViewAsync();
            LogTime($"Loaded handler: WebView ready={webViewReady}");
        }
        catch (Exception ex)
        {
            LogTime($"Loaded handler exception: {ex}");
            ShowStartupWarning("NIGHTDRIVE encountered an error while initializing WebView2. The fallback window will remain visible.");
        }

        if (!_startupAborted)
        {
            try { await AttachToDesktopAsync(); }
            catch (Exception ex) { LogTime($"desktop attach continuation exception: {ex}"); }
        }
    }

    private async Task<bool> InitializeWebViewAsync()
    {
        string root = WebRoot;
        LogTime($"WebRoot={root}");

        string[] requiredFiles =
        {
            "index.html",
            "script.js",
            "app.js",
            "styles.css",
            "sw.js",
            @"assets\ridges.json",
            @"assets\morning\scene.jpg",
            @"assets\day\scene.jpg",
            @"assets\golden-hour\scene.jpg",
            @"assets\dusk\scene.jpg",
            @"assets\night\scene.jpg",
            @"assets\midnight\scene.jpg"
        };

        foreach (string file in requiredFiles)
        {
            string fullPath = Path.Combine(root, file);
            bool present = File.Exists(fullPath);
            LogTime($"required file: {file} present={present}");
            if (!present)
            {
                _startupAborted = true;
                ShowStartupError($"Could not find essential NIGHTDRIVE project file:\n\n{file}\n\nExpected at:\n{root}\n\nPlease ensure the published engine folder is beside the application.");
                return false;
            }
        }

        string userDataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "NightdriveHost");
        var options = new CoreWebView2EnvironmentOptions
        {
            AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required"
        };

        LogTime("WebView2 initialization: start");
        CoreWebView2Environment env;
        try
        {
            env = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: userDataDir,
                options: options);
            LogTime("WebView2 environment created");

            await WebView.EnsureCoreWebView2Async(env);
            LogTime("WebView2 control initialized");
            LogTime("WebView2 initialization: complete");
        }
        catch (Exception ex)
        {
            LogTime($"WebView2 initialization exception: {ex}");
            ShowStartupWarning("NIGHTDRIVE could not initialize WebView2. Install the WebView2 Runtime and try again.");
            return false;
        }

        try
        {
            try
            {
                await WebView.CoreWebView2.Profile.ClearBrowsingDataAsync(
                    CoreWebView2BrowsingDataKinds.CacheStorage |
                    CoreWebView2BrowsingDataKinds.DiskCache);
                LogTime("WebView2 cache cleared");
            }
            catch (Exception ex)
            {
                // Cache cleanup is not required for startup; do not lose the
                // page because an old WebView2 profile cannot be cleared.
                LogTime($"WebView2 cache clear exception: {ex}");
            }

            WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "nightdrive.local",
                root,
                CoreWebView2HostResourceAccessKind.Allow);
            LogTime("WebView2 virtual host mapped: https://nightdrive.local -> " + root);

#if !DEBUG
            WebView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            WebView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            WebView.CoreWebView2.Settings.IsZoomControlEnabled = false;
#endif

            // These subscriptions must be in place before Navigate. A local
            // virtual-host page can finish quickly enough to beat a late
            // DOMContentLoaded subscription.
            WebView.CoreWebView2.NavigationStarting += OnNavigationStarting;
            WebView.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
            WebView.CoreWebView2.DOMContentLoaded += OnDomContentLoaded;
            WebView.CoreWebView2.ProcessFailed += OnWebViewProcessFailed;
            WebView.CoreWebView2.WebMessageReceived += OnWebMessageReceivedForLog;
            LogTime("WebView2 event subscriptions installed before Navigate");

            _battery = new BatteryHelper(WebView) { OnLogTime = LogTime };
            _connectivity = new ConnectivityHelper(WebView) { OnLogTime = LogTime };
            _connectivity.OnHideFallback = HideFallback;
            _connectivity.OnDrawerOpen = HandleDrawerOpenFromPage;
            _connectivity.OnDrawerClosed = HandleDrawerClosedFromPage;

            string uri = $"https://nightdrive.local/index.html?v={DateTime.Now.Ticks}";
            LogTime($"navigation start requested: {uri}");
            WebView.CoreWebView2.Navigate(uri);
            LogTime("WebView2 Navigate returned");
            return true;
        }
        catch (Exception ex)
        {
            LogTime($"WebView2 setup/navigation exception: {ex}");
            ShowStartupWarning("NIGHTDRIVE could not load its engine. The fallback window will remain visible.");
            return false;
        }
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        try
        {
            bool allowed = Uri.TryCreate(e.Uri, UriKind.Absolute, out Uri? uri) &&
                           uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase) &&
                           uri.Host.Equals("nightdrive.local", StringComparison.OrdinalIgnoreCase);
            LogTime($"NavigationStarting: uri={e.Uri}, allowed={allowed}");
            if (!allowed) e.Cancel = true;
        }
        catch (Exception ex)
        {
            LogTime($"NavigationStarting handler exception: {ex}");
            e.Cancel = true;
        }
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        try
        {
            LogTime($"NavigationCompleted: IsSuccess={e.IsSuccess}, WebErrorStatus={e.WebErrorStatus}");
        }
        catch (Exception ex)
        {
            LogTime($"NavigationCompleted handler exception: {ex}");
        }
    }

    private void OnDomContentLoaded(object? sender, CoreWebView2DOMContentLoadedEventArgs e)
    {
        try
        {
            LogTime("DOMContentLoaded");
            _domReady = true;
            StartBridges();
            if (_drawerOpenPending)
            {
                // The hotkey can win the race with document script startup.
                // Re-send after DOMContentLoaded so the app-level native
                // listener cannot miss the request. Keep the pending bit until
                // the desktop has also been raised if the shell attach is late.
                PostDrawerMessage("drawer:open");
                if (_desktopAttached && _drawerRaised) _drawerOpenPending = false;
            }
        }
        catch (Exception ex)
        {
            LogTime($"DOMContentLoaded handler exception: {ex}");
        }
    }

    private void OnWebViewProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        try
        {
            LogTime($"WebView2 ProcessFailed: kind={e.ProcessFailedKind}");
        }
        catch (Exception ex)
        {
            LogTime($"ProcessFailed handler exception: {ex}");
        }
    }

    private void OnWebMessageReceivedForLog(
        object? sender,
        CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            LogTime($"WebView2 drawbridge event received: {e.WebMessageAsJson}");
        }
        catch (Exception ex)
        {
            LogTime($"WebMessageReceived log handler exception: {ex}");
        }
    }

    private void StartBridges()
    {
        try
        {
            if (_bridgesStarted) return;
            _bridgesStarted = true;
            LogTime("DOM ready: starting battery/connectivity bridges");
            _battery?.Start();
            _connectivity?.Start();
        }
        catch (Exception ex)
        {
            LogTime($"bridge start exception: {ex}");
        }
    }

    private void HideFallback()
    {
        try
        {
            Dispatcher.Invoke(() =>
            {
                try { FallbackImage.Visibility = Visibility.Hidden; }
                catch (Exception ex) { LogTime($"hide fallback UI exception: {ex}"); }
            });
            LogTime("fallback image hidden after first engine frame");
        }
        catch (Exception ex)
        {
            LogTime($"hide fallback handler exception: {ex}");
        }
    }

    private async Task AttachToDesktopAsync()
    {
        try
        {
            var helper = new WindowInteropHelper(this);
            IntPtr hwnd = helper.Handle;
            LogTime($"AttachToDesktop start: hwnd={Hex(hwnd)}");

            WallpaperHelper.FillVirtualScreen(hwnd);
            LogTime("fallback background stretched to virtual screen");

            bool attached = false;
            for (int attempt = 1; attempt <= 15; attempt++)
            {
                attached = WallpaperHelper.AttachToDesktop(hwnd);
                LogTime($"AttachToDesktop attempt {attempt}/15 result={attached}");
                if (attached)
                {
                    WallpaperHelper.FillVirtualScreen(hwnd);
                    _desktopAttached = true;
                    WallpaperHelper.LogWindowState(hwnd, "desktop attached");
                    LogTime("AttachToDesktop complete: WorkerW attachment active");

                    if (_drawerOpenPending && _domReady)
                    {
                        if (DesktopInteraction.Raise(hwnd))
                        {
                            _drawerRaised = true;
                            PostDrawerMessage("drawer:open");
                            _drawerOpenPending = false;
                            LogTime("pending drawer request replayed after desktop attach");
                        }
                    }
                    break;
                }

                if (attempt < 15) await Task.Delay(1000);
            }

            if (!attached)
            {
                LogTime("AttachToDesktop failed after 15 attempts; keeping standard window mode");
                ShowStartupWarning("NIGHTDRIVE could not attach to the desktop background after multiple attempts. It is running in a standard window.");
            }
        }
        catch (Exception ex)
        {
            LogTime($"AttachToDesktop exception: {ex}");
        }
    }

    private void OpenDrawerFromHost()
    {
        try
        {
            if (!Dispatcher.CheckAccess())
            {
                Dispatcher.BeginInvoke(new Action(OpenDrawerFromHost));
                return;
            }

            LogTime("drawer open requested by Ctrl+Alt+N or tray");
            _drawerOpenPending = true;
            var hwnd = new WindowInteropHelper(this).Handle;
            if (_desktopAttached && DesktopInteraction.Raise(hwnd))
            {
                _drawerRaised = true;
                _drawerOpenPending = false;
                LogTime("desktop raised for drawer input");
            }
            else
            {
                LogTime($"desktop raise skipped or failed: attached={_desktopAttached}");
            }
            PostDrawerMessage("drawer:open");
        }
        catch (Exception ex)
        {
            LogTime($"host drawer open exception: {ex}");
        }
    }

    private void HandleDrawerOpenFromPage()
    {
        try
        {
            LogTime("drawer:open received from page");
            var hwnd = new WindowInteropHelper(this).Handle;
            if (_desktopAttached && DesktopInteraction.Raise(hwnd))
            {
                _drawerRaised = true;
                LogTime("desktop raised for page drawer input");
            }
        }
        catch (Exception ex)
        {
            LogTime($"page drawer open handler exception: {ex}");
        }
    }

    private void HandleDrawerClosedFromPage()
    {
        try
        {
            LogTime("drawer:closed received from page");
            _drawerOpenPending = false;
            if (!_drawerRaised) return;
            var hwnd = new WindowInteropHelper(this).Handle;
            if (DesktopInteraction.Sink(hwnd))
            {
                _drawerRaised = false;
                LogTime("desktop sunk behind Explorer icons");
            }
        }
        catch (Exception ex)
        {
            LogTime($"page drawer close handler exception: {ex}");
        }
    }

    private void PostDrawerMessage(string action)
    {
        try
        {
            if (WebView.CoreWebView2 == null)
            {
                LogTime($"host-to-page message skipped: CoreWebView2 unavailable action={action}");
                return;
            }

            string json = JsonSerializer.Serialize(new { action });
            WebView.CoreWebView2.PostWebMessageAsJson(json);
            LogTime($"host-to-page message sent: {action}");
        }
        catch (Exception ex)
        {
            LogTime($"host-to-page message exception action={action}: {ex}");
        }
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        try
        {
            LogTime("Closed handler: begin");
            var hwnd = new WindowInteropHelper(this).Handle;
            if (_hotKeyRegistered)
            {
                DesktopInteraction.UnregisterHotKey(hwnd, DrawerHotKeyId);
                _hotKeyRegistered = false;
            }
            if (_drawerRaised) DesktopInteraction.Sink(hwnd);
            if (_hwndSource != null) _hwndSource.RemoveHook(WindowMessageHook);
            _battery?.Dispose();
            _connectivity?.Dispose();
            _tray?.Dispose();
            LogTime("Closed handler: complete");
        }
        catch (Exception ex)
        {
            LogTime($"Closed handler exception: {ex}");
        }
    }

    protected override void OnKeyDown(System.Windows.Input.KeyEventArgs e)
    {
        try
        {
            base.OnKeyDown(e);
            if (e.Key == System.Windows.Input.Key.Escape)
            {
                e.Handled = true;
                WpfApp.Current.Shutdown();
            }
        }
        catch (Exception ex)
        {
            LogTime($"key handler exception: {ex}");
        }
    }

    private void ShowStartupError(string message)
    {
        try
        {
            MessageBox.Show(message, "NIGHTDRIVE Error", MessageBoxButton.OK, MessageBoxImage.Error);
            WpfApp.Current.Shutdown();
        }
        catch (Exception ex)
        {
            LogTime($"startup error dialog exception: {ex}");
        }
    }

    private void ShowStartupWarning(string message)
    {
        try
        {
            MessageBox.Show(message, "NIGHTDRIVE Warning", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        catch (Exception ex)
        {
            LogTime($"startup warning dialog exception: {ex}");
        }
    }

    private void LogTime(string step)
    {
        try
        {
            long ms = Stopwatch.ElapsedMilliseconds;
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
            string logFile = string.IsNullOrWhiteSpace(desktop)
                ? Path.Combine(AppContext.BaseDirectory, "NIGHTDRIVE_STARTUP.log")
                : Path.Combine(desktop, "NIGHTDRIVE_STARTUP.log");
            File.AppendAllText(logFile, $"[T+{ms,6}ms] {step}{Environment.NewLine}");
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[NIGHTDRIVE] log failure: {ex}");
        }
    }

    private static string Hex(IntPtr value) => $"0x{value.ToInt64():X}";
}
