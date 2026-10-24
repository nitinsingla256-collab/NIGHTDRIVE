/**
 * NIGHTDRIVE — Shared Wallpaper Engine (v3.0)
 * Zero external runtime dependencies. Runs identically in Windows WebView2
 * (NightdriveHost), macOS WKWebView, Linux Qt WebEngine, Tauri, and browsers.
 */

function logToHost(step) {
  const msg = JSON.stringify({ action: 'log_time:' + step });
  if (typeof PLATFORM === 'undefined') return;
  if (PLATFORM.webview2) {
    window.chrome.webview.postMessage(msg);
  } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.nightdrive) {
    window.webkit.messageHandlers.nightdrive.postMessage(msg);
  }
}

window.addEventListener('error', function (e) {
  console.error('[NIGHTDRIVE]', e.message, e.filename + ':' + e.lineno);
  logToHost('error: ' + e.message);
});

/* ══════════════════════════════════════════════════════════════════════════
   1. PLATFORM DETECTION & NATIVE HOST BRIDGE
   ══════════════════════════════════════════════════════════════════════════ */

const PLATFORM = (function () {
  const ua = navigator.userAgent || '';
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (p === 'MacIntel' && navigator.maxTouchPoints > 1);
  return {
    windows: /Win/i.test(p) || /Windows/i.test(ua),
    mac: !isIOS && /Mac/i.test(p),
    ios: isIOS,
    android: /Android/i.test(ua),
    linux: /Linux/i.test(p) && !/Android/i.test(ua),
    tauri: !!window.__TAURI__,
    webview2: !!(window.chrome && window.chrome.webview) && !window.__TAURI__,
    wkhost: !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.nightdrive),
    touch: ('ontouchstart' in window) || navigator.maxTouchPoints > 0
  };
})();

logToHost('5. HTML engine loading (script.js executing)');
document.documentElement.classList.toggle('is-touch', PLATFORM.touch);

const REDUCED_MOTION = window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: false };

let nativeHostActive = false;
window.__nightdriveDrawerOpen = false;

if (PLATFORM.webview2) {
  window.chrome.webview.addEventListener('message', function (event) {
    try {
      nativeHostActive = true;
      let data = event.data;
      if (typeof data === 'string') data = JSON.parse(data);
      if (typeof data === 'string') data = JSON.parse(data);
      if (data && data.action === 'drawer:open') {
        window.__nightdriveDrawerOpen = true;
        if (typeof window.Event === 'function') window.dispatchEvent(new Event('nightdrive-drawer-open'));
      } else if (data && data.action === 'drawer:close') {
        if (typeof window.Event === 'function') window.dispatchEvent(new Event('nightdrive-drawer-close'));
      }
    } catch (e) {
      nativeHostActive = true;
    }
  });
}

function postToHost(action) {
  const msg = JSON.stringify({ action: action });
  if (PLATFORM.webview2) { window.chrome.webview.postMessage(msg); return nativeHostActive; }
  if (PLATFORM.wkhost) { window.webkit.messageHandlers.nightdrive.postMessage(msg); return true; }
  return false;
}

const SETTINGS_URLS = {
  windows: {
    wifi: 'ms-settings:network-wifi',
    network: 'ms-settings:network',
    bt: 'ms-settings:bluetooth',
    sound: 'ms-settings:sound',
    focus: 'ms-settings:quiethours',
    display: 'ms-settings:display'
  },
  mac: {
    wifi: 'x-apple.systempreferences:com.apple.preference.network',
    network: 'x-apple.systempreferences:com.apple.preference.network',
    bt: 'x-apple.systempreferences:com.apple.preferences.Bluetooth',
    sound: 'x-apple.systempreferences:com.apple.preference.sound',
    focus: 'x-apple.systempreferences:com.apple.preference.notifications',
    display: 'x-apple.systempreferences:com.apple.preference.displays'
  }
};

function openSystemSettings(kind) {
  if (postToHost('open_' + kind + '_settings')) return true;
  const table = PLATFORM.windows ? SETTINGS_URLS.windows : (PLATFORM.mac ? SETTINGS_URLS.mac : null);
  if (PLATFORM.tauri && table && table[kind] && window.__TAURI__.shell) {
    window.__TAURI__.shell.open(table[kind]).catch(function () {});
    return true;
  }
  if (PLATFORM.windows && SETTINGS_URLS.windows[kind]) {
    const a = document.createElement('a');
    a.href = SETTINGS_URLS.windows[kind];
    a.rel = 'noopener';
    a.click();
    return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════════════════
   2. PERIOD DEFINITIONS & DEFAULT ASSET TABLE
   ══════════════════════════════════════════════════════════════════════════ */

const PERIODS = [
  {
    id: 'morning',
    label: 'Morning',
    defaultStart: 5 * 60,
    start: 5 * 60,
    end: 9 * 60,
    transitionMins: 20,
    headlights: false,
    hlFade: false,
    accent: '#98c1e8',
    accentDim: '#466a88',
    ctColor: 'rgba(150,190,235,0.00)'
  },
  {
    id: 'day',
    label: 'Day',
    defaultStart: 9 * 60,
    start: 9 * 60,
    end: 16 * 60,
    transitionMins: 20,
    headlights: false,
    hlFade: false,
    accent: '#8cb8ec',
    accentDim: '#436385',
    ctColor: 'rgba(255,252,244,0.00)'
  },
  {
    id: 'goldenHour',
    label: 'Golden Hour',
    defaultStart: 16 * 60,
    start: 16 * 60,
    end: 18 * 60 + 30,
    transitionMins: 20,
    headlights: false,
    hlFade: false,
    accent: '#e8a44c',
    accentDim: '#8a521b',
    ctColor: 'rgba(214,160,92,0.07)'
  },
  {
    id: 'dusk',
    label: 'Dusk',
    defaultStart: 18 * 60 + 30,
    start: 18 * 60 + 30,
    end: 20 * 60,
    transitionMins: 20,
    headlights: true,
    hlFade: true,
    accent: '#7da9ff',
    accentDim: '#3f5d9c',
    ctColor: 'rgba(92,108,162,0.08)'
  },
  {
    id: 'night',
    label: 'Night',
    defaultStart: 20 * 60,
    start: 20 * 60,
    end: 24 * 60,
    transitionMins: 20,
    headlights: true,
    hlFade: false,
    accent: '#7da9ff',
    accentDim: '#3b5894',
    ctColor: 'rgba(64,96,154,0.08)'
  },
  {
    id: 'midnight',
    label: 'Midnight',
    defaultStart: 0,
    start: 0,
    end: 5 * 60,
    transitionMins: 20,
    headlights: true,
    hlFade: false,
    accent: '#6889cc',
    accentDim: '#324875',
    ctColor: 'rgba(38,58,104,0.10)'
  }
];

const SCENE_ASSETS = {
  morning: {
    landscape: ['assets/morning/scene.jpg', 'assets/morning/scene.png', 'assets/morning/scene.svg'],
    portrait: ['assets/morning/scene-portrait.jpg', 'assets/morning/scene-portrait.webp'],
    cursor: ['assets/morning/car.png', 'assets/morning/car.webp'],
    focus: ['62%', '74%'],
    headlights: ['assets/morning/headlights.svg']
  },
  day: {
    landscape: ['assets/day/scene.jpg', 'assets/day/scene.png', 'assets/day/scene.svg'],
    portrait: ['assets/day/scene-portrait.jpg', 'assets/day/scene-portrait.webp'],
    cursor: ['assets/day/car.png', 'assets/day/car.webp'],
    focus: ['62%', '74%'],
    headlights: ['assets/day/headlights.svg']
  },
  goldenHour: {
    landscape: ['assets/golden-hour/scene.jpg', 'assets/golden-hour/scene.png', 'assets/golden-hour/scene.svg'],
    portrait: ['assets/golden-hour/scene-portrait.jpg', 'assets/golden-hour/scene-portrait.webp'],
    cursor: ['assets/golden-hour/car.png', 'assets/golden-hour/car.webp'],
    focus: ['62%', '74%'],
    headlights: ['assets/golden-hour/headlights.svg']
  },
  dusk: {
    landscape: ['assets/dusk/scene.jpg', 'assets/dusk/scene.png', 'assets/dusk/scene.svg'],
    portrait: ['assets/dusk/scene-portrait.jpg', 'assets/dusk/scene-portrait.webp'],
    cursor: ['assets/dusk/car.png', 'assets/dusk/car.webp'],
    focus: ['58%', '74%'],
    headlights: ['assets/dusk/headlights.jpg', 'assets/dusk/headlights.svg']
  },
  night: {
    landscape: ['assets/night/scene.jpg', 'assets/night/scene.png', 'assets/night/scene.svg'],
    portrait: ['assets/night/scene-portrait.jpg', 'assets/night/scene-portrait.webp'],
    cursor: ['assets/night/car.png', 'assets/night/car.webp'],
    focus: ['58%', '74%'],
    headlights: ['assets/night/headlights.jpg', 'assets/night/headlights.svg']
  },
  midnight: {
    landscape: ['assets/midnight/scene.jpg', 'assets/midnight/scene.png', 'assets/midnight/scene.svg'],
    portrait: ['assets/midnight/scene-portrait.jpg', 'assets/midnight/scene-portrait.webp'],
    cursor: ['assets/midnight/car.png', 'assets/midnight/car.webp'],
    focus: ['58%', '74%'],
    headlights: ['assets/midnight/headlights.jpg', 'assets/midnight/headlights.svg']
  }
};

const ASSETS = Object.keys(SCENE_ASSETS).reduce(function (table, id) {
  const entry = SCENE_ASSETS[id];
  table[id] = {
    scene: entry.landscape,
    portrait: entry.portrait,
    cursor: entry.cursor,
    focus: entry.focus,
    headlights: entry.headlights
  };
  return table;
}, {});

const CLOCK_MS = 1000;
const TRANSITION_MS = 1600;
const LABEL_SHOW_MS = 2800;
const HEADLIGHT_OPACITY = 0.76;

/* ══════════════════════════════════════════════════════════════════════════
   3. RUNTIME STATE & DOM REFERENCES
   ══════════════════════════════════════════════════════════════════════════ */

let mode = 'auto';
let currentId = null;
let frontIsA = true;
let transitioning = false;
let pendingId = null;
let manualOriginScheduleId = null;

let rafHandle = null;
let assetsCache = {};
let assetsReady = {};
let layersOpacity = [-1, -1];
let particleIntensity = 0;
let layerAId = null;
let layerBId = null;
let lastAccentId = null;
let lastHeadlightMix = -1;

let clockTimer = null;
let labelTimer = null;

let STUDIO_CATALOG = null;
let studioWallpaperOverrides = {}; // { periodId: wallpaperObj }
let activeSingleWallpaper = null;  // non-null when user applies a specific Studio wallpaper directly
let activeStudioCar = null;        // car catalog entry when user picks a Car Studio overlay

const layerA = document.querySelector('[data-layer="a"]');
const layerB = document.querySelector('[data-layer="b"]');
const sceneLabelEl = document.getElementById('scene-label');
const sceneLabelTxt = document.getElementById('scene-label-text');
const ctOverlay = document.getElementById('ct-overlay');
const root = document.documentElement;

const hudDateEl = document.getElementById('hud-date');
const hudTimeEl = document.getElementById('hud-time');
const drawerClockVal = document.getElementById('drawer-clock-val');
const drawerDateSub = document.getElementById('drawer-date-sub');
const drawerPeriodBadge = document.getElementById('drawer-period-badge');

const batteryWidget = document.getElementById('battery-widget');
const batteryFill = document.getElementById('battery-fill');
const batteryPctEl = document.getElementById('battery-pct');
const drawerBatteryVal = document.getElementById('drawer-battery-val');
const drawerBatterySub = document.getElementById('drawer-battery-sub');

const telemetryState = {
  batteryAvailable: false,
  batteryPct: null,
  batteryCharging: false,
  weatherAvailable: false,
  weatherTempC: null,
  weatherCode: null,
  weatherIsDay: 0,
  weatherLabel: 'Locating…',
  wifi: navigator.onLine,
  bt: null
};

/* ══════════════════════════════════════════════════════════════════════════
   4. TIME & EDITABLE SCHEDULE ENGINE
   ══════════════════════════════════════════════════════════════════════════ */

function minutesNow() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function minutesForward(from, to) {
  return (to - from + 1440) % 1440;
}

function formatMinutesHHMM(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return hh + ':' + mm;
}

function parseHHMMToMinutes(str) {
  const match = String(str || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function recomputePeriodEnds(blendMins) {
  // Sort a copy by start minute around the 24h ring to derive each period's
  // exact end minute (the next period's start minute), so zero gaps or overlaps
  // can ever exist even after custom user edits.
  const ordered = PERIODS.slice().sort(function (a, b) { return a.start - b.start; });
  for (let i = 0; i < ordered.length; i++) {
    const cur = ordered[i];
    const nxt = ordered[(i + 1) % ordered.length];
    cur.end = nxt.start === 0 ? 1440 : nxt.start;
    if (typeof blendMins === 'number' && blendMins >= 5 && blendMins <= 60) {
      cur.transitionMins = blendMins;
    }
  }
}

function periodFromMinutes(m) {
  const norm = ((m % 1440) + 1440) % 1440;
  for (let i = 0; i < PERIODS.length; i++) {
    const p = PERIODS[i];
    const endMod = p.end % 1440;
    const inRange = p.start < p.end && endMod !== 0
      ? (norm >= p.start && norm < endMod)
      : (endMod === 0 ? norm >= p.start : (norm >= p.start || norm < endMod));
    if (inRange) return p;
  }
  return PERIODS[PERIODS.length - 1];
}

function periodById(id) {
  return PERIODS.find(function (p) { return p.id === id; }) || null;
}

function periodIndex(id) {
  return PERIODS.findIndex(function (p) { return p.id === id; });
}

function computeBlend(m) {
  const totalMins = ((m % 1440) + 1440) % 1440;
  const ordered = PERIODS.slice().sort(function (a, b) { return a.start - b.start; });

  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i];
    const prev = ordered[(i + ordered.length - 1) % ordered.length];
    const span = minutesForward(prev.start, p.start) || 1440;
    const win = Math.min(p.transitionMins || 20, Math.max(5, Math.floor(span * 0.45)));
    const blendStart = (p.start - win + 1440) % 1440;

    const inBlend = blendStart < p.start
      ? (totalMins >= blendStart && totalMins < p.start)
      : (totalMins >= blendStart || totalMins < p.start);

    if (inBlend) {
      const elapsed = minutesForward(blendStart, totalMins);
      const ratio = Math.max(0, Math.min(1, elapsed / win));
      return { from: prev.id, to: p.id, ratio: ratio };
    }
  }

  const cur = periodFromMinutes(totalMins);
  return { from: cur.id, to: cur.id, ratio: 1.0 };
}

/* ══════════════════════════════════════════════════════════════════════════
   5. CLOCK, EDITORIAL DATE & AUTO-RESUME CHECK
   ══════════════════════════════════════════════════════════════════════════ */

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function updateHUD() {
  const d = new Date();
  const h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');

  const timeStr = SETTINGS.clock24
    ? String(h).padStart(2, '0') + ':' + min
    : (h % 12 || 12) + ':' + min + ' ' + (h >= 12 ? 'PM' : 'AM');

  // Clean mixed-case editorial date above the clock matching reference image-1.png
  // while keeping the 4-digit year for unambiguous system display.
  const dateStr = SHORT_DAYS[d.getDay()] + ', ' + SHORT_MONTHS[d.getMonth()] + ' ' + d.getDate() + ' · ' + d.getFullYear();

  if (hudDateEl && hudDateEl.textContent !== dateStr) hudDateEl.textContent = dateStr;
  if (hudTimeEl && hudTimeEl.textContent !== timeStr) hudTimeEl.textContent = timeStr;
  if (drawerClockVal && drawerClockVal.textContent !== timeStr) drawerClockVal.textContent = timeStr;
  if (drawerDateSub) {
    const shortSub = SHORT_DAYS[d.getDay()] + ' ' + SHORT_MONTHS[d.getMonth()] + ' ' + d.getDate();
    if (drawerDateSub.textContent !== shortSub) drawerDateSub.textContent = shortSub;
  }

  // Optional "resume at next scheduled time period" policy after manual pick:
  if (mode === 'manual' &&
      !activeSingleWallpaper &&
      SETTINGS.manualResumeMode === 'nextBoundary' &&
      manualOriginScheduleId) {
    const scheduledNow = periodFromMinutes(h * 60 + d.getMinutes());
    if (scheduledNow && scheduledNow.id !== manualOriginScheduleId) {
      manualOriginScheduleId = null;
      setAutoScene(true);
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   6. BATTERY & SYSTEM CONNECTIVITY BRIDGES
   ══════════════════════════════════════════════════════════════════════════ */

function renderBattery(pct, charging) {
  const pctClamped = Math.max(0, Math.min(100, Math.round(pct)));
  telemetryState.batteryAvailable = true;
  telemetryState.batteryPct = pctClamped;
  telemetryState.batteryCharging = !!charging;

  if (batteryFill) {
    batteryFill.style.width = pctClamped + '%';
    batteryFill.classList.toggle('is-low', !charging && pctClamped <= 20);
    batteryFill.classList.toggle('is-charging', !!charging);
  }
  if (batteryPctEl) batteryPctEl.textContent = pctClamped + '%';
  if (batteryWidget) {
    batteryWidget.classList.remove('is-unavailable');
    batteryWidget.classList.toggle('is-charging', !!charging);
    batteryWidget.setAttribute('aria-label', 'Battery ' + pctClamped + '%' + (charging ? ', charging' : ''));
    batteryWidget.title = charging ? 'Battery ' + pctClamped + '% (Charging)' : 'Battery ' + pctClamped + '%';
  }
  if (drawerBatteryVal) drawerBatteryVal.textContent = pctClamped + '%';
  if (drawerBatterySub) drawerBatterySub.textContent = charging ? 'Charging' : (pctClamped <= 20 ? 'Low battery' : 'On battery');
  emit('telemetry', telemetryState);
}

function showBatteryUnavailable() {
  telemetryState.batteryAvailable = false;
  telemetryState.batteryPct = null;
  if (batteryPctEl) batteryPctEl.textContent = 'AC';
  if (batteryWidget) {
    batteryWidget.title = 'No battery detected (Desktop AC or unavailable in browser)';
    batteryWidget.setAttribute('aria-label', 'Battery unavailable or desktop AC power');
    batteryWidget.classList.add('is-unavailable');
  }
  if (drawerBatteryVal) drawerBatteryVal.textContent = 'AC / N/A';
  if (drawerBatterySub) drawerBatterySub.textContent = 'No battery sensor';
  emit('telemetry', telemetryState);
}

function initBattery() {
  if (PLATFORM.webview2) {
    window.chrome.webview.addEventListener('message', function (event) {
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (!data) return;
        if (data.type === 'battery') {
          if (data.available === false) showBatteryUnavailable();
          else renderBattery(data.percent, data.charging);
        } else if (data.type === 'connectivity') {
          updateConnectivity(data.wifi, data.bt, data.audio, data.muted);
        } else if (data.type === 'media') {
          handleNativeMediaMessage(data);
        }
      } catch (e) { /* ignore malformed messages */ }
    });
    if (batteryPctEl) batteryPctEl.textContent = '…';
    setTimeout(function () {
      if (!nativeHostActive) initBrowserBattery();
    }, 4000);
    return;
  }

  window.addEventListener('message', function (event) {
    try {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (data && data.pct !== undefined) {
        renderBattery(parseInt(data.pct, 10), data.status === 'Charging');
      }
    } catch (e) { /* ignore */ }
  });

  initBrowserBattery();
}

function initBrowserBattery() {
  if (!navigator.getBattery) {
    showBatteryUnavailable();
    return;
  }
  navigator.getBattery().then(function (battery) {
    function update() { renderBattery(battery.level * 100, battery.charging); }
    update();
    battery.addEventListener('levelchange', update);
    battery.addEventListener('chargingchange', update);
  }).catch(function () {
    showBatteryUnavailable();
  });
}

const wifiBtn = document.getElementById('wifi-btn');
const btBtn = document.getElementById('bt-btn');
const wifiStatus = document.getElementById('wifi-status');
const btStatus = document.getElementById('bt-status');

function setWifiState(online) {
  telemetryState.wifi = !!online;
  if (!wifiBtn || !wifiStatus) return;
  wifiBtn.classList.toggle('is-on', !!online);
  wifiBtn.classList.toggle('is-off', !online);
  wifiStatus.textContent = online ? 'Connected' : 'Offline';
}

function setBtState(enabled) {
  telemetryState.bt = enabled;
  if (!btBtn || !btStatus) return;
  if (enabled === true) {
    btBtn.classList.add('is-on');
    btBtn.classList.remove('is-off');
    btStatus.textContent = 'On';
  } else if (enabled === false) {
    btBtn.classList.add('is-off');
    btBtn.classList.remove('is-on');
    btStatus.textContent = 'Off';
  } else {
    btBtn.classList.remove('is-on', 'is-off');
    btStatus.textContent = 'Settings';
  }
}

function updateConnectivity(wifi, bt, audioPct, isMuted) {
  setWifiState(typeof wifi === 'boolean' ? wifi : navigator.onLine);
  setBtState(bt);

  const audioWidget = document.getElementById('conn-audio');
  const audioPctEl = document.getElementById('audio-pct');
  if (audioWidget && audioPctEl && audioPct !== null && audioPct !== undefined) {
    audioPctEl.textContent = isMuted ? 'Muted' : (audioPct + '%');
    audioWidget.classList.toggle('is-off', !!isMuted);
    audioWidget.classList.toggle('is-on', !isMuted);
  }
}

setWifiState(navigator.onLine);
setBtState(null);
window.addEventListener('online', function () { setWifiState(true); });
window.addEventListener('offline', function () { setWifiState(false); });

/* ══════════════════════════════════════════════════════════════════════════
   7. REAL MEDIA SESSION (Windows SMTC + Local HTML5 Audio Player)
   ══════════════════════════════════════════════════════════════════════════ */

const musicAudioEl = document.getElementById('music-audio');
let localAudioUrl = null;

const MEDIA = {
  source: 'none',       // 'smtc' | 'local' | 'none'
  supported: PLATFORM.webview2,
  connected: false,
  playing: false,
  title: '',
  artist: '',
  sourceApp: '',
  positionSec: 0,
  durationSec: 0,
  canPlayPause: false,
  canNext: false,
  canPrev: false,
  canSeek: false
};

function handleNativeMediaMessage(msg) {
  // If the user is actively playing a loaded local audio file, keep local control
  // until paused/cleared; otherwise reflect live Windows SMTC state truthfully.
  if (MEDIA.source === 'local' && MEDIA.playing) return;

  if (!msg.connected) {
    if (MEDIA.source !== 'local') {
      MEDIA.source = 'none';
      MEDIA.supported = !!msg.supported;
      MEDIA.connected = false;
      MEDIA.playing = false;
      MEDIA.title = '';
      MEDIA.artist = '';
      MEDIA.sourceApp = '';
      MEDIA.positionSec = 0;
      MEDIA.durationSec = 0;
      MEDIA.canPlayPause = false;
      MEDIA.canNext = false;
      MEDIA.canPrev = false;
      MEDIA.canSeek = false;
      emit('media', MEDIA);
    }
    return;
  }

  MEDIA.source = 'smtc';
  MEDIA.supported = true;
  MEDIA.connected = true;
  MEDIA.playing = !!msg.playing;
  MEDIA.title = msg.title || 'Active Windows Media';
  MEDIA.artist = msg.artist || cleanSourceAppName(msg.sourceApp);
  MEDIA.sourceApp = cleanSourceAppName(msg.sourceApp);
  MEDIA.positionSec = typeof msg.positionSec === 'number' ? msg.positionSec : 0;
  MEDIA.durationSec = typeof msg.durationSec === 'number' ? msg.durationSec : 0;
  MEDIA.canPlayPause = msg.canPlayPause !== false;
  MEDIA.canNext = !!msg.canNext;
  MEDIA.canPrev = !!msg.canPrev;
  MEDIA.canSeek = !!msg.canSeek;
  emit('media', MEDIA);
}

function cleanSourceAppName(appId) {
  if (!appId) return 'Windows Media';
  const base = String(appId).split('!')[0].replace(/\.exe$/i, '');
  const parts = base.split(/[.\\/]/);
  return parts[parts.length - 1] || 'Windows Media';
}

function bindLocalMusicAudio() {
  if (!musicAudioEl) return;
  const syncLocal = function () {
    if (MEDIA.source !== 'local') return;
    MEDIA.playing = !musicAudioEl.paused && !musicAudioEl.ended;
    MEDIA.positionSec = musicAudioEl.currentTime || 0;
    MEDIA.durationSec = isFinite(musicAudioEl.duration) ? musicAudioEl.duration : 0;
    MEDIA.canSeek = MEDIA.durationSec > 0;
    emit('media', MEDIA);
  };
  musicAudioEl.addEventListener('timeupdate', syncLocal);
  musicAudioEl.addEventListener('loadedmetadata', syncLocal);
  musicAudioEl.addEventListener('play', syncLocal);
  musicAudioEl.addEventListener('pause', syncLocal);
  musicAudioEl.addEventListener('ended', syncLocal);
}
bindLocalMusicAudio();

function loadLocalAudio(url, meta) {
  if (!musicAudioEl || !url) return;
  if (localAudioUrl && localAudioUrl !== url && typeof URL.revokeObjectURL === 'function') {
    try { URL.revokeObjectURL(localAudioUrl); } catch (e) { /* ignore */ }
  }
  localAudioUrl = url;
  musicAudioEl.src = url;
  applyAudioSettings();

  MEDIA.source = 'local';
  MEDIA.connected = true;
  MEDIA.playing = false;
  MEDIA.title = (meta && meta.title) ? meta.title : 'Local Audio Track';
  MEDIA.artist = (meta && meta.artist) ? meta.artist : 'Local File';
  MEDIA.sourceApp = 'Local Audio';
  MEDIA.positionSec = 0;
  MEDIA.durationSec = 0;
  MEDIA.canPlayPause = true;
  MEDIA.canPrev = true;
  MEDIA.canNext = false;
  MEDIA.canSeek = true;
  emit('media', MEDIA);

  if (typeof musicAudioEl.play === 'function') {
    const p = musicAudioEl.play();
    if (p && p.catch) p.catch(function () { emit('media', MEDIA); });
  }
}

function mediaPlayPause() {
  if (MEDIA.source === 'local' && musicAudioEl && musicAudioEl.getAttribute('src')) {
    if (musicAudioEl.paused) {
      const p = musicAudioEl.play();
      if (p && p.catch) p.catch(function () {});
    } else {
      musicAudioEl.pause();
    }
    return true;
  }
  if (PLATFORM.webview2 && nativeHostActive && MEDIA.connected) {
    postToHost('media:toggle');
    return true;
  }
  return false;
}

function mediaNext() {
  if (MEDIA.source === 'local' && musicAudioEl && isFinite(musicAudioEl.duration)) {
    musicAudioEl.currentTime = Math.min(musicAudioEl.duration, (musicAudioEl.currentTime || 0) + 15);
    return true;
  }
  if (PLATFORM.webview2 && nativeHostActive && MEDIA.connected) {
    postToHost('media:next');
    return true;
  }
  return false;
}

function mediaPrev() {
  if (MEDIA.source === 'local' && musicAudioEl) {
    musicAudioEl.currentTime = 0;
    return true;
  }
  if (PLATFORM.webview2 && nativeHostActive && MEDIA.connected) {
    postToHost('media:prev');
    return true;
  }
  return false;
}

function mediaSeek(seconds) {
  const sec = Math.max(0, Number(seconds) || 0);
  if (MEDIA.source === 'local' && musicAudioEl && isFinite(musicAudioEl.duration)) {
    musicAudioEl.currentTime = Math.min(musicAudioEl.duration, sec);
    return true;
  }
  if (PLATFORM.webview2 && nativeHostActive && MEDIA.connected && MEDIA.canSeek) {
    postToHost('media:seek:' + sec.toFixed(2));
    return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════════════════
   8. ASSET RESOLUTION, STUDIO PACKS & LAYER POPULATION
   ══════════════════════════════════════════════════════════════════════════ */

function loadFirstAvailable(paths) {
  return new Promise(function (resolve) {
    if (!paths || paths.length === 0) { resolve(null); return; }
    let index = 0;
    function tryNext() {
      if (index >= paths.length) { resolve(null); return; }
      const src = paths[index++];
      if (/\.svg($|\?)/i.test(src)) {
        const xhr = new XMLHttpRequest();
        xhr.timeout = 2000;
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve({ src: src, kind: 'svg', svg: xhr.responseText });
          } else {
            tryNext();
          }
        };
        xhr.onerror = function () { tryNext(); };
        xhr.ontimeout = function () { tryNext(); };
        xhr.open('GET', src, true);
        xhr.send();
      } else {
        const img = new Image();
        img.onload = function () { resolve({ src: src, kind: 'raster' }); };
        img.onerror = function () { tryNext(); };
        img.src = src;
      }
    }
    tryNext();
  });
}

function prefersPortraitAsset() {
  return window.innerHeight > window.innerWidth * 1.05;
}

function resolvePeriodStudioWallpaper(periodId) {
  if (studioWallpaperOverrides[periodId]) return studioWallpaperOverrides[periodId];
  if (!STUDIO_CATALOG || !Array.isArray(STUDIO_CATALOG.packs)) return null;
  const packId = SETTINGS.activePack || 'cascade-overlook';
  if (packId === 'cascade-overlook') return null; // use standard SCENE_ASSETS path
  const pack = STUDIO_CATALOG.packs.find(function (pk) { return pk.id === packId; });
  if (!pack || !pack.periods || !pack.periods[periodId]) return null;
  const wpId = pack.periods[periodId];
  return (STUDIO_CATALOG.wallpapers || []).find(function (w) { return w.id === wpId; }) || null;
}

async function ensureAssets(periodId) {
  const wantPortrait = prefersPortraitAsset();
  const studioWp = activeSingleWallpaper || resolvePeriodStudioWallpaper(periodId);
  const cacheKey = periodId + '|' + (wantPortrait ? 'P' : 'L') + '|' + (studioWp ? studioWp.src : 'default');

  if (assetsCache[cacheKey] && assetsReady[cacheKey]) {
    return assetsCache[cacheKey];
  }

  const assets = ASSETS[periodId] || { scene: [], headlights: [] };
  const period = periodById(periodId);

  let sceneAsset = null;
  let hlAsset = null;
  let carAsset = null;
  let focus = assets.focus;
  let supportsCarOverlay = false;
  let ridgeMinY = null;

  if (studioWp && studioWp.src) {
    sceneAsset = await loadFirstAvailable([studioWp.src]);
    if (!sceneAsset) {
      // Missing/revoked imported wallpaper safety: fall back cleanly to built-in plate!
      sceneAsset = await loadFirstAvailable(assets.scene);
    } else {
      focus = studioWp.focus || focus;
      supportsCarOverlay = studioWp.supportsCarOverlay === true;
      ridgeMinY = typeof studioWp.ridgeMinY === 'number' ? studioWp.ridgeMinY : null;
      if (studioWp.headlightsSrc && period && period.headlights) {
        hlAsset = await loadFirstAvailable([studioWp.headlightsSrc]);
      }
    }
  } else {
    if (wantPortrait && assets.portrait && assets.portrait.length) {
      sceneAsset = await loadFirstAvailable(assets.portrait);
    }
    if (!sceneAsset) sceneAsset = await loadFirstAvailable(assets.scene);
    hlAsset = period && period.headlights
      ? await loadFirstAvailable(assets.headlights)
      : null;
    carAsset = assets.cursor && assets.cursor.length
      ? await loadFirstAvailable(assets.cursor)
      : null;
  }

  assetsCache[cacheKey] = {
    scene: sceneAsset,
    headlights: hlAsset,
    cursor: carAsset,
    focus: focus,
    supportsCarOverlay: supportsCarOverlay,
    ridgeMinY: ridgeMinY
  };
  assetsReady[cacheKey] = true;
  return assetsCache[cacheKey];
}

const MAX_COVER_ASPECT = 0.8;

function applyPlateAspect(layer, img, src) {
  const apply = function () {
    const w = img.naturalWidth || 16;
    const h = img.naturalHeight || 9;
    const tall = h > 0 && (w / h) < MAX_COVER_ASPECT;
    img.classList.toggle('scene-img--contain', tall);
    layer.classList.toggle('layer--contain', tall);
    if (tall) {
      if (layer.style.getPropertyValue('--plate-url') !== 'url("' + src + '")') {
        layer.style.setProperty('--plate-url', 'url("' + src + '")');
      }
    } else {
      layer.style.removeProperty('--plate-url');
    }
  };
  if (img.complete && img.naturalWidth) apply();
  else img.addEventListener('load', apply, { once: true });
}

function carPeriodFilter(periodId) {
  switch (periodId) {
    case 'morning': return 'brightness(0.96) contrast(0.98) saturate(0.95)';
    case 'day': return 'brightness(1.03) contrast(1.02)';
    case 'goldenHour': return 'brightness(0.98) sepia(0.10) saturate(1.08)';
    case 'dusk': return 'brightness(0.86) contrast(1.04) hue-rotate(-4deg)';
    case 'night': return 'brightness(0.76) contrast(1.06) hue-rotate(-6deg)';
    case 'midnight': return 'brightness(0.68) contrast(1.08) hue-rotate(-8deg)';
    default: return 'none';
  }
}

function fillLayer(layer, period, sceneAsset, headlightAsset, carAsset, meta) {
  const fallback = layer.querySelector('.scene-fallback');
  const svgScene = layer.querySelector('.svg-scene');
  const sceneImg = layer.querySelector('.scene-img');
  const svgLights = layer.querySelector('.svg-headlights');
  const headImg = layer.querySelector('.headlight-img');
  const carImg = layer.querySelector('.car-img');

  fallback.setAttribute('data-period', period.id);
  layer.dataset.supportsCar = (meta && meta.supportsCarOverlay) ? '1' : '0';
  layer.dataset.periodId = period.id;

  if (carImg) {
    carImg.removeAttribute('src');
    carImg.classList.remove('is-loaded');
    carImg.style.filter = '';
  }
  svgScene.innerHTML = '';
  svgLights.innerHTML = '';
  svgLights.classList.remove('is-on');
  headImg.removeAttribute('src');
  headImg.classList.remove('is-on');

  const focus = (meta && meta.focus) || (ASSETS[period.id] && ASSETS[period.id].focus);
  if (focus) {
    const focusValue = focus[0] + ' ' + focus[1];
    if (layer.style.getPropertyValue('--focus') !== focusValue) {
      layer.style.setProperty('--focus', focusValue);
    }
  }

  if (sceneAsset && sceneAsset.kind === 'svg') {
    svgScene.innerHTML = sceneAsset.svg;
    sceneImg.removeAttribute('src');
    sceneImg.classList.remove('is-loaded', 'scene-img--contain');
    layer.classList.remove('layer--contain');
  } else if (sceneAsset && sceneAsset.kind === 'raster') {
    sceneImg.src = sceneAsset.src;
    sceneImg.classList.add('is-loaded');
    applyPlateAspect(layer, sceneImg, sceneAsset.src);
  } else {
    sceneImg.removeAttribute('src');
    sceneImg.classList.remove('is-loaded', 'scene-img--contain');
    layer.classList.remove('layer--contain');
  }

  if (carImg && carAsset && carAsset.kind === 'raster') {
    carImg.src = carAsset.src;
    carImg.classList.add('is-loaded');
    layer.classList.add('layer--has-car');
  } else if (carImg) {
    layer.classList.remove('layer--has-car');
  }

  applyForegroundFor(layer, period.id);

  // Integrated headlights only when no separate Car Studio vehicle is replacing the scene
  if (headlightAsset && (period.headlights || headlightOverride === true)) {
    if (headlightAsset.kind === 'svg') {
      svgLights.innerHTML = headlightAsset.svg;
      svgLights.classList.add('is-on');
    } else if (headlightAsset.kind === 'raster') {
      headImg.src = headlightAsset.src;
      headImg.classList.add('is-on');
    }
  }

  drawStudioCarBeams();
}

/* ══════════════════════════════════════════════════════════════════════════
   9. COLOUR GRADING, HEADLIGHT MIX & DYNAMIC CAR STUDIO BEAMS
   ══════════════════════════════════════════════════════════════════════════ */

function parseRGBA(str) {
  const m = String(str || '').match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (!m) return [0, 0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

function lerpCTColor(colorA, colorB, t) {
  const a = parseRGBA(colorA);
  const b = parseRGBA(colorB);
  const mix = function (i) { return a[i] + (b[i] - a[i]) * t; };
  return 'rgba(' + Math.round(mix(0)) + ',' + Math.round(mix(1)) + ',' + Math.round(mix(2)) + ',' + (Math.round(mix(3) * 1000) / 1000) + ')';
}

let lastCT = '';
function applyCTOverlay(blendState) {
  const fromP = periodById(blendState.from);
  const toP = periodById(blendState.to);
  if (!fromP || !toP || !ctOverlay) return;
  const t = blendState.from === blendState.to ? 1 : blendState.ratio;
  const colour = lerpCTColor(fromP.ctColor || 'rgba(0,0,0,0)', toP.ctColor || 'rgba(0,0,0,0)', t);
  if (colour !== lastCT) {
    lastCT = colour;
    ctOverlay.style.background = colour;
  }
}

function applyAccent(period) {
  if (!period) return;
  root.style.setProperty('--accent', period.accent || '#7da9ff');
  root.style.setProperty('--accent-dim', period.accentDim || 'rgba(125,169,255,0.22)');
  if (drawerPeriodBadge) drawerPeriodBadge.textContent = period.label;
}

function effectiveBeamPeak() {
  return HEADLIGHT_OPACITY * Math.max(0.2, Math.min(1, (SETTINGS.beamIntensity || 75) / 85));
}

function setHeadlightOpacity(layer, opacity) {
  if (!layer) return;
  const svgLights = layer.querySelector('.svg-headlights');
  const headImg = layer.querySelector('.headlight-img');
  const op = Math.max(0, Math.min(1, opacity));
  const value = op.toFixed(3);

  if (svgLights && !svgLights.classList.contains('headlight-flare') && svgLights.dataset.opacity !== value) {
    svgLights.dataset.opacity = value;
    svgLights.style.opacity = value;
  }
  if (headImg && !headImg.classList.contains('headlight-flare') && headImg.dataset.opacity !== value) {
    headImg.dataset.opacity = value;
    headImg.style.opacity = value;
  }
}

function shouldShowHeadlights(periodId) {
  if (headlightOverride === true) return true;
  if (headlightOverride === false) return false;
  const p = periodById(periodId);
  return !!(p && p.headlights);
}

function headlightOpacityFor(periodId) {
  return shouldShowHeadlights(periodId) ? effectiveBeamPeak() : 0;
}

const carBeamCanvas = document.getElementById('car-beam-canvas');
const carBeamCtx = carBeamCanvas ? carBeamCanvas.getContext('2d') : null;

function drawStudioCarBeams() {
  if (!carBeamCanvas || !carBeamCtx) return;
  const periodId = currentId || layerAId || SETTINGS.sceneId || 'night';
  const visibleLayer = (!frontIsA && mode === 'manual') ? layerB : layerA;
  const layerHasCar = visibleLayer && visibleLayer.classList.contains('layer--has-car');
  const lightsOn = shouldShowHeadlights(periodId);

  if (!layerHasCar || !lightsOn || !activeStudioCar || !Array.isArray(activeStudioCar.lamps)) {
    carBeamCanvas.style.opacity = '0';
    return;
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (carBeamCanvas.width !== Math.round(vw * dpr) || carBeamCanvas.height !== Math.round(vh * dpr)) {
    carBeamCanvas.width = Math.round(vw * dpr);
    carBeamCanvas.height = Math.round(vh * dpr);
  }
  if (typeof carBeamCtx.setTransform === 'function') {
    carBeamCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  carBeamCtx.clearRect(0, 0, vw, vh);

  const focusStr = (visibleLayer && visibleLayer.style.getPropertyValue('--focus')) || '58% 68%';
  const fParts = focusStr.trim().split(/\s+/);
  const fx = (parseFloat(fParts[0]) || 58) / 100;
  const fy = (parseFloat(fParts[1]) || 68) / 100;
  const rect = plateRect(1376, 768, vw, vh, fx, fy);

  const mapPt = function (pt) {
    return [rect.left + (pt[0] / 1376) * rect.width, rect.top + (pt[1] / 768) * rect.height];
  };
  const target = mapPt(activeStudioCar.beamTarget || [275, 742]);

  activeStudioCar.lamps.forEach(function (lamp) {
    const lp = mapPt(lamp);
    const dx = target[0] - lp[0];
    const dy = target[1] - lp[1];
    const reach = Math.hypot(dx, dy) * 1.15;
    const ux = dx / (Math.hypot(dx, dy) || 1);
    const uy = dy / (Math.hypot(dx, dy) || 1);
    const px = -uy;
    const py = ux;

    if (typeof carBeamCtx.createLinearGradient === 'function') {
      const grad = carBeamCtx.createLinearGradient(lp[0], lp[1], lp[0] + ux * reach, lp[1] + uy * reach);
      grad.addColorStop(0, 'rgba(255, 232, 188, 0.52)');
      grad.addColorStop(0.35, 'rgba(255, 206, 134, 0.24)');
      grad.addColorStop(1, 'rgba(255, 190, 110, 0)');
      carBeamCtx.fillStyle = grad;
    } else {
      carBeamCtx.fillStyle = 'rgba(255, 214, 150, 0.25)';
    }

    carBeamCtx.beginPath();
    carBeamCtx.moveTo(lp[0] - px * 6, lp[1] - py * 6);
    carBeamCtx.lineTo(lp[0] + ux * reach - px * (reach * 0.28), lp[1] + uy * reach - py * (reach * 0.28));
    carBeamCtx.lineTo(lp[0] + ux * reach + px * (reach * 0.28), lp[1] + uy * reach + py * (reach * 0.28));
    carBeamCtx.lineTo(lp[0] + px * 6, lp[1] + py * 6);
    carBeamCtx.closePath();
    carBeamCtx.fill();

    // Crisp headlamp bloom core
    if (typeof carBeamCtx.createRadialGradient === 'function') {
      const core = carBeamCtx.createRadialGradient(lp[0], lp[1], 1, lp[0], lp[1], 24);
      core.addColorStop(0, 'rgba(255, 248, 232, 0.92)');
      core.addColorStop(0.4, 'rgba(255, 218, 158, 0.42)');
      core.addColorStop(1, 'rgba(255, 200, 120, 0)');
      carBeamCtx.fillStyle = core;
      carBeamCtx.beginPath();
      carBeamCtx.arc(lp[0], lp[1], 24, 0, Math.PI * 2);
      carBeamCtx.fill();
    }
  });

  carBeamCanvas.style.opacity = effectiveBeamPeak().toFixed(3);
}

/* ══════════════════════════════════════════════════════════════════════════
   10. AUTO BLEND LOOP & MANUAL CROSSFADE
   ══════════════════════════════════════════════════════════════════════════ */

let orientationTimer = null;
let lastPortraitState = prefersPortraitAsset();

function onViewportResize() {
  drawStudioCarBeams();
  const now = prefersPortraitState();
  if (now === lastPortraitState) return;
  lastPortraitState = now;
  clearTimeout(orientationTimer);
  orientationTimer = setTimeout(function () {
    assetsCache = {};
    assetsReady = {};
    const visibleId = currentId || layerAId;
    if (visibleId) {
      layerAId = visibleId;
      layerBId = null;
      ensureLayerPopulated(layerA, visibleId);
    }
  }, 250);
}
function prefersPortraitState() { return prefersPortraitAsset(); }

window.addEventListener('resize', onViewportResize);
window.addEventListener('orientationchange', onViewportResize);

async function ensureLayerPopulated(layer, periodId) {
  const period = periodById(periodId);
  if (!period) return;
  const cached = await ensureAssets(periodId);
  fillLayer(layer, period, cached.scene, cached.headlights, cached.cursor, cached);
}

function rafTick() {
  if (mode !== 'auto') {
    rafHandle = null;
    return;
  }

  const blend = computeBlend(minutesNow());
  const needFrom = blend.from;
  const needTo = blend.to;

  if (needFrom === needTo) {
    if (layerAId !== needTo) {
      layerAId = needTo;
      currentId = needTo;
      ensureLayerPopulated(layerA, needTo).then(function () { refreshDepth(); });
    }
    if (layersOpacity[0] !== 1) {
      layerA.style.opacity = '1';
      layerB.style.opacity = '0';
      layersOpacity[0] = 1;
      layersOpacity[1] = 0;
      syncForegroundOpacity(1, 0);
    }
    currentId = needTo;
    const hlOp = headlightOpacityFor(needTo);
    setHeadlightOpacity(layerA, hlOp);
    setHeadlightOpacity(layerB, 0);
    setHeadlightMix(hlOp / HEADLIGHT_OPACITY);

    applyCTOverlay(blend);
    applyAccentFromBlend(blend);
  } else {
    const ratio = blend.ratio;
    if (layerAId !== needFrom) {
      layerAId = needFrom;
      ensureLayerPopulated(layerA, needFrom);
    }
    if (layerBId !== needTo) {
      layerBId = needTo;
      ensureLayerPopulated(layerB, needTo);
    }

    const aOpacity = 1 - ratio;
    if (Math.abs(layersOpacity[0] - aOpacity) > 0.0015) {
      layerA.style.opacity = String(aOpacity);
      layerB.style.opacity = String(ratio);
      layersOpacity[0] = aOpacity;
      layersOpacity[1] = ratio;
      syncForegroundOpacity(aOpacity, ratio);
    }

    const hlOpA = headlightOpacityFor(needFrom);
    const hlOpB = headlightOpacityFor(needTo);
    setHeadlightOpacity(layerA, hlOpA);
    setHeadlightOpacity(layerB, hlOpB);
    setHeadlightMix((hlOpA * (1 - ratio) + hlOpB * ratio) / HEADLIGHT_OPACITY);

    applyCTOverlay(blend);
    applyAccentFromBlend(blend);

    const domPeriod = ratio >= 0.5 ? periodById(needTo) : periodById(needFrom);
    if (domPeriod && currentId !== domPeriod.id) {
      currentId = domPeriod.id;
      refreshDepth();
    }
  }

  rafHandle = requestAnimationFrame(rafTick);
}

function setHeadlightMix(mix) {
  const value = Math.max(0, Math.min(1, mix));
  if (Math.abs(value - lastHeadlightMix) < 0.002) return;
  lastHeadlightMix = value;
  particleIntensity = value;
}

function applyAccentFromBlend(blend) {
  const p = periodById(blend.to) || periodById(blend.from);
  if (p && p.id !== lastAccentId) {
    lastAccentId = p.id;
    applyAccent(p);
  }
}

function startRaf() {
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = requestAnimationFrame(rafTick);
}

function stopRaf() {
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
}

async function showPeriodManual(period, instant) {
  if (!period) return;
  if (transitioning && !instant) {
    pendingId = period.id;
    return;
  }

  const cached = await ensureAssets(period.id);
  const dur = (SETTINGS.transitionMs || TRANSITION_MS) / 1000;
  layerA.style.transition = instant ? 'none' : ('opacity ' + dur + 's cubic-bezier(0.4,0,0.2,1)');
  layerB.style.transition = instant ? 'none' : ('opacity ' + dur + 's cubic-bezier(0.4,0,0.2,1)');

  const front = frontIsA ? layerA : layerB;
  const back = frontIsA ? layerB : layerA;

  fillLayer(back, period, cached.scene, cached.headlights, cached.cursor, cached);
  const hlOp = headlightOpacityFor(period.id);
  setHeadlightOpacity(back, hlOp);
  setHeadlightMix(hlOp / HEADLIGHT_OPACITY);
  applyAccent(period);
  applyCTOverlay({ from: period.id, to: period.id, ratio: 1 });

  if (frontIsA) { layerBId = period.id; } else { layerAId = period.id; }

  if (instant || currentId === null) {
    back.style.opacity = '1';
    front.style.opacity = '0';
    frontIsA = !frontIsA;
    currentId = period.id;
    refreshDepth();
    drawStudioCarBeams();
    return;
  }

  transitioning = true;
  back.style.opacity = '1';
  front.style.opacity = '0';
  frontIsA = !frontIsA;
  currentId = period.id;
  refreshDepth();
  drawStudioCarBeams();
  showSceneLabel(period);

  setTimeout(function () {
    transitioning = false;
    if (pendingId && pendingId !== currentId) {
      const next = periodById(pendingId);
      pendingId = null;
      if (next) showPeriodManual(next, false);
    } else {
      pendingId = null;
    }
  }, SETTINGS.transitionMs || TRANSITION_MS);
}

function showSceneLabel(period, customText) {
  if (!sceneLabelTxt || !sceneLabelEl) return;
  sceneLabelTxt.textContent = customText || period.label;
  sceneLabelEl.classList.add('is-visible');
  clearTimeout(labelTimer);
  labelTimer = setTimeout(function () {
    sceneLabelEl.classList.remove('is-visible');
  }, LABEL_SHOW_MS);
}

function setModeAuto() {
  mode = 'auto';
  activeSingleWallpaper = null;
  layersOpacity = [-1, -1];
  layerAId = null;
  layerBId = null;
  layerA.style.transition = 'none';
  layerB.style.transition = 'none';
  startRaf();
}

/* ══════════════════════════════════════════════════════════════════════════
   11. SUBTLE DUST MOTES IN HEADLIGHT BEAMS
   ══════════════════════════════════════════════════════════════════════════ */

const particlesCanvas = document.getElementById('particles-canvas');
const ctx = particlesCanvas ? particlesCanvas.getContext('2d') : null;
let particles = [];
let pW = 0, pH = 0, pDpr = 1;
let particlesRunning = false;
const PARTICLE_COUNT = 24;

function sizeParticlesCanvas() {
  if (!particlesCanvas) return;
  pDpr = Math.min(window.devicePixelRatio || 1, 2);
  pW = window.innerWidth;
  pH = window.innerHeight;
  particlesCanvas.width = Math.round(pW * pDpr);
  particlesCanvas.height = Math.round(pH * pDpr);
  particlesCanvas.style.width = pW + 'px';
  particlesCanvas.style.height = pH + 'px';
  if (ctx && typeof ctx.setTransform === 'function') ctx.setTransform(pDpr, 0, 0, pDpr, 0, 0);
}

function initParticles() {
  if (!particlesCanvas || !ctx) return;
  sizeParticlesCanvas();
  window.addEventListener('resize', sizeParticlesCanvas);
  particles = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(spawnParticle(true));
  if (REDUCED_MOTION.addEventListener) {
    REDUCED_MOTION.addEventListener('change', function () {
      if (REDUCED_MOTION.matches && particlesCanvas) particlesCanvas.style.opacity = '0';
    });
  }
}

function spawnParticle(randomY) {
  const wedge = Math.random() < 0.5 ? -1 : 1;
  const spread = Math.pow(Math.random(), 0.7);
  const yTop = pH * 0.72;
  const yBottom = pH * 0.96;
  const y = randomY ? yTop + Math.random() * (yBottom - yTop) : yBottom;
  const xCentre = pW * (wedge < 0 ? 0.42 : 0.56) + (y - yTop) * (wedge < 0 ? -0.28 : 0.14);
  const x = xCentre + (Math.random() - 0.5) * pW * 0.14 * (0.4 + spread);
  return {
    x: x,
    y: y,
    vx: (Math.random() - 0.5) * 0.20,
    vy: -(Math.random() * 0.14 + 0.04),
    size: Math.random() * 0.85 + 0.35,
    life: Math.random(),
    lifeRate: Math.random() * 0.0020 + 0.0008
  };
}

function drawParticlesStep() {
  if (!ctx || !particlesCanvas) return;
  const active = SETTINGS.particles && SETTINGS.motion && particleIntensity > 0.02 && !REDUCED_MOTION.matches;
  const canvasOpacity = active ? Math.min(1, particleIntensity).toFixed(2) : '0';
  if (canvasOpacity !== particlesCanvas.dataset.opacity) {
    particlesCanvas.dataset.opacity = canvasOpacity;
    particlesCanvas.style.opacity = canvasOpacity;
  }
  if (!active) return;

  ctx.clearRect(0, 0, pW, pH);
  ctx.fillStyle = 'rgba(232, 238, 248, 0.52)';
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life += p.lifeRate;
    const fade = Math.sin(Math.max(0, Math.min(1, p.life)) * Math.PI);
    if (fade > 0.01) {
      ctx.globalAlpha = fade * 0.26;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    if (p.life >= 1 || p.y < pH * 0.70) particles[i] = spawnParticle(false);
  }
  ctx.globalAlpha = 1;
}

function particlesLoop() {
  if (!particlesRunning) return;
  drawParticlesStep();
  requestAnimationFrame(particlesLoop);
}

function startParticles() {
  if (particlesRunning || !ctx) return;
  particlesRunning = true;
  requestAnimationFrame(particlesLoop);
}

function stopParticles() {
  particlesRunning = false;
  if (ctx && particlesCanvas) ctx.clearRect(0, 0, particlesCanvas.width, particlesCanvas.height);
}

/* ══════════════════════════════════════════════════════════════════════════
   12. LIVE OPEN-METEO WEATHER & GEOCODING (Never Fabricated)
   ══════════════════════════════════════════════════════════════════════════ */

let weatherCoords = null;
let weatherRefreshFn = null;

function formatTempDisplay(tempC) {
  if (tempC === null || tempC === undefined || !isFinite(tempC)) return '--°' + (SETTINGS.tempUnit === 'F' ? 'F' : 'C');
  if (SETTINGS.tempUnit === 'F') {
    return Math.round((tempC * 9) / 5 + 32) + '°F';
  }
  return Math.round(tempC) + '°C';
}

function getWeatherIcon(code, isDay) {
  const sunSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  const moonSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const cloudSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
  const rainSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="16" y1="13" x2="16" y2="21"/><line x1="8" y1="13" x2="8" y2="21"/><line x1="12" y1="15" x2="12" y2="23"/><path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/></svg>';
  if (code === 0) return isDay ? sunSvg : moonSvg;
  if (code >= 51 && code <= 99) return rainSvg;
  return cloudSvg;
}

function renderWeatherDOM() {
  const weatherIcon = document.getElementById('weather-icon');
  const weatherTemp = document.getElementById('weather-temp');
  const weatherWidget = document.getElementById('weather-widget');
  const drawerVal = document.getElementById('drawer-weather-val');
  const drawerSub = document.getElementById('drawer-weather-sub');
  const settingsStatus = document.getElementById('weather-settings-status');

  const txt = formatTempDisplay(telemetryState.weatherTempC);
  if (weatherTemp) weatherTemp.textContent = txt;
  if (drawerVal) drawerVal.textContent = txt;
  if (drawerSub) drawerSub.textContent = telemetryState.weatherLabel;
  if (weatherWidget) {
    weatherWidget.title = telemetryState.weatherAvailable
      ? ('Live weather: ' + txt + ' (' + telemetryState.weatherLabel + ') — click to refresh')
      : ('Weather unavailable (' + telemetryState.weatherLabel + ') — configure city in Settings');
  }
  if (weatherIcon) {
    weatherIcon.innerHTML = telemetryState.weatherAvailable
      ? getWeatherIcon(telemetryState.weatherCode, telemetryState.weatherIsDay)
      : getWeatherIcon(2, 0);
  }
  if (settingsStatus) {
    settingsStatus.textContent = telemetryState.weatherAvailable
      ? ('Live Open-Meteo reading: ' + txt + ' · ' + telemetryState.weatherLabel)
      : ('Weather status: ' + telemetryState.weatherLabel + '. Enter a city or coordinates below if OS geolocation is unavailable.');
  }
  emit('telemetry', telemetryState);
}

function initWeather() {
  function fallbackWeather(reason) {
    telemetryState.weatherAvailable = false;
    telemetryState.weatherTempC = null;
    telemetryState.weatherLabel = reason || 'Unavailable';
    renderWeatherDOM();
  }

  function fetchWeather(lat, lon, label) {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(lat) + '&longitude=' + encodeURIComponent(lon) + '&current_weather=true';
    return fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.current_weather && typeof data.current_weather.temperature === 'number') {
          telemetryState.weatherAvailable = true;
          telemetryState.weatherTempC = data.current_weather.temperature;
          telemetryState.weatherCode = data.current_weather.weathercode;
          telemetryState.weatherIsDay = data.current_weather.is_day;
          telemetryState.weatherLabel = label || 'Live local';
          renderWeatherDOM();
        } else {
          fallbackWeather('No data');
        }
      })
      .catch(function () { fallbackWeather('Offline'); });
  }

  function locateByIP() {
    return fetch('https://ipapi.co/json/')
      .then(function (res) { return res.json(); })
      .then(function (d) {
        if (d && typeof d.latitude === 'number' && typeof d.longitude === 'number') {
          return { lat: d.latitude, lon: d.longitude, label: d.city || 'Auto IP' };
        }
        throw new Error('no ip location');
      });
  }

  function locateAuto() {
    if (SETTINGS.weatherLat && SETTINGS.weatherLon) {
      const lat = parseFloat(SETTINGS.weatherLat);
      const lon = parseFloat(SETTINGS.weatherLon);
      if (isFinite(lat) && isFinite(lon)) {
        return Promise.resolve({ lat: lat, lon: lon, label: SETTINGS.weatherCity || 'Saved location' });
      }
    }
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) { reject(new Error('no geolocation')); return; }
      navigator.geolocation.getCurrentPosition(
        function (pos) { resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Device GPS' }); },
        function (err) { reject(err); },
        { timeout: 6000, maximumAge: 30 * 60 * 1000 }
      );
    }).catch(locateByIP);
  }

  function refresh() {
    if (!navigator.onLine) { fallbackWeather('Offline'); return Promise.resolve(); }
    return (weatherCoords ? Promise.resolve(weatherCoords) : locateAuto())
      .then(function (c) {
        weatherCoords = c;
        return fetchWeather(c.lat, c.lon, c.label);
      })
      .catch(function () { fallbackWeather('Location needed'); });
  }

  weatherRefreshFn = refresh;
  refresh();
  setInterval(refresh, 30 * 60 * 1000);
  window.addEventListener('online', refresh);
}

function setWeatherLocation(query) {
  const q = String(query || '').trim();
  if (!q) return Promise.resolve(false);

  const coordMatch = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lon = parseFloat(coordMatch[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      saveSettings({ weatherCity: lat.toFixed(2) + ', ' + lon.toFixed(2), weatherLat: String(lat), weatherLon: String(lon) });
      weatherCoords = { lat: lat, lon: lon, label: SETTINGS.weatherCity };
      if (weatherRefreshFn) weatherRefreshFn();
      return Promise.resolve(true);
    }
  }

  return fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=' + encodeURIComponent(q))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      const hit = d && Array.isArray(d.results) && d.results[0];
      if (!hit) return false;
      const label = hit.name + (hit.country_code ? ', ' + hit.country_code : '');
      saveSettings({ weatherCity: label, weatherLat: String(hit.latitude), weatherLon: String(hit.longitude) });
      weatherCoords = { lat: hit.latitude, lon: hit.longitude, label: label };
      if (weatherRefreshFn) weatherRefreshFn();
      return true;
    })
    .catch(function () { return false; });
}

function clearWeatherLocation() {
  saveSettings({ weatherCity: '', weatherLat: '', weatherLon: '' });
  weatherCoords = null;
  if (weatherRefreshFn) weatherRefreshFn();
}

function setTempUnit(unit) {
  saveSettings({ tempUnit: unit === 'F' ? 'F' : 'C' });
  renderWeatherDOM();
}

/* ══════════════════════════════════════════════════════════════════════════
   13. CINEMATIC IGNITION SEQUENCE (Manual Trigger Only by Default)
   ══════════════════════════════════════════════════════════════════════════ */

function runCinematicStartup() {
  startEngine();
}

/* ══════════════════════════════════════════════════════════════════════════
   14. PERSISTENT SETTINGS STORE, SCHEDULE PERSISTENCE & EVENT BUS
   ══════════════════════════════════════════════════════════════════════════ */

const SETTINGS_KEY = 'nightdrive.settings.v2';
const SCHEDULE_KEY = 'nightdrive.schedule.v1';

const DEFAULT_SETTINGS = {
  clockVisible: true,
  clock24: true,
  clockScale: 100,
  clockOpacity: 88,
  clockOffset: 0,

  mode: 'scenes',
  useDesign: false,
  autoScene: true,
  sceneId: 'night',
  activePack: 'cascade-overlook',
  activeWallpaperId: '',
  activeCarId: 'scene-default',
  preserveCarOnSchedule: true,
  manualResumeMode: 'untilReenabled',
  scheduleBlendMins: 20,

  headlights: null,
  beamIntensity: 75,
  playback: true,
  transitionMs: 1600,

  brightness: 100,
  motion: true,
  particles: true,

  volume: 70,
  muted: false,
  startupEffect: 'manual',
  desktopMusicBar: true,

  drawerEnabled: true,
  drawerPinned: false,

  weatherCity: '',
  weatherLat: '',
  weatherLon: '',
  tempUnit: 'C',

  carFit: 'cover',
  carScale: 100,
  carX: 58,
  carY: 74,
  bgFit: 'cover',
  bgScale: 100,
  bgX: 50,
  bgY: 50,
  bgBrightness: 100
};

function cloneSettings(src) {
  const out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = src[k]; });
  return out;
}

function loadSettings() {
  const base = cloneSettings(DEFAULT_SETTINGS);
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return base;
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return base;
    Object.keys(base).forEach(function (k) {
      const v = parsed[k];
      if (v === undefined) return;
      if (k === 'headlights' && (v === null || typeof v === 'boolean')) { base[k] = v; return; }
      if (typeof base[k] === 'boolean' && typeof v === 'boolean') base[k] = v;
      else if (typeof base[k] === 'number' && typeof v === 'number' && isFinite(v)) base[k] = v;
      else if (typeof base[k] === 'string' && typeof v === 'string') base[k] = v;
    });
  } catch (e) {
    console.warn('[NIGHTDRIVE] settings unreadable, using defaults', e);
  }
  return base;
}

const SETTINGS = loadSettings();
let headlightOverride = SETTINGS.headlights;

function loadSavedSchedule() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) {
      recomputePeriodEnds(SETTINGS.scheduleBlendMins);
      return;
    }
    const raw = localStorage.getItem(SCHEDULE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const seenStarts = new Set();
        PERIODS.forEach(function (p) {
          const val = parsed[p.id];
          if (typeof val === 'number' && val >= 0 && val < 1440 && !seenStarts.has(Math.round(val))) {
            p.start = Math.round(val);
            seenStarts.add(p.start);
          }
        });
      }
    }
  } catch (e) { /* keep default hours */ }
  recomputePeriodEnds(SETTINGS.scheduleBlendMins);
}
loadSavedSchedule();

function saveScheduleHours(hoursMap) {
  if (hoursMap && typeof hoursMap === 'object') {
    const candidate = {};
    const used = new Set();
    let valid = true;
    PERIODS.forEach(function (p) {
      const nextStart = typeof hoursMap[p.id] === 'number' ? Math.round(hoursMap[p.id]) : p.start;
      if (nextStart < 0 || nextStart >= 1440 || used.has(nextStart)) {
        valid = false;
      } else {
        used.add(nextStart);
        candidate[p.id] = nextStart;
      }
    });
    if (!valid) return false;
    PERIODS.forEach(function (p) { p.start = candidate[p.id]; });
  }
  recomputePeriodEnds(SETTINGS.scheduleBlendMins);
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      const payload = {};
      PERIODS.forEach(function (p) { payload[p.id] = p.start; });
      localStorage.setItem(SCHEDULE_KEY, JSON.stringify(payload));
    }
  } catch (e) { /* ignore quota */ }
  if (mode === 'auto') {
    layersOpacity = [-1, -1];
    startRaf();
  }
  emit('schedule', getScheduleSnapshot());
  return true;
}

function resetScheduleHours() {
  PERIODS.forEach(function (p) { p.start = p.defaultStart; });
  saveSettings({ scheduleBlendMins: 20 });
  recomputePeriodEnds(20);
  try {
    if (typeof localStorage !== 'undefined' && localStorage) localStorage.removeItem(SCHEDULE_KEY);
  } catch (e) { /* ignore */ }
  if (mode === 'auto') {
    layersOpacity = [-1, -1];
    startRaf();
  }
  emit('schedule', getScheduleSnapshot());
}

function getScheduleSnapshot() {
  const nowM = minutesNow();
  const activeNow = periodFromMinutes(nowM);
  return {
    auto: mode === 'auto',
    blendMins: SETTINGS.scheduleBlendMins,
    manualResumeMode: SETTINGS.manualResumeMode,
    activeNowId: activeNow ? activeNow.id : 'night',
    periods: PERIODS.map(function (p) {
      return {
        id: p.id,
        label: p.label,
        start: p.start,
        end: p.end % 1440,
        startHHMM: formatMinutesHHMM(p.start),
        endHHMM: formatMinutesHHMM(p.end % 1440),
        headlights: p.headlights
      };
    })
  };
}

function saveSettings(patch) {
  if (patch) {
    Object.keys(patch).forEach(function (k) {
      if (k in DEFAULT_SETTINGS) SETTINGS[k] = patch[k];
    });
  }
  if (patch && 'scheduleBlendMins' in patch) {
    recomputePeriodEnds(SETTINGS.scheduleBlendMins);
  }
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS));
    }
  } catch (e) {
    emit('storage-error', { message: 'Settings could not be saved (storage full or blocked).' });
  }
  emit('settings', SETTINGS);
  return SETTINGS;
}

function resetSettings() {
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { SETTINGS[k] = DEFAULT_SETTINGS[k]; });
  headlightOverride = null;
  activeSingleWallpaper = null;
  activeStudioCar = null;
  studioWallpaperOverrides = {};
  resetScheduleHours();
  try {
    if (typeof localStorage !== 'undefined' && localStorage) localStorage.removeItem(SETTINGS_KEY);
  } catch (e) { /* ignore */ }
  setCar(null);
  setBackground(null);
  applySavedAppearance();
  setAutoScene(true);
  emit('settings', SETTINGS);
}

const listeners = {};
function on(evt, fn) {
  (listeners[evt] || (listeners[evt] = [])).push(fn);
  return function off() {
    listeners[evt] = (listeners[evt] || []).filter(function (f) { return f !== fn; });
  };
}
function emit(evt, data) {
  (listeners[evt] || []).forEach(function (fn) {
    try { fn(data); } catch (e) { console.warn('[NIGHTDRIVE] listener failed', e); }
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   15. SKYLINE GEOMETRY & SKY-SAFE CLOCK CLAMPING (Never Clips Digits)
   ══════════════════════════════════════════════════════════════════════════ */

const RIDGES_URL = 'assets/ridges.json';
const STUDIO_CATALOG_URL = 'assets/studio-catalog.json';
let RIDGES = null;

function loadRidges() {
  const xhr = new XMLHttpRequest();
  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        const data = JSON.parse(xhr.responseText);
        if (data && typeof data === 'object') {
          RIDGES = data;
          emit('ridges', RIDGES);
          refreshDepth();
        }
      } catch (e) { console.warn('[NIGHTDRIVE] ridge data invalid', e); }
    }
  };
  xhr.onerror = function () {};
  xhr.open('GET', RIDGES_URL, true);
  xhr.send();
}

function loadStudioCatalog() {
  const xhr = new XMLHttpRequest();
  xhr.onload = function () {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        const data = JSON.parse(xhr.responseText);
        if (data && typeof data === 'object') {
          STUDIO_CATALOG = data;
          hydrateStudioStateFromSettings();
          emit('catalog', STUDIO_CATALOG);
        }
      } catch (e) { console.warn('[NIGHTDRIVE] studio catalog invalid', e); }
    }
  };
  xhr.onerror = function () {};
  xhr.open('GET', STUDIO_CATALOG_URL, true);
  xhr.send();
}

function ridgeFor(periodId) {
  if (!RIDGES || !RIDGES[periodId]) return null;
  const r = RIDGES[periodId];
  return r && Array.isArray(r.ridge) && r.ridge.length > 1 ? r : null;
}

function ridgeAt(ridge, x) {
  if (!ridge || !ridge.length) return 0.6;
  const clamped = Math.max(0, Math.min(1, x));
  for (let i = 0; i < ridge.length - 1; i++) {
    const x0 = ridge[i][0], y0 = ridge[i][1];
    const x1 = ridge[i + 1][0], y1 = ridge[i + 1][1];
    if (clamped >= x0 && clamped <= x1) {
      const t = x1 === x0 ? 0 : (clamped - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return ridge[ridge.length - 1][1];
}

function ridgePolygon(ridge) {
  const pts = ridge.map(function (p) { return (p[0] * 100).toFixed(3) + '% ' + (p[1] * 100).toFixed(3) + '%'; });
  return 'polygon(0% 100%, ' + pts.join(', ') + ', 100% 100%)';
}

function plateRect(iw, ih, vw, vh, fx, fy) {
  const scale = Math.max(vw / iw, vh / ih);
  const w = iw * scale;
  const h = ih * scale;
  return { left: (vw - w) * fx, top: (vh - h) * fy, width: w, height: h };
}

function plateRectContain(iw, ih, vw, vh) {
  const scale = Math.min(vw / iw, vh / ih);
  const w = iw * scale;
  const h = ih * scale;
  return { left: (vw - w) / 2, top: (vh - h) / 2, width: w, height: h };
}

function focusFor(periodId) {
  const studioWp = activeSingleWallpaper || resolvePeriodStudioWallpaper(periodId);
  const focusArr = (studioWp && studioWp.focus) || (SCENE_ASSETS[periodId] && SCENE_ASSETS[periodId].focus);
  if (!focusArr) return [0.62, 0.74];
  return focusArr.map(function (v) { return parseFloat(v) / 100; });
}

const fgA = document.querySelector('[data-fg="a"]');
const fgB = document.querySelector('[data-fg="b"]');
const clockEl = document.getElementById('clock');
const stageEl = document.getElementById('stage');
const fgPeriods = { a: null, b: null };

function fgForLayer(layer) { return layer === layerA ? fgA : (layer === layerB ? fgB : null); }

function applyForegroundFor(layer, periodId) {
  applyCarToLayer(layer, periodId);
  const img = fgForLayer(layer);
  if (!img) return;
  // Foreground occlusion is disabled so mountain silhouettes never cut clock digits.
  img.classList.remove('is-active');
  img.removeAttribute('src');
  fgPeriods[layer === layerA ? 'a' : 'b'] = null;
}

function layoutForeground(img, periodId, layer) {
  const data = ridgeFor(periodId);
  if (!data) return;
  const iw = img.naturalWidth || 1376;
  const ih = img.naturalHeight || 768;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const f = focusFor(periodId);
  const contained = layer && layer.classList && layer.classList.contains('layer--contain');
  const rect = contained ? plateRectContain(iw, ih, vw, vh) : plateRect(iw, ih, vw, vh, f[0], f[1]);
  img.style.left = rect.left.toFixed(2) + 'px';
  img.style.top = rect.top.toFixed(2) + 'px';
  img.style.width = rect.width.toFixed(2) + 'px';
  img.style.height = rect.height.toFixed(2) + 'px';
  img.style.clipPath = ridgePolygon(data.ridge);
}

function syncForegroundOpacity(a, b) {
  if (fgA) fgA.style.opacity = String(a);
  if (fgB) fgB.style.opacity = String(b);
}

/**
 * Place the sky clock centered horizontally and clamped strictly ABOVE the
 * highest mountain/skyline silhouette across x ∈ [0.30, 0.70] so every digit
 * remains 100% visible at 1366x768, 1920x1080, 1440p, 4K, and ultrawide.
 */
function placeClock(periodId) {
  if (!clockEl) return;
  const vw = Math.max(320, window.innerWidth || 1920);
  const vh = Math.max(320, window.innerHeight || 1080);
  const scale = (SETTINGS.clockScale || 100) / 100;

  // Estimate full date + tall numeral bounding height in px
  const numPx = Math.min(148, Math.max(78, vw * 0.118)) * scale;
  const datePx = Math.min(20, Math.max(14, vw * 0.0132)) * scale;
  const halfBoxH = (numPx * 0.90 + datePx + 10) * 0.5;

  let skylineNorm = 0.56;
  const studioWp = activeSingleWallpaper || resolvePeriodStudioWallpaper(periodId);
  if (customBackdrop) {
    skylineNorm = 0.44;
  } else if (studioWp && typeof studioWp.ridgeMinY === 'number') {
    skylineNorm = studioWp.ridgeMinY;
  } else {
    const data = ridgeFor(periodId);
    if (data && Array.isArray(data.ridge)) {
      let minR = 1;
      for (let x = 0.30; x <= 0.70; x += 0.04) {
        minR = Math.min(minR, ridgeAt(data.ridge, x));
      }
      skylineNorm = minR;
    }
  }

  const f = focusFor(periodId);
  const rect = plateRect(1376, 768, vw, vh, f[0], f[1]);
  const skylineViewportY = customBackdrop ? (vh * skylineNorm) : (rect.top + skylineNorm * rect.height);

  // Target aesthetic sky center (~22.5% from top, matching image-1.png), shifted
  // by user offset, then clamped between top screen margin and skyline - 22px!
  const desiredY = vh * 0.225 + (SETTINGS.clockOffset / 100) * vh;
  const minSafeCenterY = 22 + halfBoxH;
  const maxSafeCenterY = Math.max(minSafeCenterY, skylineViewportY - halfBoxH - 22);
  const finalCenterY = Math.max(minSafeCenterY, Math.min(maxSafeCenterY, desiredY));

  clockEl.style.setProperty('--clock-x', '50%');
  clockEl.style.setProperty('--clock-y', finalCenterY.toFixed(1) + 'px');
}

const BRIGHT_PERIODS = { day: true, goldenHour: true, morning: true };

function applyClockChrome(periodId) {
  const bright = !!BRIGHT_PERIODS[periodId];
  if (clockEl) clockEl.classList.toggle('is-bright', bright);
  document.body.classList.toggle('scene-bright', bright);
}

function refreshDepth() {
  const periodId = currentId || layerAId || (SETTINGS.sceneId || 'night');
  placeClock(periodId);
  applyClockChrome(periodId);
}

/* ══════════════════════════════════════════════════════════════════════════
   16. APPEARANCE, AUDIO, HEADLIGHTS & STUDIO COMPOSITING ACTIONS
   ══════════════════════════════════════════════════════════════════════════ */

function applyClockSettings() {
  if (!clockEl) return;
  clockEl.classList.toggle('is-hidden', !SETTINGS.clockVisible);
  clockEl.style.setProperty('--clock-scale', String(SETTINGS.clockScale / 100));
  clockEl.style.setProperty('--clock-opacity', String(SETTINGS.clockOpacity / 100));
  updateHUD();
  refreshDepth();
}

function applyBrightness() {
  const level = Math.max(0.4, Math.min(1.1, SETTINGS.brightness / 100));
  document.documentElement.style.setProperty('--stage-brightness', level.toFixed(3));
}

function applyDesktopMusicBarVisibility() {
  const bar = document.getElementById('stage-music-bar');
  if (bar) bar.classList.toggle('is-hidden', SETTINGS.desktopMusicBar === false);
}

function applySavedAppearance() {
  applyClockSettings();
  applyBrightness();
  applyAudioSettings();
  applyDesktopMusicBarVisibility();
  if (SETTINGS.mode === 'scenes' && SETTINGS.autoScene === false) {
    mode = 'manual';
    stopRaf();
    const p = periodById(SETTINGS.sceneId) || periodById('night');
    if (p) showPeriodManual(p, true);
  }
  if (SETTINGS.playback === false) setPlayback(false);
  if (SETTINGS.motion === false) stopParticles();
  emit('ready', null);
}

function engineAudioEl() { return document.getElementById('engine-audio'); }

function applyAudioSettings() {
  const vol = SETTINGS.muted ? 0 : Math.max(0, Math.min(1, SETTINGS.volume / 100));
  const audio = engineAudioEl();
  if (audio) audio.volume = vol;
  if (musicAudioEl) musicAudioEl.volume = vol;
}

function setVolume(pct) {
  const value = Math.max(0, Math.min(100, Math.round(pct)));
  saveSettings({ volume: value });
  if (SETTINGS.muted && value > 0) saveSettings({ muted: false });
  applyAudioSettings();
  if (PLATFORM.webview2 && nativeHostActive) postToHost('set_volume:' + value);
  emit('volume', value);
}

function setMuted(muted) {
  saveSettings({ muted: !!muted });
  applyAudioSettings();
  if (PLATFORM.webview2 && nativeHostActive) postToHost('set_mute:' + (muted ? 1 : 0));
  emit('muted', !!muted);
}

function setPlayback(playing) {
  saveSettings({ playback: !!playing });
  if (playing) {
    if (mode === 'auto') startRaf();
    if (SETTINGS.particles && SETTINGS.motion) startParticles();
  } else {
    stopRaf();
    particlesRunning = false;
  }
  emit('playback', !!playing);
}

function setHeadlights(value) {
  headlightOverride = value;
  saveSettings({ headlights: value });
  [layerA, layerB].forEach(function (layer) {
    if (!layer) return;
    const pid = layer.dataset.periodId || currentId || 'night';
    const op = headlightOpacityFor(pid);
    setHeadlightOpacity(layer, op);
  });
  setHeadlightMix(headlightOpacityFor(currentId || 'night') / HEADLIGHT_OPACITY);
  drawStudioCarBeams();
  emit('headlights', value);
}

function setBeamIntensity(pct) {
  const val = Math.max(20, Math.min(100, Math.round(pct)));
  saveSettings({ beamIntensity: val });
  setHeadlights(headlightOverride);
}

/* ── Car Studio & Custom Layer Compositing ──────────────────────────────── */

let customCar = null;
let customBackdrop = null;
let customDesign = null;

function canCompositeCarOnLayer(layer) {
  if (!customCar || !customCar.src) return false;
  // Direct custom imports or explicit override (`forceComposite: true`) always composite;
  // Studio catalog cars composite ONLY onto car-free (`supportsCarOverlay: true`) plates
  // so two vehicles are never stacked on top of Cascade Overlook's photographed car.
  if (customCar.forceComposite) return true;
  if (customBackdrop) return true;
  return !!(layer && layer.dataset.supportsCar === '1');
}

function applyCarToLayer(layer, periodId) {
  if (!layer) return;
  const img = layer.querySelector('.car-img');
  if (!img) return;
  if (!canCompositeCarOnLayer(layer)) {
    if (layer.dataset.customCar === '1') {
      img.removeAttribute('src');
      img.classList.remove('is-loaded');
      img.style.transform = '';
      img.style.filter = '';
      layer.classList.remove('layer--has-car');
      layer.dataset.customCar = '0';
    }
    return;
  }

  layer.dataset.customCar = '1';
  img.style.setProperty('--car-fit', customCar.fit === 'contain' ? 'contain' : 'cover');
  const posValue = customCar.stageLocked
    ? (layer.style.getPropertyValue('--focus') || '58% 68%')
    : (customCar.x + '% ' + customCar.y + '%');
  img.style.setProperty('--car-position', posValue);
  img.style.transform = customCar.scale && customCar.scale !== 100
    ? ('scale(' + (customCar.scale / 100) + ')')
    : '';
  img.style.transformOrigin = '68% 72%';
  img.style.filter = carPeriodFilter(periodId || layer.dataset.periodId || currentId);
  if (img.getAttribute('src') !== customCar.src) img.src = customCar.src;
  img.classList.add('is-loaded');
  layer.classList.add('layer--has-car');
}

function setCar(asset, opts) {
  const o = opts || {};
  customCar = asset && asset.src ? {
    src: asset.src,
    fit: o.fit || SETTINGS.carFit,
    scale: o.scale || SETTINGS.carScale,
    x: typeof o.x === 'number' ? o.x : SETTINGS.carX,
    y: typeof o.y === 'number' ? o.y : SETTINGS.carY,
    stageLocked: !!o.stageLocked,
    forceComposite: o.forceComposite !== false
  } : null;
  if (!customCar) activeStudioCar = null;
  [layerA, layerB].forEach(function (layer) {
    applyCarToLayer(layer, layer ? layer.dataset.periodId : currentId);
  });
  drawStudioCarBeams();
  emit('car', customCar);
}

function selectStudioCar(carId, opts) {
  const o = opts || {};
  if (!STUDIO_CATALOG || !Array.isArray(STUDIO_CATALOG.cars)) return false;
  const entry = STUDIO_CATALOG.cars.find(function (c) { return c.id === carId; });
  if (!entry || !entry.overlaySrc) {
    activeStudioCar = null;
    saveSettings({ activeCarId: 'scene-default' });
    setCar(null);
    return true;
  }

  activeStudioCar = entry;
  saveSettings({ activeCarId: entry.id });

  // Coherent compositing guarantee: if the active pack is an integrated-car pack
  // (Cascade Overlook) and no car-free wallpaper is active, automatically switch
  // to the matching Scenic Touring car-free pack when requested (`autoSwitchPack !== false`)
  // so two cars never stack!
  const curSupports = activeSingleWallpaper
    ? activeSingleWallpaper.supportsCarOverlay
    : (SETTINGS.activePack === 'scenic-touring');

  if (!curSupports && !customBackdrop && o.autoSwitchPack !== false) {
    activeSingleWallpaper = null;
    saveSettings({ activePack: 'scenic-touring', activeWallpaperId: '' });
  }

  customCar = {
    src: entry.overlaySrc,
    fit: 'cover',
    scale: SETTINGS.carScale || 100,
    x: SETTINGS.carX || 58,
    y: SETTINGS.carY || 74,
    stageLocked: true,
    forceComposite: false
  };

  reloadActiveScenes();
  emit('car', customCar);
  return true;
}

function useWallpaperPack(packId) {
  if (packId !== 'cascade-overlook' && packId !== 'scenic-touring') return false;
  activeSingleWallpaper = null;
  customBackdrop = null;
  setBackground(null);

  // If switching back to Cascade Overlook (which has an integrated Challenger),
  // clear any transparent Car Studio overlay unless user explicitly re-picks one.
  if (packId === 'cascade-overlook') {
    activeStudioCar = null;
    customCar = null;
    saveSettings({ activePack: packId, activeWallpaperId: '', activeCarId: 'scene-default', mode: 'scenes' });
  } else {
    saveSettings({ activePack: packId, activeWallpaperId: '', mode: 'scenes' });
  }

  reloadActiveScenes();
  emit('pack', packId);
  return true;
}

function applyStudioWallpaper(wp, opts) {
  if (!wp || !wp.src) return false;
  const o = opts || {};
  customBackdrop = null;
  setBackground(null);

  activeSingleWallpaper = wp;
  const targetPeriod = periodById(wp.period) ? wp.period : (currentId || 'night');

  // Respect coherent car compositing: never overlay a second car onto an integrated-car scene.
  if (!wp.supportsCarOverlay && activeStudioCar) {
    // Keep activeStudioCar remembered if preserveCarOnSchedule is on, while hiding
    // it cleanly on this incompatible scene (`canCompositeCarOnLayer` returns false).
  }

  saveSettings({
    mode: 'scenes',
    autoScene: o.keepAuto ? SETTINGS.autoScene : false,
    sceneId: targetPeriod,
    activeWallpaperId: wp.id || ''
  });

  if (!o.keepAuto) {
    mode = 'manual';
    manualOriginScheduleId = (periodFromMinutes(minutesNow()) || {}).id || null;
    stopRaf();
  }

  assetsCache = {};
  assetsReady = {};
  const p = periodById(targetPeriod) || PERIODS[4];
  showPeriodManual(p, !!o.instant);
  emit('wallpaper', wp);
  emit('scene', { auto: mode === 'auto', id: p.id });
  return true;
}

function reloadActiveScenes() {
  assetsCache = {};
  assetsReady = {};
  if (mode === 'auto') {
    layerAId = null;
    layerBId = null;
    layersOpacity = [-1, -1];
    startRaf();
  } else {
    const p = periodById(currentId || SETTINGS.sceneId || 'night');
    if (p) showPeriodManual(p, true);
  }
}

function hydrateStudioStateFromSettings() {
  if (!STUDIO_CATALOG) return;
  if (SETTINGS.activeCarId && SETTINGS.activeCarId !== 'scene-default') {
    const foundCar = (STUDIO_CATALOG.cars || []).find(function (c) { return c.id === SETTINGS.activeCarId; });
    if (foundCar && foundCar.overlaySrc) {
      activeStudioCar = foundCar;
      customCar = {
        src: foundCar.overlaySrc,
        fit: 'cover',
        scale: SETTINGS.carScale || 100,
        x: SETTINGS.carX || 58,
        y: SETTINGS.carY || 74,
        stageLocked: true,
        forceComposite: false
      };
    }
  }
  if (SETTINGS.activeWallpaperId) {
    const foundWp = (STUDIO_CATALOG.wallpapers || []).find(function (w) { return w.id === SETTINGS.activeWallpaperId; });
    if (foundWp) activeSingleWallpaper = foundWp;
  }
  reloadActiveScenes();
}

function setBackground(asset, opts) {
  const o = opts || {};
  customBackdrop = asset && asset.src ? {
    src: asset.src,
    fit: o.fit || SETTINGS.bgFit,
    scale: o.scale || SETTINGS.bgScale,
    x: typeof o.x === 'number' ? o.x : SETTINGS.bgX,
    y: typeof o.y === 'number' ? o.y : SETTINGS.bgY,
    brightness: o.brightness || SETTINGS.bgBrightness
  } : null;
  const el = document.getElementById('custom-bg');
  if (!el) return;
  if (customBackdrop) {
    el.src = customBackdrop.src;
    el.style.setProperty('--bg-fit', customBackdrop.fit === 'contain' ? 'contain' : 'cover');
    el.style.setProperty('--bg-position', customBackdrop.x + '% ' + customBackdrop.y + '%');
    el.style.setProperty('--bg-scale', String(customBackdrop.scale / 100));
    el.style.setProperty('--bg-brightness', String(customBackdrop.brightness / 100));
    if (stageEl) stageEl.classList.add('is-custom');
    if (clockEl) clockEl.classList.add('is-bright');
    refreshDepth();
  } else {
    el.removeAttribute('src');
    if (stageEl) stageEl.classList.remove('is-custom');
    refreshDepth();
  }
  emit('background', customBackdrop);
}

function setDesign(asset) {
  setBackground(asset && asset.src ? { src: asset.src } : null, { fit: 'cover', scale: 100, x: 50, y: 50, brightness: 100 });
  customDesign = asset || null;
  saveSettings({ mode: customDesign ? 'custom' : 'scenes' });
  emit('design', customDesign);
}

/* ── Engine Start ───────────────────────────────────────────────────────── */

function startEngine(opts) {
  const silent = opts && opts.silent;
  const audio = engineAudioEl();
  if (audio && !silent) {
    audio.volume = SETTINGS.muted ? 0 : Math.max(0, Math.min(1, SETTINGS.volume / 100));
    try { audio.currentTime = 0; } catch (e) { /* ignore */ }
    const p = audio.play();
    if (p && p.catch) p.catch(function () { emit('audio-blocked', null); });
  }
  if (REDUCED_MOTION.matches || SETTINGS.motion === false) {
    emit('engine', { animated: false });
    return;
  }
  [layerA, layerB].forEach(function (layer) {
    if (!layer) return;
    const hlImg = layer.querySelector('.headlight-img');
    const svgHl = layer.querySelector('.svg-headlights');
    [hlImg, svgHl].forEach(function (el) {
      if (!el) return;
      el.classList.remove('headlight-flare');
      void el.offsetWidth;
      el.classList.add('headlight-flare');
      setTimeout(function () { el.classList.remove('headlight-flare'); }, 1200);
    });
  });
  if (clockEl) {
    clockEl.classList.remove('clock-start');
    void clockEl.offsetWidth;
    clockEl.classList.add('clock-start');
    setTimeout(function () { clockEl.classList.remove('clock-start'); }, 1400);
  }
  emit('engine', { animated: true });
}

function maybeAutoStartup() {
  const pref = SETTINGS.startupEffect;
  if (pref === 'always') { startEngine(); return; }
  if (pref === 'once') {
    let seen = false;
    try { seen = sessionStorage.getItem('nightdrive.started') === '1'; } catch (e) { seen = false; }
    if (!seen) {
      try { sessionStorage.setItem('nightdrive.started', '1'); } catch (e) {}
      startEngine();
    }
  }
}

/* ── Scene & Schedule Controls ──────────────────────────────────────────── */

function setAutoScene(enabled) {
  activeSingleWallpaper = null;
  manualOriginScheduleId = null;
  if (enabled) {
    saveSettings({ autoScene: true, activeWallpaperId: '', mode: 'scenes' });
    setBackground(null);
    mode = 'auto';
    setModeAuto();
  } else {
    const keepId = currentId || layerAId || SETTINGS.sceneId || 'night';
    saveSettings({ autoScene: false, sceneId: keepId });
    mode = 'manual';
    manualOriginScheduleId = (periodFromMinutes(minutesNow()) || {}).id || null;
    stopRaf();
    const p = periodById(keepId);
    if (p) showPeriodManual(p, true);
  }
  emit('scene', { auto: mode === 'auto', id: currentId || layerAId || SETTINGS.sceneId });
}

function stepScene(direction) {
  activeSingleWallpaper = null;
  const order = PERIODS.map(function (p) { return p.id; });
  const id = currentId || layerAId || SETTINGS.sceneId || 'night';
  const idx = Math.max(0, order.indexOf(id));
  const next = order[(idx + (direction || 1) + order.length) % order.length];
  setScene(next);
}

function setScene(id) {
  const p = periodById(id);
  if (!p) return;
  activeSingleWallpaper = null;
  if (!SETTINGS.preserveCarOnSchedule && activeStudioCar) {
    activeStudioCar = null;
    customCar = null;
    saveSettings({ activeCarId: 'scene-default' });
  }
  saveSettings({ autoScene: false, sceneId: id, activeWallpaperId: '', mode: 'scenes' });
  setBackground(null);
  mode = 'manual';
  manualOriginScheduleId = (periodFromMinutes(minutesNow()) || {}).id || null;
  stopRaf();
  showPeriodManual(p, false);
  emit('scene', { auto: false, id: id });
}

document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    stopRaf();
    particlesRunning = false;
  } else if (SETTINGS.playback) {
    if (mode === 'auto') startRaf();
    if (SETTINGS.particles && SETTINGS.motion) startParticles();
    updateHUD();
    applySavedAppearance();
  }
});

window.addEventListener('resize', function () {
  refreshDepth();
  layoutForegroundBoth();
});

function layoutForegroundBoth() {
  if (fgA && fgPeriods.a) layoutForeground(fgA, fgPeriods.a, layerA);
  if (fgB && fgPeriods.b) layoutForeground(fgB, fgPeriods.b, layerB);
}

function exitApp() {
  if (PLATFORM.tauri && window.__TAURI__ && window.__TAURI__.window) {
    try { window.__TAURI__.window.getCurrent().close(); return; } catch (e) {}
  }
  if (postToHost('quit')) return;
  if (typeof window.close === 'function') window.close();
  setTimeout(function () { emit('exit-blocked', null); }, 120);
}

/* ── Boot Sequence ──────────────────────────────────────────────────────── */

function boot() {
  const initM = minutesNow();
  const initBlend = computeBlend(initM);

  layerAId = initBlend.from;
  layerBId = initBlend.to;
  currentId = initBlend.to;

  return Promise.all([
    ensureLayerPopulated(layerA, initBlend.from),
    ensureLayerPopulated(layerB, initBlend.to)
  ]).then(function () {
    logToHost('6. First actual engine frame (assets fetched and painted)');
    if (PLATFORM.webview2) {
      window.chrome.webview.postMessage(JSON.stringify({ action: 'hide_fallback' }));
    }

    updateHUD();
    clockTimer = setInterval(updateHUD, CLOCK_MS);
    logToHost('7. Essential widgets becoming visible');

    initBattery();
    initWeather();
    initParticles();
    startParticles();
    logToHost('8. Optional features becoming ready');

    if (SETTINGS.autoScene !== false) {
      setModeAuto();
    }
    applySavedAppearance();
    maybeAutoStartup();
  });
}

/* ── Public API consumed by app.js ──────────────────────────────────────── */

window.ND = {
  platform: PLATFORM,
  periods: PERIODS,
  settings: SETTINGS,
  defaults: DEFAULT_SETTINGS,
  on: on,
  emit: emit,
  save: saveSettings,
  reset: resetSettings,
  state: function () {
    return {
      sceneId: currentId || layerAId || SETTINGS.sceneId,
      auto: mode === 'auto',
      playing: SETTINGS.playback,
      headlights: headlightOverride,
      clock24: SETTINGS.clock24,
      hasRidges: !!RIDGES,
      activePack: SETTINGS.activePack,
      activeWallpaper: activeSingleWallpaper,
      activeCar: activeStudioCar
    };
  },
  catalog: function () { return STUDIO_CATALOG; },
  telemetry: function () { return telemetryState; },
  mediaState: function () { return MEDIA; },
  getSchedule: getScheduleSnapshot,
  saveScheduleHours: saveScheduleHours,
  resetScheduleHours: resetScheduleHours,
  formatMinutesHHMM: formatMinutesHHMM,
  parseHHMMToMinutes: parseHHMMToMinutes,
  setScene: setScene,
  stepScene: stepScene,
  setAutoScene: setAutoScene,
  setHeadlights: setHeadlights,
  setBeamIntensity: setBeamIntensity,
  setPlayback: setPlayback,
  setVolume: setVolume,
  setMuted: setMuted,
  applyAudioSettings: applyAudioSettings,
  applyClockSettings: applyClockSettings,
  applyBrightness: applyBrightness,
  applyDesktopMusicBarVisibility: applyDesktopMusicBarVisibility,
  placeClock: placeClock,
  setCar: setCar,
  selectStudioCar: selectStudioCar,
  useWallpaperPack: useWallpaperPack,
  applyStudioWallpaper: applyStudioWallpaper,
  setBackground: setBackground,
  setDesign: setDesign,
  mediaPlayPause: mediaPlayPause,
  mediaNext: mediaNext,
  mediaPrev: mediaPrev,
  mediaSeek: mediaSeek,
  loadLocalAudio: loadLocalAudio,
  refreshWeather: function () { return weatherRefreshFn ? weatherRefreshFn() : Promise.resolve(); },
  setWeatherLocation: setWeatherLocation,
  clearWeatherLocation: clearWeatherLocation,
  setTempUnit: setTempUnit,
  startEngine: startEngine,
  exit: exitApp,
  openSystemSettings: openSystemSettings,
  postToHost: postToHost,
  hostActive: function () { return nativeHostActive; },
  reducedMotion: REDUCED_MOTION,
  notify: function (msg) { emit('toast', msg); }
};

if (layerA) layerA.style.transition = 'none';
if (layerB) layerB.style.transition = 'none';

loadRidges();
loadStudioCatalog();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
