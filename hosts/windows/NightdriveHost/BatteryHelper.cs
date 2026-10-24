using System;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Wpf;

namespace NightdriveHost;

/// <summary>
/// Reads the Windows battery state via PowerStatus and forwards it to the
/// WebView2 page. All timer and bridge handlers are guarded so a transient
/// WebView2 shutdown cannot take down the wallpaper host.
/// </summary>
public class BatteryHelper : IDisposable
{
    private readonly WebView2 _webView;
    private System.Windows.Threading.DispatcherTimer? _timer;

    public Action<string>? OnLogTime { get; set; }

    public BatteryHelper(WebView2 webView)
    {
        _webView = webView;
    }

    public void Start()
    {
        try
        {
            if (_timer != null) return;

            SendBatteryData();
            _timer = new System.Windows.Threading.DispatcherTimer
            {
                Interval = TimeSpan.FromSeconds(30)
            };
            _timer.Tick += OnTimerTick;
            _timer.Start();
            Log("battery bridge started");
        }
        catch (Exception ex)
        {
            Log($"battery bridge start exception: {ex}");
        }
    }

    private void OnTimerTick(object? sender, EventArgs e)
    {
        try { SendBatteryData(); }
        catch (Exception ex) { Log($"battery timer exception: {ex}"); }
    }

    public void Stop()
    {
        try { _timer?.Stop(); }
        catch (Exception ex) { Log($"battery timer stop exception: {ex}"); }
    }

    private void SendBatteryData()
    {
        try
        {
            if (_webView.CoreWebView2 == null)
            {
                Log("battery bridge skipped: CoreWebView2 is not ready");
                return;
            }

            PowerStatus ps = SystemInformation.PowerStatus;
            float rawPct = ps.BatteryLifePercent;
            if (rawPct < 0 || rawPct > 1)
            {
                SendJson(new { type = "battery", available = false });
                return;
            }

            bool charging = ps.PowerLineStatus == PowerLineStatus.Online;
            int percent = (int)Math.Round(rawPct * 100);
            SendJson(new { type = "battery", available = true, percent, charging });
        }
        catch (Exception ex)
        {
            Log($"battery read exception: {ex}");
        }
    }

    private void SendJson(object payload)
    {
        try
        {
            if (_webView.CoreWebView2 == null) return;
            string json = JsonSerializer.Serialize(payload);
            _webView.CoreWebView2.PostWebMessageAsJson(json);
        }
        catch (Exception ex)
        {
            Log($"battery bridge message exception: {ex}");
        }
    }

    public void Dispose()
    {
        try
        {
            Stop();
            _timer = null;
        }
        catch (Exception ex)
        {
            Log($"battery dispose exception: {ex}");
        }
    }

    private void Log(string message)
    {
        try { OnLogTime?.Invoke("[Battery] " + message); }
        catch { /* logging must never take down the host */ }
    }
}
