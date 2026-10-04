using System;
using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Wpf;
using Windows.Devices.Radios;

namespace NightdriveHost;

/// <summary>
/// Reads system connectivity state (Wi-Fi, Bluetooth, Audio) and handles UI messages.
/// </summary>
public class ConnectivityHelper : IDisposable
{
    private readonly WebView2 _webView;
    private DispatcherTimer? _timer;

    // CoreAudio COM Interfaces
    [ComImport]
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4();
        int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
        int NotImpl6();
        int GetMasterVolumeLevelScalar(out float pfLevel);
        int NotImpl8(); int NotImpl9();
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
        int GetMute(out bool pbMute);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid id, int clsCtx, IntPtr activationParams, out IAudioEndpointVolume aev);
    }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr ppDevices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
    }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorComObject { }

    private bool _hasBluetooth = true; // Default assumption until proven otherwise
    public Action? OnHideFallback { get; set; }
    public Action<string>? OnLogTime { get; set; }

    public ConnectivityHelper(WebView2 webView)
    {
        _webView = webView;
        if (_webView.CoreWebView2 != null) {
            _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        } else {
            _webView.WebMessageReceived += OnWebMessageReceived;
        }
        
        CheckBluetoothSupportAsync();
    }

    private async void CheckBluetoothSupportAsync()
    {
        try
        {
            var radios = await Radio.GetRadiosAsync();
            foreach (var radio in radios)
            {
                if (radio.Kind == RadioKind.Bluetooth)
                {
                    _hasBluetooth = radio.State == RadioState.On;
                    return;
                }
            }
            _hasBluetooth = false; // No bluetooth radio found
        }
        catch
        {
            // Ignore if OS does not support
        }
    }

    public void Start()
    {
        SendConnectivityData();

        _timer = new DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(2) // Check more frequently for volume changes
        };
        _timer.Tick += (_, _) => SendConnectivityData();
        _timer.Start();
    }

    public void Stop() => _timer?.Stop();

    private void SendConnectivityData()
    {
        try
        {
            if (_webView.CoreWebView2 == null) return;

            bool isNetworkAvailable = NetworkInterface.GetIsNetworkAvailable();
            
            // Audio Volume Polling
            int? audioPct = null;
            bool isMuted = false;
            var aev = GetAudioEndpointVolume();
            if (aev != null)
            {
                aev.GetMasterVolumeLevelScalar(out float level);
                aev.GetMute(out isMuted);
                audioPct = (int)Math.Round(level * 100);
            }

            var payload = new
            {
                type = "connectivity",
                wifi = isNetworkAvailable,
                bt = _hasBluetooth,
                audio = audioPct,
                muted = isMuted
            };

            string json = System.Text.Json.JsonSerializer.Serialize(payload);
            _webView.CoreWebView2.PostWebMessageAsJson(json);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[ConnectivityHelper] Error: {ex.Message}");
        }
    }

    private void OnWebMessageReceived(object? sender, Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            string msg = e.WebMessageAsJson;
            if (msg.Contains("open_wifi_settings"))
            {
                // explorer.exe ms-availablenetworks: reliably opens the Windows 10 Wi-Fi network taskbar flyout
                Process.Start(new ProcessStartInfo("explorer.exe", "ms-availablenetworks:") { UseShellExecute = true });
            }
            else if (msg.Contains("open_bt_settings"))
            {
                Process.Start(new ProcessStartInfo("ms-settings:bluetooth") { UseShellExecute = true });
            }
            else if (msg.Contains("open_sound_settings"))
            {
                // sndvol.exe -f reliably opens the Windows 10 master volume taskbar flyout
                Process.Start(new ProcessStartInfo("sndvol.exe", "-f") { UseShellExecute = true });
            }
            else if (msg.Contains("open_focus_settings"))
            {
                Process.Start(new ProcessStartInfo("ms-settings:quietmomentshome") { UseShellExecute = true });
            }
            else if (msg.Contains("hide_fallback"))
            {
                OnHideFallback?.Invoke();
            }
            else if (msg.Contains("log_time:"))
            {
                // parse action: "log_time:..."
                try
                {
                    var data = System.Text.Json.JsonDocument.Parse(msg);
                    if (data.RootElement.TryGetProperty("action", out var actionElem))
                    {
                        string actionStr = actionElem.GetString() ?? "";
                        if (actionStr.StartsWith("log_time:"))
                        {
                            OnLogTime?.Invoke(actionStr.Substring(9));
                        }
                    }
                }
                catch { }
            }
            else if (msg.Contains("toggle_mute"))
            {
                var aev = GetAudioEndpointVolume();
                if (aev != null)
                {
                    aev.GetMute(out bool isMuted);
                    aev.SetMute(!isMuted, Guid.Empty);
                    SendConnectivityData(); // Update immediately
                }
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[ConnectivityHelper] Message Error: {ex.Message}");
        }
    }

    private IAudioEndpointVolume? GetAudioEndpointVolume()
    {
        try
        {
            var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
            if (enumerator == null) return null;

            enumerator.GetDefaultAudioEndpoint(0, 1, out IMMDevice dev);
            if (dev == null) return null;

            Guid iid = typeof(IAudioEndpointVolume).GUID;
            dev.Activate(ref iid, 1, IntPtr.Zero, out IAudioEndpointVolume aev);
            return aev;
        }
        catch
        {
            return null;
        }
    }

    public void Dispose()
    {
        Stop();
        if (_webView != null)
        {
            if (_webView.CoreWebView2 != null) {
                _webView.CoreWebView2.WebMessageReceived -= OnWebMessageReceived;
            } else {
                _webView.WebMessageReceived -= OnWebMessageReceived;
            }
        }
        _timer = null;
    }
}
