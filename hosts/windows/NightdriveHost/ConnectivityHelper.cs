using System;
using System.Diagnostics;
using System.Globalization;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Wpf;
using Windows.Devices.Radios;

namespace NightdriveHost;

/// <summary>
/// Reads system connectivity/audio state and handles the small, explicit
/// message bridge exposed to the wallpaper page. No arbitrary command or path
/// from the page reaches Process.Start.
/// </summary>
public class ConnectivityHelper : IDisposable
{
    private readonly WebView2 _webView;
    private DispatcherTimer? _timer;
    private bool? _bluetoothState;

    // CoreAudio COM interfaces.
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

    public Action? OnHideFallback { get; set; }
    public Action? OnDrawerOpen { get; set; }
    public Action? OnDrawerClosed { get; set; }
    public Action<string>? OnLogTime { get; set; }

    public ConnectivityHelper(WebView2 webView)
    {
        _webView = webView;
        try
        {
            if (_webView.CoreWebView2 != null)
                _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
            else
                _webView.WebMessageReceived += OnWebMessageReceived;

            _ = CheckBluetoothSupportAsync();
        }
        catch (Exception ex)
        {
            Log($"connectivity constructor exception: {ex}");
        }
    }

    private async System.Threading.Tasks.Task CheckBluetoothSupportAsync()
    {
        try
        {
            var radios = await Radio.GetRadiosAsync();
            foreach (var radio in radios)
            {
                if (radio.Kind == RadioKind.Bluetooth)
                {
                    _bluetoothState = radio.State == RadioState.On;
                    Log($"Bluetooth radio state={_bluetoothState}");
                    return;
                }
            }

            _bluetoothState = false;
            Log("Bluetooth radio not found");
        }
        catch (Exception ex)
        {
            // A host without the Windows radio API should report n/a, not a
            // guessed state, in the drawer.
            _bluetoothState = null;
            Log($"Bluetooth probe exception: {ex}");
        }
    }

    public void Start()
    {
        try
        {
            if (_timer != null) return;

            SendConnectivityData();
            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
            _timer.Tick += OnTimerTick;
            _timer.Start();
            Log("connectivity bridge started");
        }
        catch (Exception ex)
        {
            Log($"connectivity bridge start exception: {ex}");
        }
    }

    private void OnTimerTick(object? sender, EventArgs e)
    {
        try { SendConnectivityData(); }
        catch (Exception ex) { Log($"connectivity timer exception: {ex}"); }
    }

    public void Stop()
    {
        try { _timer?.Stop(); }
        catch (Exception ex) { Log($"connectivity timer stop exception: {ex}"); }
    }

    private void SendConnectivityData()
    {
        try
        {
            if (_webView.CoreWebView2 == null)
            {
                Log("connectivity bridge skipped: CoreWebView2 is not ready");
                return;
            }

            bool isNetworkAvailable = NetworkInterface.GetIsNetworkAvailable();
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
                // This is deliberately named network reachability in the page;
                // it is not a claim about the Wi-Fi radio.
                wifi = isNetworkAvailable,
                bt = _bluetoothState,
                audio = audioPct,
                muted = isMuted
            };

            string json = JsonSerializer.Serialize(payload);
            _webView.CoreWebView2.PostWebMessageAsJson(json);
        }
        catch (Exception ex)
        {
            Log($"connectivity read/send exception: {ex}");
        }
    }

    private void OnWebMessageReceived(
        object? sender,
        Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            string raw = ReadWebMessage(e);
            string? action = ExtractAction(raw);
            Log($"drawbridge message: action={action ?? "<unparsed>"}, raw={raw}");
            if (string.IsNullOrEmpty(action)) return;

            if (action == "hello")
            {
                SendHostReady();
            }
            else if (action == "open_wifi_settings")
            {
                Launch("explorer.exe", "ms-availablenetworks:");
            }
            else if (action == "open_bt_settings")
            {
                Launch("ms-settings:bluetooth", null);
            }
            else if (action == "open_sound_settings")
            {
                Launch("sndvol.exe", "-f");
            }
            else if (action == "open_focus_settings")
            {
                Launch("ms-settings:quietmomentshome", null);
            }
            else if (action == "hide_fallback")
            {
                OnHideFallback?.Invoke();
            }
            else if (action.StartsWith("log_time:", StringComparison.Ordinal))
            {
                OnLogTime?.Invoke(action.Substring("log_time:".Length));
            }
            else if (action == "drawer:open")
            {
                OnDrawerOpen?.Invoke();
            }
            else if (action == "drawer:closed")
            {
                OnDrawerClosed?.Invoke();
            }
            else if (action.StartsWith("set_volume:", StringComparison.Ordinal))
            {
                HandleSetVolume(action.Substring("set_volume:".Length));
            }
            else if (action.StartsWith("set_mute:", StringComparison.Ordinal))
            {
                HandleSetMute(action.Substring("set_mute:".Length));
            }
            else if (action == "toggle_mute")
            {
                ToggleMute();
            }
            else if (action == "quit")
            {
                System.Windows.Application.Current?.Dispatcher.Invoke(() =>
                {
                    try { System.Windows.Application.Current?.Shutdown(); }
                    catch (Exception ex) { Log($"quit handler exception: {ex}"); }
                });
            }
        }
        catch (Exception ex)
        {
            Log($"drawbridge handler exception: {ex}");
        }
    }

    private void HandleSetVolume(string raw)
    {
        try
        {
            if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int requested))
            {
                Log($"set_volume rejected: raw={raw}");
                return;
            }

            int volume = Math.Clamp(requested, 0, 100);
            var aev = GetAudioEndpointVolume();
            if (aev == null)
            {
                Log("set_volume skipped: audio endpoint unavailable");
                return;
            }

            aev.SetMasterVolumeLevelScalar(volume / 100f, Guid.Empty);
            Log($"set_volume applied: requested={requested}, clamped={volume}");
            SendConnectivityData();
        }
        catch (Exception ex)
        {
            Log($"set_volume exception: {ex}");
        }
    }

    private void HandleSetMute(string raw)
    {
        try
        {
            bool? muted = raw switch
            {
                "1" or "true" => true,
                "0" or "false" => false,
                _ => null
            };
            if (!muted.HasValue)
            {
                Log($"set_mute rejected: raw={raw}");
                return;
            }

            var aev = GetAudioEndpointVolume();
            if (aev == null)
            {
                Log("set_mute skipped: audio endpoint unavailable");
                return;
            }

            aev.SetMute(muted.Value, Guid.Empty);
            Log($"set_mute applied: muted={muted.Value}");
            SendConnectivityData();
        }
        catch (Exception ex)
        {
            Log($"set_mute exception: {ex}");
        }
    }

    private void ToggleMute()
    {
        try
        {
            var aev = GetAudioEndpointVolume();
            if (aev == null)
            {
                Log("toggle_mute skipped: audio endpoint unavailable");
                return;
            }

            aev.GetMute(out bool isMuted);
            aev.SetMute(!isMuted, Guid.Empty);
            Log($"toggle_mute applied: muted={!isMuted}");
            SendConnectivityData();
        }
        catch (Exception ex)
        {
            Log($"toggle_mute exception: {ex}");
        }
    }

    private void SendHostReady()
    {
        try
        {
            if (_webView.CoreWebView2 == null) return;
            string json = JsonSerializer.Serialize(new { type = "host", active = true });
            _webView.CoreWebView2.PostWebMessageAsJson(json);
            Log("host hello acknowledged");
        }
        catch (Exception ex)
        {
            Log($"host hello response exception: {ex}");
        }
    }

    private static string ReadWebMessage(
        Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            return e.TryGetWebMessageAsString();
        }
        catch
        {
            return e.WebMessageAsJson;
        }
    }

    private static string? ExtractAction(string raw)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(raw);
            return ExtractAction(document.RootElement);
        }
        catch
        {
            return null;
        }
    }

    private static string? ExtractAction(JsonElement root)
    {
        if (root.ValueKind == JsonValueKind.String)
        {
            string? nested = root.GetString();
            return string.IsNullOrEmpty(nested) ? null : ExtractAction(nested);
        }

        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("action", out JsonElement action))
            return action.ValueKind == JsonValueKind.String ? action.GetString() : null;

        return null;
    }

    private static void Launch(string fileName, string? arguments)
    {
        Process.Start(new ProcessStartInfo(fileName, arguments ?? string.Empty)
        {
            UseShellExecute = true
        });
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
        try
        {
            Stop();
            if (_webView.CoreWebView2 != null)
                _webView.CoreWebView2.WebMessageReceived -= OnWebMessageReceived;
            else
                _webView.WebMessageReceived -= OnWebMessageReceived;
            _timer = null;
        }
        catch (Exception ex)
        {
            Log($"connectivity dispose exception: {ex}");
        }
    }

    private void Log(string message)
    {
        try { OnLogTime?.Invoke("[Connectivity] " + message); }
        catch { /* logging must never take down the host */ }
    }
}
