using System.Threading;
using System.Windows;
using WpfApp = System.Windows.Application;

namespace NightdriveHost;

public partial class App : WpfApp
{
    private static Mutex? _mutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        const string appName = "Nightdrive_Wallpaper_Mutex";
        
        _mutex = new Mutex(true, appName, out bool createdNew);

        if (!createdNew)
        {
            // Another instance is already running
            Current.Shutdown();
            return;
        }

        base.OnStartup(e);
    }
}
