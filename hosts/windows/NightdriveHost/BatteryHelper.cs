using System;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Wpf;

namespace NightdriveHost;

/// <summary>
/// Reads the Windows battery state via System.Windows.Forms.PowerStatus
/// and forwards it to the WebView2 page as a JSON message every 30 seconds.
///
/// The JS page listens via:
///   window.chrome.webview.addEventListener('message', handler);
///
/// Message shape:
///   { "type": "battery", "percent": 78, "charging": false }
/// </summary>
public class BatteryHelper : IDisposable
{
    private readonly WebView2 _webView;
    private System.Windows.Threading.DispatcherTimer? _timer;

    public BatteryHelper(WebView2 webView)
    {
        _webView = webView;
    }

    public void Start()
    {
        // Send immediately on first call
        SendBatteryData();

        _timer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(30)
        };
        _timer.Tick += (_, _) => SendBatteryData();
        _timer.Start();
    }

    public void Stop() => _timer?.Stop();

    private void SendBatteryData()
    {
        try
        {
            if (_webView.CoreWebView2 == null) return;

            PowerStatus ps = SystemInformation.PowerStatus;

            // BatteryLifePercent returns 255 (0xFF) when status is unknown
            float rawPct = ps.BatteryLifePercent;
            if (rawPct < 0 || rawPct > 1)
            {
                // Unavailable
                SendJson(new { type = "battery", available = false });
                return;
            }

            bool charging = ps.PowerLineStatus == PowerLineStatus.Online;
            int percent   = (int)Math.Round(rawPct * 100);

            SendJson(new { type = "battery", available = true, percent, charging });
        }
        catch (Exception ex)
        {
            // Don't crash the host; just log
            System.Diagnostics.Debug.WriteLine($"[Battery] Error: {ex.Message}");
        }
    }

    private void SendJson(object payload)
    {
        try
        {
            string json = JsonSerializer.Serialize(payload);
            _webView.CoreWebView2.PostWebMessageAsJson(json);
        }
        catch { /* WebView2 may not be ready yet */ }
    }

    public void Dispose()
    {
        _timer?.Stop();
    }
}
