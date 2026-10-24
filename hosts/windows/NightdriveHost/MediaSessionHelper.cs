using System;
using System.Globalization;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Wpf;
using Windows.Media.Control;

namespace NightdriveHost;

/// <summary>
/// Bridges real Windows Global System Media Transport Controls (SMTC) sessions
/// into the NIGHTDRIVE wallpaper Music Bar and drawer player.
/// Reports truthful idle/unavailable state whenever no active session exists.
/// </summary>
public sealed class MediaSessionHelper : IDisposable
{
    private readonly WebView2 _webView;
    private DispatcherTimer? _pollTimer;
    private GlobalSystemMediaTransportControlsSessionManager? _manager;
    private GlobalSystemMediaTransportControlsSession? _currentSession;
    private bool _disposed;
    private bool _supported = true;

    public Action<string>? OnLogTime { get; set; }

    public MediaSessionHelper(WebView2 webView)
    {
        _webView = webView;
    }

    public void Start()
    {
        if (_disposed || _pollTimer != null) return;

        _pollTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1.5) };
        _pollTimer.Tick += OnPollTimerTick;
        _pollTimer.Start();

        _ = InitializeManagerAsync();
    }

    public void Stop()
    {
        try { _pollTimer?.Stop(); }
        catch (Exception ex) { Log($"poll stop exception: {ex}"); }
    }

    private async Task InitializeManagerAsync()
    {
        try
        {
            _manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
            if (_disposed || _manager == null)
            {
                _supported = false;
                await PublishSnapshotAsync();
                return;
            }

            _manager.CurrentSessionChanged += OnCurrentSessionChanged;
            RebindCurrentSession();
            Log("SMTC session manager initialized");
            await PublishSnapshotAsync();
        }
        catch (Exception ex)
        {
            _supported = false;
            Log($"SMTC initialization unavailable: {ex.Message}");
            await PublishSnapshotAsync();
        }
    }

    private void OnCurrentSessionChanged(
        GlobalSystemMediaTransportControlsSessionManager sender,
        CurrentSessionChangedEventArgs args)
    {
        try
        {
            RebindCurrentSession();
            _ = PublishSnapshotAsync();
        }
        catch (Exception ex)
        {
            Log($"CurrentSessionChanged exception: {ex.Message}");
        }
    }

    private void RebindCurrentSession()
    {
        DetachSessionHandlers();
        if (_manager == null) return;

        try
        {
            _currentSession = _manager.GetCurrentSession();
            if (_currentSession != null)
            {
                _currentSession.MediaPropertiesChanged += OnSessionMediaChanged;
                _currentSession.PlaybackInfoChanged += OnSessionPlaybackChanged;
                _currentSession.TimelinePropertiesChanged += OnSessionTimelineChanged;
            }
        }
        catch (Exception ex)
        {
            _currentSession = null;
            Log($"GetCurrentSession exception: {ex.Message}");
        }
    }

    private void DetachSessionHandlers()
    {
        if (_currentSession == null) return;
        try
        {
            _currentSession.MediaPropertiesChanged -= OnSessionMediaChanged;
            _currentSession.PlaybackInfoChanged -= OnSessionPlaybackChanged;
            _currentSession.TimelinePropertiesChanged -= OnSessionTimelineChanged;
        }
        catch { /* session may already be closed */ }
        _currentSession = null;
    }

    private void OnSessionMediaChanged(
        GlobalSystemMediaTransportControlsSession sender,
        MediaPropertiesChangedEventArgs args)
    {
        _ = PublishSnapshotAsync();
    }

    private void OnSessionPlaybackChanged(
        GlobalSystemMediaTransportControlsSession sender,
        PlaybackInfoChangedEventArgs args)
    {
        _ = PublishSnapshotAsync();
    }

    private void OnSessionTimelineChanged(
        GlobalSystemMediaTransportControlsSession sender,
        TimelinePropertiesChangedEventArgs args)
    {
        _ = PublishSnapshotAsync();
    }

    private void OnPollTimerTick(object? sender, EventArgs e)
    {
        _ = PublishSnapshotAsync();
    }

    public async Task TogglePlayPauseAsync()
    {
        var session = GetActiveSession();
        if (session == null) { await PublishSnapshotAsync(); return; }
        try
        {
            await session.TryTogglePlayPauseAsync();
            await PublishSnapshotAsync();
        }
        catch (Exception ex) { Log($"TogglePlayPause exception: {ex.Message}"); }
    }

    public async Task PlayAsync()
    {
        var session = GetActiveSession();
        if (session == null) { await PublishSnapshotAsync(); return; }
        try
        {
            await session.TryPlayAsync();
            await PublishSnapshotAsync();
        }
        catch (Exception ex) { Log($"Play exception: {ex.Message}"); }
    }

    public async Task PauseAsync()
    {
        var session = GetActiveSession();
        if (session == null) { await PublishSnapshotAsync(); return; }
        try
        {
            await session.TryPauseAsync();
            await PublishSnapshotAsync();
        }
        catch (Exception ex) { Log($"Pause exception: {ex.Message}"); }
    }

    public async Task SkipNextAsync()
    {
        var session = GetActiveSession();
        if (session == null) { await PublishSnapshotAsync(); return; }
        try
        {
            await session.TrySkipNextAsync();
            await Task.Delay(120);
            await PublishSnapshotAsync();
        }
        catch (Exception ex) { Log($"SkipNext exception: {ex.Message}"); }
    }

    public async Task SkipPreviousAsync()
    {
        var session = GetActiveSession();
        if (session == null) { await PublishSnapshotAsync(); return; }
        try
        {
            await session.TrySkipPreviousAsync();
            await Task.Delay(120);
            await PublishSnapshotAsync();
        }
        catch (Exception ex) { Log($"SkipPrevious exception: {ex.Message}"); }
    }

    public async Task SeekSecondsAsync(string rawSeconds)
    {
        var session = GetActiveSession();
        if (session == null) { await PublishSnapshotAsync(); return; }
        if (!double.TryParse(rawSeconds, NumberStyles.Float, CultureInfo.InvariantCulture, out double seconds) ||
            double.IsNaN(seconds) || double.IsInfinity(seconds) || seconds < 0)
        {
            return;
        }
        try
        {
            long ticks = TimeSpan.FromSeconds(seconds).Ticks;
            await session.TryChangePlaybackPositionAsync(ticks);
            await PublishSnapshotAsync();
        }
        catch (Exception ex) { Log($"Seek exception: {ex.Message}"); }
    }

    private GlobalSystemMediaTransportControlsSession? GetActiveSession()
    {
        if (_manager == null) return null;
        try
        {
            var latest = _manager.GetCurrentSession();
            if (!ReferenceEquals(latest, _currentSession))
                RebindCurrentSession();
            return _currentSession;
        }
        catch
        {
            return null;
        }
    }

    public async Task PublishSnapshotAsync()
    {
        if (_disposed) return;

        try
        {
            var session = GetActiveSession();
            if (session == null)
            {
                PostPayload(new
                {
                    type = "media",
                    supported = _supported,
                    connected = false,
                    playing = false,
                    status = _supported ? "idle" : "unsupported",
                    title = "",
                    artist = "",
                    album = "",
                    sourceApp = "",
                    positionSec = 0.0,
                    durationSec = 0.0,
                    canPlayPause = false,
                    canNext = false,
                    canPrev = false,
                    canSeek = false
                });
                return;
            }

            string title = "";
            string artist = "";
            string album = "";
            try
            {
                var props = await session.TryGetMediaPropertiesAsync();
                if (props != null)
                {
                    title = props.Title ?? "";
                    artist = props.Artist ?? "";
                    album = props.AlbumTitle ?? "";
                }
            }
            catch { /* transient COM/WinRT read error during track switch */ }

            var playback = session.GetPlaybackInfo();
            var statusEnum = playback?.PlaybackStatus ?? GlobalSystemMediaTransportControlsSessionPlaybackStatus.Closed;
            bool isPlaying = statusEnum == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
            string statusText = statusEnum.ToString().ToLowerInvariant();
            var controls = playback?.Controls;

            double posSec = 0.0;
            double durSec = 0.0;
            try
            {
                var tl = session.GetTimelineProperties();
                if (tl != null)
                {
                    durSec = Math.Max(0.0, (tl.EndTime - tl.StartTime).TotalSeconds);
                    posSec = Math.Max(0.0, (tl.Position - tl.StartTime).TotalSeconds);
                    if (isPlaying && tl.LastUpdatedTime != default)
                    {
                        double elapsed = (DateTimeOffset.UtcNow - tl.LastUpdatedTime).TotalSeconds;
                        if (elapsed > 0 && elapsed < 3600)
                            posSec += elapsed;
                    }
                    if (durSec > 0 && posSec > durSec) posSec = durSec;
                }
            }
            catch { /* timeline optional on some sources */ }

            string appId = session.SourceAppUserModelId ?? "";
            PostPayload(new
            {
                type = "media",
                supported = true,
                connected = true,
                playing = isPlaying,
                status = statusText,
                title,
                artist,
                album,
                sourceApp = appId,
                positionSec = Math.Round(posSec, 2),
                durationSec = Math.Round(durSec, 2),
                canPlayPause = controls == null || controls.IsPlayPauseToggleEnabled || controls.IsPlayEnabled || controls.IsPauseEnabled,
                canNext = controls != null && controls.IsNextEnabled,
                canPrev = controls != null && controls.IsPreviousEnabled,
                canSeek = controls != null && controls.IsPlaybackPositionEnabled && durSec > 0
            });
        }
        catch (Exception ex)
        {
            Log($"PublishSnapshot exception: {ex.Message}");
        }
    }

    private void PostPayload(object payload)
    {
        if (_disposed) return;
        try
        {
            string json = JsonSerializer.Serialize(payload);
            _webView.Dispatcher.BeginInvoke(new Action(() =>
            {
                try
                {
                    if (!_disposed && _webView.CoreWebView2 != null)
                        _webView.CoreWebView2.PostWebMessageAsJson(json);
                }
                catch (Exception ex)
                {
                    Log($"PostWebMessageAsJson exception: {ex.Message}");
                }
            }));
        }
        catch (Exception ex)
        {
            Log($"PostPayload serialize exception: {ex.Message}");
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try
        {
            Stop();
            if (_pollTimer != null)
            {
                _pollTimer.Tick -= OnPollTimerTick;
                _pollTimer = null;
            }
            DetachSessionHandlers();
            if (_manager != null)
            {
                _manager.CurrentSessionChanged -= OnCurrentSessionChanged;
                _manager = null;
            }
        }
        catch (Exception ex)
        {
            Log($"Dispose exception: {ex.Message}");
        }
    }

    private void Log(string message)
    {
        try { OnLogTime?.Invoke("[Media] " + message); }
        catch { /* never throw from logging */ }
    }
}
