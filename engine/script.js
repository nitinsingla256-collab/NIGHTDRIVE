/**
 * NIGHTDRIVE — Phase 3
 * Reads the computer's local clock. No APIs, no frameworks, no build step.
 *
 * New in Phase 3:
 *  - Live HUD clock, date, weekday (updated every second via setInterval).
 *  - Battery widget — Battery Status API with honest fallback.
 *  - Gradual environment transitions:
 *      Each period has a configurable overlap window with its neighbour.
 *      A requestAnimationFrame loop continuously computes the blend ratio
 *      and sets layer opacities directly, so the change is always smooth
 *      and proportional to the actual wall-clock time.
 *      Headlight opacity also fades in/out across the dusk boundary.
 *  - Colour-temperature overlay: warms/cools the overall scene per-period.
 *
 * Architecture:
 *  - layerA / layerB always hold the two adjacent scene images.
 *  - The rAF loop sets their opacities to (1-t) and t where t ∈ [0,1].
 *  - When the blend completes (t ≥ 1.0) we "commit" and swap the buffers.
 *  - Manual mode bypasses the rAF loop and uses a plain CSS crossfade.
 */

/**
 * Startup tracing for the native hosts. PLATFORM is declared further down
 * with `const`, so this function must only ever be *called* after that
 * declaration has been evaluated (TDZ — calling it earlier used to throw a
 * fatal ReferenceError and stop the whole engine from booting).
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

/* ══════════════════════════════════════════════
   PLATFORM DETECTION & HOST BRIDGE
   Works in: plain browsers (desktop/mobile), Windows WebView2 host,
   macOS WKWebView host, Linux Qt host, Tauri.
   ══════════════════════════════════════════════ */

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
    // Native NightdriveHost (WebView2). Tauri on Windows also uses WebView2, so exclude it.
    webview2: !!(window.chrome && window.chrome.webview) && !window.__TAURI__,
    wkhost: !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.nightdrive),
    touch: ('ontouchstart' in window) || navigator.maxTouchPoints > 0
  };
})();

// Safe to trace now that PLATFORM exists.
logToHost("5. HTML engine loading (script.js executing)");
document.documentElement.classList.toggle('is-touch', PLATFORM.touch);

const REDUCED_MOTION = window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: false };

/** Send an action to whichever native host is embedding us. Returns true if handled. */
// Set to true once a native host actually talks to us (WebView2 is also used
// by generic wallpaper apps such as Lively, which don't answer messages).
let nativeHostActive = false;
if (PLATFORM.webview2) {
  window.chrome.webview.addEventListener('message', function () { nativeHostActive = true; });
}

function postToHost(action) {
  const msg = JSON.stringify({ action: action });
  if (PLATFORM.webview2) { window.chrome.webview.postMessage(msg); return nativeHostActive; }
  if (PLATFORM.wkhost) { window.webkit.messageHandlers.nightdrive.postMessage(msg); return true; }
  return false;
}

/**
 * Open the OS settings page for a control (wifi | bt | sound | focus).
 * Native hosts handle it; in a plain browser we only try URL schemes
 * the current OS actually understands, otherwise do nothing.
 */
const SETTINGS_URLS = {
  windows: { wifi: 'ms-settings:network-wifi', bt: 'ms-settings:bluetooth', sound: 'ms-settings:sound', focus: 'ms-settings:quiethours' }
};
SETTINGS_URLS.mac = {
  wifi: 'x-apple.systempreferences:com.apple.preference.network',
  bt: 'x-apple.systempreferences:com.apple.preferences.Bluetooth',
  sound: 'x-apple.systempreferences:com.apple.preference.sound',
  focus: 'x-apple.systempreferences:com.apple.preference.notifications'
};
function openSystemSettings(kind) {
  if (postToHost('open_' + kind + '_settings')) return;
  const table = PLATFORM.windows ? SETTINGS_URLS.windows : (PLATFORM.mac ? SETTINGS_URLS.mac : null);
  if (PLATFORM.tauri && table && table[kind] && window.__TAURI__.shell) {
    window.__TAURI__.shell.open(table[kind]).catch(() => {});
    return;
  }
  if (PLATFORM.windows && SETTINGS_URLS.windows[kind]) {
    const a = document.createElement('a');
    a.href = SETTINGS_URLS.windows[kind];
    a.rel = 'noopener';
    a.click();
  }
}

/* ══════════════════════════════════════════════
   CONFIGURATION
   ══════════════════════════════════════════════ */

/**
 * PERIODS — time brackets in minutes from midnight.
 * Night wraps past 00:00 (start > end).
 *
 * transitionMins: how many minutes BEFORE the period's START boundary
 *   the blend begins.  During this window the previous scene fades out
 *   and this scene fades in linearly.
 *   e.g. dusk.start = 18:30, dusk.transitionMins = 30
 *     → blend begins at 18:00, complete at 18:30.
 */
const PERIODS = [
  {
    id: 'morning',
    label: 'Morning',
    start: 5 * 60,
    end: 9 * 60,
    transitionMins: 20,    // blend starts 20 min before 05:00
    headlights: false,
    hlFade: false,         // headlights fade in this period?  No.
    accent: '#a8c4d0',
    accentDim: '#4a7080',
    ctColor: 'rgba(150,190,235,0.00)',  // colour-temperature tint (soft-light)
  },
  {
    id: 'day',
    label: 'Day',
    start: 9 * 60,
    end: 16 * 60,
    transitionMins: 20,
    headlights: false,
    hlFade: false,
    accent: '#b8cce0',
    accentDim: '#4a6880',
    ctColor: 'rgba(255,252,244,0.00)',
  },
  {
    id: 'goldenHour',
    label: 'Golden Hour',
    start: 16 * 60,
    end: 18 * 60 + 30,
    transitionMins: 20,
    headlights: false,
    hlFade: false,
    accent: '#e8a040',
    accentDim: '#8a5018',
    ctColor: 'rgba(214,160,92,0.09)',   // warm amber tint (the plate is already warm)
  },
  {
    id: 'dusk',
    label: 'Dusk',
    start: 18 * 60 + 30,
    end: 20 * 60,
    transitionMins: 20,
    headlights: true,
    hlFade: true,          // headlights fade IN during this period
    accent: '#b87890',
    accentDim: '#703050',
    ctColor: 'rgba(118,92,146,0.14)',   // cool violet tint
  },
  {
    id: 'night',
    label: 'Night',
    start: 20 * 60,
    end: 24 * 60,
    transitionMins: 20,
    headlights: true,
    hlFade: false,
    accent: '#c49a4a',
    accentDim: '#7a5f28',
    ctColor: 'rgba(74,104,158,0.16)',   // cool blue-night tint
  },
  {
    id: 'midnight',
    label: 'Midnight',
    start: 0,
    end: 5 * 60,
    transitionMins: 20,
    headlights: true,
    hlFade: false,
    accent: '#708090',
    accentDim: '#405060',
    ctColor: 'rgba(44,62,104,0.18)',    // deeper blue-night tint
  }
];

/**
 * SCENE ASSETS — one entry per period, with the car/landscape decoupling that
 * a future customisation phase needs.
 *
 *   landscape  ordered candidate list for the wide plate (16:9-ish).
 *   portrait   optional tall version shown on portrait displays. When absent
 *              the engine falls back to `landscape` and presents it on its own
 *              blurred backdrop rather than stretching or blind-cropping it
 *              (see .scene-img--contain in styles.css).
 *   cursor     optional independent car layer (transparent PNG/WebP) drawn on
 *              top of the plate. Empty today: the car is part of the plate.
 *   focus      the car's position in the plate as a percentage pair. Used as
 *              object-position so portrait/narrow viewports crop toward the
 *              car instead of the middle of the valley.
 *
 * `scene` is kept as the resolved landscape list so existing hosts, the
 * service worker and the test suite keep working unchanged.
 */
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

/**
 * ASSETS — the shape the rest of the engine consumes.
 * `scene` is the landscape list; `headlights` is unchanged. Derived rather
 * than duplicated so the two can never drift apart.
 */
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

const CLOCK_MS = 1000;   // HUD clock update interval
const SCENE_MS = 15000;  // how often manual-mode re-checks in auto; also blend tick in auto
const TRANSITION_MS = 1600;   // CSS manual crossfade duration (manual-mode only)
const LABEL_SHOW_MS = 3200;   // how long the scene-label overlay stays visible

/* ══════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════ */

let mode = 'auto';
let currentId = null;      // the period shown in layerA (front buffer)
let nextId = null;      // the period loading/blending into layerB (back buffer)
let frontIsA = true;
let transitioning = false;
let pendingId = null;

// Continuous blend state (rAF)
let blendRatio = 1.0;       // 1.0 = layerA fully visible, layerB hidden
let rafHandle = null;
let assetsCache = {};        // { periodId: { scene, headlights } }
let assetsReady = {};        // { periodId: true } once loaded

let layersOpacity = [-1, -1];
let particleIntensity = 0;

let clockTimer = null;
let sceneTimer = null;
let labelTimer = null;
let batteryTimer = null;

/* ══════════════════════════════════════════════
   DOM REFERENCES
   ══════════════════════════════════════════════ */

const layerA = document.querySelector('[data-layer="a"]');
const layerB = document.querySelector('[data-layer="b"]');
const sceneLabelEl = document.getElementById('scene-label');
const sceneLabelTxt = document.getElementById('scene-label-text');
const ctOverlay = document.getElementById('ct-overlay');
const root = document.documentElement;

// HUD elements
const hudDateEl = document.getElementById('hud-date');
const hudTimeEl = document.getElementById('hud-time');

// Battery elements
const batteryWidget = document.getElementById('battery-widget');
const batteryFill = document.getElementById('battery-fill');
const batteryPctEl = document.getElementById('battery-pct');

/* ══════════════════════════════════════════════
   TIME HELPERS
   ══════════════════════════════════════════════ */

function minutesNow() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/** Wrap-aware minutes difference: how many minutes from `from` to `to` going forward. */
function minutesForward(from, to) {
  return (to - from + 1440) % 1440;
}

/**
 * Determine which period `m` belongs to AND how far into it we are
 * (as a fraction 0→1 from the period start to end, ignoring the overlap window).
 */
function periodFromMinutes(m) {
  for (let i = 0; i < PERIODS.length; i++) {
    const p = PERIODS[i];
    const inRange = p.start < p.end
      ? m >= p.start && m < p.end
      : m >= p.start || m < p.end;
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

function nextPeriod(id) {
  const idx = periodIndex(id);
  return PERIODS[(idx + 1) % PERIODS.length];
}

/**
 * Compute the blend ratio for automatic mode.
 *
 * The blend window for period P spans from (P.start - P.transitionMins)
 * to P.start.  During this window the ratio for P goes from 0 → 1.
 * After P.start we are fully in P (ratio = 1) until the next window begins.
 *
 * Returns { from: periodId, to: periodId, ratio: 0..1 }
 *   where ratio = 0 → fully "from", ratio = 1 → fully "to"
 */
function computeBlend(m) {
  const totalMins = m; // minutes from midnight

  for (let i = 0; i < PERIODS.length; i++) {
    const p = PERIODS[i];
    const prev = PERIODS[(i + PERIODS.length - 1) % PERIODS.length];
    const window = p.transitionMins;
    // Blend window starts `window` minutes before p.start
    const blendStart = (p.start - window + 1440) % 1440;

    // Is m inside the blend window [blendStart, p.start)?
    let inBlend;
    if (blendStart < p.start) {
      inBlend = totalMins >= blendStart && totalMins < p.start;
    } else {
      // wraps midnight
      inBlend = totalMins >= blendStart || totalMins < p.start;
    }

    if (inBlend) {
      const elapsed = minutesForward(blendStart, totalMins);
      const ratio = Math.max(0, Math.min(1, elapsed / window));
      return { from: prev.id, to: p.id, ratio: ratio };
    }
  }

  // Fully inside current period
  const cur = periodFromMinutes(m);
  return { from: cur.id, to: cur.id, ratio: 1.0 };
}

/* ══════════════════════════════════════════════
   HUD — CLOCK / DATE / WEEKDAY
   ══════════════════════════════════════════════ */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];

function updateHUD() {
  const d = new Date();
  const h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');

  // 24-hour by default. The brief asks for a desktop clock, not an alarm clock;
  // a leading zero is kept so the glyph count never changes and the oversized
  // type does not shift sideways once an hour.
  const timeStr = SETTINGS.clock24
    ? String(h).padStart(2, '0') + ':' + min
    : (h % 12 || 12) + ':' + min + ' ' + (h >= 12 ? 'PM' : 'AM');

  // Date: "TUESDAY · 22 SEPTEMBER 2026"
  if (hudDateEl) hudDateEl.textContent =
    DAY_NAMES[d.getDay()].toUpperCase() + ' · ' + d.getDate() + ' ' + MONTH_NAMES[d.getMonth()].toUpperCase() + ' ' + d.getFullYear();

  if (hudTimeEl) hudTimeEl.textContent = timeStr;
}

/* ══════════════════════════════════════════════
   BATTERY WIDGET
   ══════════════════════════════════════════════ */

function renderBattery(pct, charging) {
  if (!batteryFill || !batteryPctEl) return;
  const pctClamped = Math.max(0, Math.min(100, Math.round(pct)));
  batteryFill.style.width = pctClamped + '%';
  batteryFill.classList.toggle('is-low', !charging && pctClamped <= 20);
  batteryFill.classList.toggle('is-charging', charging);
  batteryPctEl.textContent = pctClamped + '%';
  setBatteryStatus(charging);
  if (batteryWidget) batteryWidget.classList.remove('is-unavailable');
}

/**
 * Charging used to be written into a `#battery-status` element that no longer
 * exists. The state now lives on the widget itself: a class for the glow, and
 * an accessible label so it is not colour-only.
 */
function setBatteryStatus(charging) {
  if (!batteryWidget) return;
  batteryWidget.classList.toggle('is-charging', !!charging);
  // The existing CSS hooks the state off the fill element.
  if (batteryFill) batteryFill.classList.toggle('is-charging', !!charging);
  const pct = batteryPctEl ? batteryPctEl.textContent : '';
  batteryWidget.setAttribute('aria-label',
    'Battery ' + (pct || 'unknown') + (charging ? ', charging' : ''));
  batteryWidget.title = charging ? 'Battery - charging' : 'Battery';
}

function showBatteryUnavailable() {
  if (batteryPctEl) batteryPctEl.textContent = 'N/A';
  if (batteryWidget) {
    batteryWidget.title = 'Battery state is not available in this viewer';
    batteryWidget.setAttribute('aria-label', 'Battery state unavailable');
  }
  if (batteryWidget) batteryWidget.classList.add('is-unavailable');
}

function initBattery() {
  // ── Source 1: WebView2 native bridge (C# host → JS message) ──────────
  // When running inside the NightdriveHost app, the C# BatteryHelper sends
  // JSON messages via CoreWebView2.PostWebMessageAsJson every 30 seconds.
  // This gives genuine Windows battery data in all browsers/runtimes.
  if (PLATFORM.webview2) {
    window.chrome.webview.addEventListener('message', function (event) {
      try {
        const data = typeof event.data === 'string'
          ? JSON.parse(event.data)
          : event.data;

        if (!data) return;

        if (data.type === 'battery') {
          if (data.available === false) {
            showBatteryUnavailable();
          } else {
            renderBattery(data.percent, data.charging);
          }
        }
        else if (data.type === 'connectivity') {
          updateConnectivity(data.wifi, data.bt, data.audio, data.muted);
        }
      } catch (e) { /* ignore malformed messages */ }
    });
    // Don't register the browser API — native bridge takes priority.
    // Show a placeholder until the first message arrives.
    if (batteryPctEl) batteryPctEl.textContent = '…';
    // No native host answered; the browser API is tried below.
    // No native host answered (e.g. Lively Wallpaper) — use the browser API.
    setTimeout(function () {
      if (!nativeHostActive) initBrowserBattery();
    }, 4000);
    return;
  } else {
    // Linux/macOS standard WebEngine messages
    window.addEventListener('message', function (event) {
      try {
        const data = typeof event.data === 'string'
          ? JSON.parse(event.data)
          : event.data;
        // Generic message payload handler
        if (data && data.pct !== undefined) {
          renderBattery(parseInt(data.pct), data.status === 'Charging');
        }
      } catch (e) { }
    });
  }

  initBrowserBattery();
}

function initBrowserBattery() {
  // ── Source 2: Browser Battery Status API (Chrome/Edge standalone) ─────
  if (!navigator.getBattery) {
    showBatteryUnavailable();
    return;
  }

  navigator.getBattery().then(function (battery) {
    function update() {
      renderBattery(battery.level * 100, battery.charging);
    }
    update();
    battery.addEventListener('levelchange', update);
    battery.addEventListener('chargingchange', update);
  }).catch(function () {
    showBatteryUnavailable();
  });
}

/* ══════════════════════════════════════════════
   ASSET LOADING
   ══════════════════════════════════════════════ */

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
        xhr.onload = function() {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve({ src: src, kind: 'svg', svg: xhr.responseText });
          } else {
            tryNext();
          }
        };
        xhr.onerror = function() { tryNext(); };
        xhr.ontimeout = function() { tryNext(); };
        xhr.open('GET', src, true);
        xhr.send();
      } else {
        const img = new Image();
        img.onload = function() { resolve({ src: src, kind: 'raster' }); };
        img.onerror = function() { tryNext(); };
        img.src = src;
      }
    }
    tryNext();
  });
}

/* ══════════════════════════════════════════════
   LEFT CONNECTIVITY PANEL
   ══════════════════════════════════════════════ */

const wifiBtn = document.getElementById('wifi-btn');
const btBtn = document.getElementById('bt-btn');
const wifiStatus = document.getElementById('wifi-status');
const btStatus = document.getElementById('bt-status');

function setWifiState(online) {
  if (!wifiBtn || !wifiStatus) return;
  if (online) {
    wifiBtn.classList.add('is-on');
    wifiBtn.classList.remove('is-off');
    wifiStatus.textContent = 'Connected';
  } else {
    wifiBtn.classList.add('is-off');
    wifiBtn.classList.remove('is-on');
    wifiStatus.textContent = 'Off';
  }
}

function setBtState(enabled) {
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
    btStatus.textContent = '--';
  }
}

function updateConnectivity(wifi, bt, audioPct, isMuted) {
  // Update left panel
  setWifiState(wifi === true ? true : navigator.onLine);
  setBtState(bt);

  // Audio on left panel
  const audioWidget = document.getElementById('conn-audio');
  const audioPctEl = document.getElementById('audio-pct');
  if (audioWidget && audioPctEl) {
    if (audioPct !== null && audioPct !== undefined) {
      audioPctEl.textContent = audioPct + '%';
      if (isMuted) {
        audioWidget.classList.add('is-off');
        audioWidget.classList.remove('is-on');
      } else {
        audioWidget.classList.add('is-on');
        audioWidget.classList.remove('is-off');
      }
    } else {
      audioPctEl.textContent = '—';
      audioWidget.classList.remove('is-on', 'is-off');
    }
  }
}

// Control buttons — open the matching OS settings page where supported
if (wifiBtn) wifiBtn.addEventListener('click', () => openSystemSettings('wifi'));
if (btBtn) btBtn.addEventListener('click', () => openSystemSettings('bt'));
const audioWidgetEl = document.getElementById('conn-audio');
if (audioWidgetEl) audioWidgetEl.addEventListener('click', () => openSystemSettings('sound'));

// Initial state from browser navigator
setWifiState(navigator.onLine);
setBtState(null);

// Live WiFi state from browser events
window.addEventListener('online', () => setWifiState(true));
window.addEventListener('offline', () => setWifiState(false));

// C# WebView2 bridge (receives real system data)
if (PLATFORM.webview2) {
  window.chrome.webview.addEventListener('message', function (event) {
    try {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (!data) return;
      if (data.type === 'connectivity') {
        updateConnectivity(data.wifi, data.bt, data.audio, data.muted);
      }
    } catch (e) { }
  });
}
/** Load scene + headlight assets for a period, caching the result. */
/**
 * Is the viewport taller than it is wide? Re-read on every asset load so a
 * window resize or a monitor rotation picks the other plate.
 */
function prefersPortraitAsset() {
  return window.innerHeight > window.innerWidth * 1.05;
}

/**
 * Load the scene + headlights for a period.
 *
 * A `portrait` plate is preferred on a tall viewport when one actually exists;
 * otherwise the landscape plate is used and `fillLayer` presents it contained
 * over a blurred backdrop rather than cropping it. Probe results are cached so
 * a missing portrait file is only tried once.
 */
async function ensureAssets(periodId) {
  const wantPortrait = prefersPortraitAsset();
  const cached = assetsCache[periodId];
  if (cached && assetsReady[periodId] && cached.orientation === (wantPortrait ? 'portrait' : 'landscape')) {
    return cached;
  }

  const assets = ASSETS[periodId] || { scene: [], headlights: [] };
  const period = periodById(periodId);

  let sceneAsset = null;
  let orientation = 'landscape';
  if (wantPortrait && assets.portrait && assets.portrait.length) {
    sceneAsset = await loadFirstAvailable(assets.portrait);
    if (sceneAsset) orientation = 'portrait';
  }
  if (!sceneAsset) sceneAsset = await loadFirstAvailable(assets.scene);

  const hlAsset = period && period.headlights
    ? await loadFirstAvailable(assets.headlights)
    : null;

  // Optional transparent car layer. Absent by design today; when a period does
  // supply one it is composited over the plate, which is what makes the car and
  // the landscape independently replaceable.
  const carAsset = assets.cursor && assets.cursor.length
    ? await loadFirstAvailable(assets.cursor)
    : null;

  assetsCache[periodId] = {
    scene: sceneAsset,
    headlights: hlAsset,
    cursor: carAsset,
    orientation: orientation
  };
  assetsReady[periodId] = true;
  return assetsCache[periodId];
}

/* ══════════════════════════════════════════════
   LAYER POPULATION
   ══════════════════════════════════════════════ */

/**
 * Present a plate without stretching it.
 *
 * Landscape plates simply cover the frame (cropping is fine and intended).
 * A tall plate — anything past 4:5 — is shown whole over a blurred copy of
 * itself instead, so a portrait asset on a laptop is neither stretched nor
 * reduced to a narrow middle strip.
 */
const MAX_COVER_ASPECT = 0.8;   // width / height; below this, switch to contain

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

function fillLayer(layer, period, sceneAsset, headlightAsset, carAsset) {
  const fallback = layer.querySelector('.scene-fallback');
  const svgScene = layer.querySelector('.svg-scene');
  const sceneImg = layer.querySelector('.scene-img');
  const svgLights = layer.querySelector('.svg-headlights');
  const headImg = layer.querySelector('.headlight-img');
  const carImg = layer.querySelector('.car-img');

  fallback.setAttribute('data-period', period.id);
  if (carImg) {
    carImg.removeAttribute('src');
    carImg.classList.remove('is-loaded');
  }
  svgScene.innerHTML = '';
  svgLights.innerHTML = '';
  svgLights.classList.remove('is-on');
  headImg.removeAttribute('src');
  headImg.classList.remove('is-on');

  // Focal crop for this period (the car's position in the plate). The value
  // lives in the asset table, not in PERIODS, so a future customisation phase
  // can point a period at a completely different plate and crop.
  const focus = ASSETS[period.id] && ASSETS[period.id].focus;
  if (focus) {
    const focusValue = focus[0] + ' ' + focus[1];
    if (layer.style.getPropertyValue('--focus') !== focusValue) {
      layer.style.setProperty('--focus', focusValue);
    }
  }

  // Scene
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

  // Optional car layer, above the plate and below the beams.
  if (carImg && carAsset && carAsset.kind === 'raster') {
    carImg.src = carAsset.src;
    carImg.classList.add('is-loaded');
    layer.classList.add('layer--has-car');
  } else if (carImg) {
    layer.classList.remove('layer--has-car');
  }

  // Same plate, clipped to everything below the measured skyline. This is the
  // copy that paints back over the clock (see the PHASE 2 section at the end).
  applyForegroundFor(layer, period.id);

  // Headlights (layer's intrinsic image — opacity controlled by caller)
  if (period.headlights && headlightAsset) {
    if (headlightAsset.kind === 'svg') {
      svgLights.innerHTML = headlightAsset.svg;
      svgLights.classList.add('is-on');
    } else if (headlightAsset.kind === 'raster') {
      headImg.src = headlightAsset.src;
      headImg.classList.add('is-on');
    }
  }
}

/* ══════════════════════════════════════════════
   COLOUR-TEMPERATURE OVERLAY
   ══════════════════════════════════════════════ */

/**
 * Colour grading overlay.
 *
 * Historically this was a `multiply` layer ramped to 85 % opacity, and its
 * `rgba()` colours carried their own alpha. Multiply is a darkening blend, so
 * the two alphas compounded: midnight ended up at 5.7/255 mean luminance with
 * only five distinct tones left in the sky — the smooth night gradient was
 * posterised into visible bands before it reached the screen.
 *
 * Now the overlay is a gentle `soft-light` tint (see styles.css) that shifts
 * the hue of each period without crushing its luminance range, and the two
 * neighbouring tint colours are interpolated so a crossfade never steps.
 */

/** Parse 'rgba(r,g,b,a)' / 'rgb(r,g,b)' into [r,g,b,a]. */
function parseRGBA(str) {
  const m = String(str || '').match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (!m) return [0, 0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

function lerpCTColor(colorA, colorB, t) {
  const a = parseRGBA(colorA);
  const b = parseRGBA(colorB);
  const mix = (i) => a[i] + (b[i] - a[i]) * t;
  const r = Math.round(mix(0));
  const g = Math.round(mix(1));
  const bl = Math.round(mix(2));
  const al = Math.round(mix(3) * 1000) / 1000;
  return 'rgba(' + r + ',' + g + ',' + bl + ',' + al + ')';
}

let lastCT = '';

function applyCTOverlay(blendState) {
  const fromP = periodById(blendState.from);
  const toP = periodById(blendState.to);
  if (!fromP || !toP || !ctOverlay) return;

  // 1 = fully in `to`, 0 = fully in `from`.
  const t = blendState.from === blendState.to ? 1 : blendState.ratio;
  const colour = lerpCTColor(fromP.ctColor || 'rgba(0,0,0,0)', toP.ctColor || 'rgba(0,0,0,0)', t);

  // Only touch the DOM when the value actually changed (this runs at 60 fps).
  if (colour !== lastCT) {
    lastCT = colour;
    ctOverlay.style.background = colour;
  }
}

/* ══════════════════════════════════════════════
   ACCENT THEMING
   ══════════════════════════════════════════════ */

function applyAccent(period) {
  root.style.setProperty('--accent', period.accent || '#c49a4a');
  root.style.setProperty('--accent-dim', period.accentDim || '#7a5f28');
}

/* ══════════════════════════════════════════════
   HEADLIGHT FADE
   ══════════════════════════════════════════════ */

/** Peak overlay opacity — restrained, so beams add light instead of haze. */
const HEADLIGHT_OPACITY = 0.55;

/**
 * Set the opacity of all headlight overlay images/SVGs in a layer.
 * During the dusk blend window the layer itself fades in, carrying the beams
 * with it; in full night they sit at HEADLIGHT_OPACITY.
 */
function setHeadlightOpacity(layer, opacity) {
  const svgLights = layer.querySelector('.svg-headlights');
  const headImg = layer.querySelector('.headlight-img');
  const op = Math.max(0, Math.min(1, opacity));
  const value = op.toFixed(3);

  // rAF calls this every frame; skip the style write when nothing changed.
  if (svgLights && !svgLights.classList.contains('headlight-flare') &&
      svgLights.dataset.opacity !== value) {
    svgLights.dataset.opacity = value;
    svgLights.style.opacity = value;
  }
  if (headImg && !headImg.classList.contains('headlight-flare') &&
      headImg.dataset.opacity !== value) {
    headImg.dataset.opacity = value;
    headImg.style.opacity = value;
  }
}

/**
 * Compute headlight opacity from the blend state.
 * Headlights are ON for dusk and night. During the dusk transition window
 * (approaching dusk from goldenHour) they fade in proportionally.
 * During the morning transition (night → morning) they fade out.
 */
function headlightOpacityFor(periodId, blendState) {
  // A manual override wins over the time of day until the user goes back to
  // automatic, so dragging the switch cannot be undone a frame later.
  if (typeof headlightOverride !== 'undefined' && headlightOverride !== null) {
    return headlightOverride ? HEADLIGHT_OPACITY : 0;
  }
  const p = periodById(periodId);
  if (!p || !p.headlights) return 0;
  // The layer's own opacity already fades the whole plate in and out, so the
  // overlay just holds its target level; the two crossfade together.
  return HEADLIGHT_OPACITY;
}

/**
 * Orientation changes: forget the cached orientation and repopulate the
 * visible layer. Debounced so dragging a window edge does not thrash decodes.
 */
let orientationTimer = null;
let lastPortraitState = prefersPortraitAsset();

function onViewportResize() {
  const now = prefersPortraitAsset();
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

window.addEventListener('resize', onViewportResize);
window.addEventListener('orientationchange', onViewportResize);

/* ══════════════════════════════════════════════
   RAF BLEND LOOP (AUTO MODE)
   ══════════════════════════════════════════════ */

let currentBlend = { from: null, to: null, ratio: 1.0 };
let layerAId = null;  // which period is in layerA
let layerBId = null;  // which period is in layerB
// When ratio=1 the "to" period is fully visible.
// layerA holds the "from" scene, layerB holds the "to" scene.
// We set: layerA.opacity = 1 - ratio,  layerB.opacity = ratio.

async function ensureLayerPopulated(layer, periodId) {
  const period = periodById(periodId);
  if (!period) return;
  const cached = await ensureAssets(periodId);
  fillLayer(layer, period, cached.scene, cached.headlights, cached.cursor);
}

let lastAccentId = null;
let lastHeadlightMix = -1;

function rafTick() {
  if (mode !== 'auto') {
    rafHandle = null;
    return;
  }

  const blend = computeBlend(minutesNow());
  const needFrom = blend.from;
  const needTo = blend.to;

  // If both are the same (no blend), just show it fully.
  if (needFrom === needTo) {
    if (layerAId !== needTo) {
      layerAId = needTo;
      ensureLayerPopulated(layerA, needTo);
    }
    if (layersOpacity[0] !== 1) {
      layerA.style.opacity = '1';
      layerB.style.opacity = '0';
      layersOpacity[0] = 1;
      layersOpacity[1] = 0;
      syncForegroundOpacity(1, 0);
    }

    const period = periodById(needTo);
    const hlOp = period && period.headlights ? HEADLIGHT_OPACITY : 0;
    setHeadlightOpacity(layerA, hlOp);
    setHeadlightOpacity(layerB, 0);
    setHeadlightMix(hlOp / HEADLIGHT_OPACITY);

    applyCTOverlay(blend);
    applyAccentFromBlend(blend);
  } else {
    const ratio = blend.ratio;  // 0 = fully "from", 1 = fully "to"

    if (layerAId !== needFrom) {
      layerAId = needFrom;
      ensureLayerPopulated(layerA, needFrom);
    }
    if (layerBId !== needTo) {
      layerBId = needTo;
      ensureLayerPopulated(layerB, needTo);
    }

    // Only write opacity when it moves by a visible amount: at 60 fps the old
    // code wrote both layers plus the tint every frame for no visual gain,
    // which kept the compositor busy for the entire 20-minute fade.
    const aOpacity = 1 - ratio;
    if (Math.abs(layersOpacity[0] - aOpacity) > 0.0015) {
      layerA.style.opacity = String(aOpacity);
      layerB.style.opacity = String(ratio);
      layersOpacity[0] = aOpacity;
      layersOpacity[1] = ratio;
      syncForegroundOpacity(aOpacity, ratio);
    }

    const hlOpA = headlightOpacityFor(needFrom, blend);
    const hlOpB = headlightOpacityFor(needTo, blend);
    setHeadlightOpacity(layerA, hlOpA);
    setHeadlightOpacity(layerB, hlOpB);
    setHeadlightMix((hlOpA * (1 - ratio) + hlOpB * ratio) / HEADLIGHT_OPACITY);

    applyCTOverlay(blend);
    applyAccentFromBlend(blend);

    // Track the dominant scene label for anything reading `currentId`.
    const domPeriod = ratio >= 0.5 ? periodById(needTo) : periodById(needFrom);
    if (domPeriod) currentId = domPeriod.id;
  }

  rafHandle = requestAnimationFrame(rafTick);
}

/** Feed the dust field the current headlight strength (used to gate it). */
function setHeadlightMix(mix) {
  const value = Math.max(0, Math.min(1, mix));
  if (Math.abs(value - lastHeadlightMix) < 0.002) return;
  lastHeadlightMix = value;
  particleIntensity = value;
}

function applyAccentFromBlend(blend) {
  // Use the dominant (to) period for accent colour
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

/* ══════════════════════════════════════════════
   MANUAL MODE — plain CSS crossfade (unchanged from Phase 2)
   ══════════════════════════════════════════════ */

function describeAssets(sceneAsset, headlightAsset, period) {
  const notes = [];
  if (!sceneAsset) {
    notes.push('⚠ No scene image — CSS gradient fallback active.');
  } else if (sceneAsset.kind === 'svg') {
    notes.push('ℹ Placeholder SVG scene (add scene.jpg for photo).');
  }
  if (period.headlights) {
    if (!headlightAsset) notes.push('⚠ No headlight overlay found.');
    else if (headlightAsset.kind === 'svg') notes.push('ℹ Placeholder SVG headlights.');
  }
  return notes.join(' ');
}

async function showPeriodManual(period, instant) {
  if (!period) return;

  if (transitioning && !instant) {
    pendingId = period.id;
    return;
  }

  if (period.id === currentId && !instant) {
    return;
  }

  const cached = await ensureAssets(period.id);
  const sceneAsset = cached.scene;
  const headlightAsset = cached.headlights;

  // Restore CSS-driven transitions for manual mode, at the user's speed.
  const dur = (SETTINGS.transitionMs || TRANSITION_MS) / 1000;
  layerA.style.transition = 'opacity ' + dur + 's cubic-bezier(0.4,0,0.2,1)';
  layerB.style.transition = 'opacity ' + dur + 's cubic-bezier(0.4,0,0.2,1)';

  const front = frontIsA ? layerA : layerB;
  const back = frontIsA ? layerB : layerA;

  fillLayer(back, period, cached.scene, cached.headlights, cached.cursor);
  const hlOp = period.headlights ? HEADLIGHT_OPACITY : 0;
  setHeadlightOpacity(back, hlOp);

  applyAccent(period);

  // Update layer tracking
  if (frontIsA) { layerBId = period.id; } else { layerAId = period.id; }

  if (instant || currentId === null) {
    back.style.opacity = '1';
    front.style.opacity = '0';
    frontIsA = !frontIsA;
    currentId = period.id;
    return;
  }

  transitioning = true;
  back.style.opacity = '1';
  front.style.opacity = '0';
  frontIsA = !frontIsA;
  currentId = period.id;
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

/* ══════════════════════════════════════════════
   SCENE LABEL
   ══════════════════════════════════════════════ */

function showSceneLabel(period) {
  if (!sceneLabelTxt || !sceneLabelEl) return;
  sceneLabelTxt.textContent = period.label;
  sceneLabelEl.classList.add('is-visible');
  clearTimeout(labelTimer);
  labelTimer = setTimeout(function () {
    sceneLabelEl.classList.remove('is-visible');
  }, LABEL_SHOW_MS);
}

/* ══════════════════════════════════════════════
   MODE SWITCHING
   ══════════════════════════════════════════════ */

function setModeAuto() {
  mode = 'auto';
  // Remove CSS-driven transition so rAF controls opacity directly
  layerA.style.transition = 'none';
  layerB.style.transition = 'none';
  startRaf();
}


/* ══════════════════════════════════════════════
   EVENT LISTENERS
   ══════════════════════════════════════════════ */


/* ══════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════ */

// Boot is a function, called once at the very bottom of this file.
//
// It used to run inline here, which meant it executed before the settings,
// ridge data and car/background state further down had been initialised. Those
// are `const`/`let`, so anything reached in the same tick threw a temporal-dead-
// zone ReferenceError - the "white wallpaper on first launch" class of bug.
// Deferring the call keeps one source of truth and removes the ordering trap
// entirely.
function boot() {
  // 1. Determine initial scene from clock
  const initM = minutesNow();
  const initBlend = computeBlend(initM);

  // Populate layerA with the "from" scene synchronously enough
  // (ensureAssets is async but the rAF won't paint until assets resolve)
  layerAId = initBlend.from;
  layerBId = initBlend.to;

  // Pre-load both scenes that may be visible at startup
  return Promise.all([
    ensureLayerPopulated(layerA, initBlend.from),
    ensureLayerPopulated(layerB, initBlend.to)
  ]).then(function () {
    logToHost("6. First actual engine frame (assets fetched and painted)");

    // STAGE 3: Notify host to hide fallback Image because first frame is ready
    if (PLATFORM.webview2) {
      window.chrome.webview.postMessage(JSON.stringify({ action: 'hide_fallback' }));
    }

    // STAGE 4: Load secondary non-essential features
    updateHUD();
    clockTimer = setInterval(updateHUD, CLOCK_MS);
    logToHost("7. Essential widgets becoming visible");

    initBattery();
    initWeather();
    initParticles();
    startParticles();
    logToHost("8. Optional features becoming ready");

    // The startup effect is NOT run here: a wallpaper refresh is not an engine
    // start. `maybeAutoStartup` plays it only when the saved preference asks
    // for that, and the drawer button plays it on demand.
    setModeAuto();
    applySavedAppearance();
    maybeAutoStartup();
  });
}

/* ══════════════════════════════════════════════
   CINEMATIC PARTICLES (DUST)
   ══════════════════════════════════════════════ */
const particlesCanvas = document.getElementById('particles-canvas');
const ctx = particlesCanvas ? particlesCanvas.getContext('2d') : null;
let particles = [];
let pW = 0, pH = 0;
let pDpr = 1;
let particlesRunning = false;

/**
 * Dust motes in the headlight cones.
 *
 * The previous implementation was both too strong and too coarse: 70 motes
 * up to 2.2 px drawn on a canvas sized in CSS pixels (so they were re-scaled
 * and smeared on any HiDPI display), drifting across the whole lower half of
 * the frame regardless of where the light actually fell. Here the field is
 * smaller, dimmer, drawn at device resolution, and confined to the beam wedges.
 */
const PARTICLE_COUNT = 26;

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

  // Respect a mid-session "reduce motion" change.
  if (REDUCED_MOTION.addEventListener) {
    REDUCED_MOTION.addEventListener('change', function () {
      if (REDUCED_MOTION.matches && particlesCanvas) particlesCanvas.style.opacity = '0';
    });
  }
}

function spawnParticle(randomY = false) {
  // Two wedges cast by the lamps, which sit low and right of centre.
  const wedge = Math.random() < 0.5 ? -1 : 1;
  const spread = Math.pow(Math.random(), 0.7);
  const yTop = pH * 0.72;
  const yBottom = pH * 1.02;
  const y = randomY ? yTop + Math.random() * (yBottom - yTop) : yBottom;
  const xCentre = pW * (wedge < 0 ? 0.42 : 0.56) + (y - yTop) * (wedge < 0 ? -0.30 : 0.16);
  const x = xCentre + (Math.random() - 0.5) * pW * 0.16 * (0.4 + spread);
  return {
    x: x,
    y: y,
    vx: (Math.random() - 0.5) * 0.22,
    vy: -(Math.random() * 0.16 + 0.04),
    size: Math.random() * 0.9 + 0.35,
    life: Math.random(),
    lifeRate: Math.random() * 0.0022 + 0.0008
  };
}

function drawParticlesStep() {
  if (!ctx || !particlesCanvas) return;

  const active = particleIntensity > 0.02 && !REDUCED_MOTION.matches;
  const canvasOpacity = active ? Math.min(1, particleIntensity).toFixed(2) : '0';
  if (canvasOpacity !== particlesCanvas.dataset.opacity) {
    particlesCanvas.dataset.opacity = canvasOpacity;
    particlesCanvas.style.opacity = canvasOpacity;
  }
  if (!active) return;

  ctx.clearRect(0, 0, pW, pH);
  ctx.fillStyle = 'rgba(226, 232, 240, 0.55)';

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life += p.lifeRate;

    const fade = Math.sin(Math.max(0, Math.min(1, p.life)) * Math.PI);
    if (fade > 0.01) {
      ctx.globalAlpha = fade * 0.28;
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

/** Stop the dust field without tearing down its canvas. */
function stopParticles() {
  particlesRunning = false;
  if (ctx && particlesCanvas) ctx.clearRect(0, 0, particlesCanvas.width, particlesCanvas.height);
}

// initParticles is called after first frame; startParticles() once booted.

/* ══════════════════════════════════════════════
   PREVIEW STRIP (REMOVED)
   ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
   WEATHER WIDGET
   ══════════════════════════════════════════════ */
function initWeather() {
  const weatherIcon = document.getElementById('weather-icon');
  const weatherTemp = document.getElementById('weather-temp');
  if (!weatherIcon || !weatherTemp) return;

  function fetchWeather(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (data && data.current_weather) {
          const temp = Math.round(data.current_weather.temperature);
          const code = data.current_weather.weathercode;
          weatherTemp.textContent = `${temp}°C`;
          weatherIcon.innerHTML = getWeatherIcon(code, data.current_weather.is_day);
        } else {
          fallbackWeather();
        }
      })
      .catch(() => fallbackWeather());
  }

  function fallbackWeather() {
    weatherTemp.textContent = '--°C';
    weatherIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';
  }

  function getWeatherIcon(code, isDay) {
    const sunSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
      <circle cx="12" cy="12" r="4"/>
      <line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>`;
    const moonSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>`;
    const cloudSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
    </svg>`;
    const rainSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <line x1="16" y1="13" x2="16" y2="21"/><line x1="8" y1="13" x2="8" y2="21"/><line x1="12" y1="15" x2="12" y2="23"/>
      <path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/>
    </svg>`;
    const snowSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <line x1="16" y1="13" x2="16" y2="21"/><line x1="8" y1="13" x2="8" y2="21"/><line x1="12" y1="15" x2="12" y2="23"/>
      <path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/>
    </svg>`;

    if (code === 0) return isDay ? sunSvg : moonSvg;
    if (code >= 1 && code <= 3) return cloudSvg;
    if (code >= 45 && code <= 48) return cloudSvg;
    if (code >= 51 && code <= 67) return rainSvg;
    if (code >= 71 && code <= 77) return snowSvg;
    if (code >= 80 && code <= 82) return rainSvg;
    if (code >= 95) return rainSvg;
    return cloudSvg;
  }

  // Location: browser geolocation first, then approximate IP-based location
  // (desktop hosts usually have no geolocation permission prompt).
  let coords = null;

  function locateByIP() {
    return fetch('https://ipapi.co/json/')
      .then(res => res.json())
      .then(d => {
        if (d && typeof d.latitude === 'number') return { lat: d.latitude, lon: d.longitude };
        throw new Error('no ip location');
      });
  }

  function locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('no geolocation')); return; }
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        err => reject(err),
        { timeout: 8000, maximumAge: 30 * 60 * 1000 }
      );
    }).catch(locateByIP);
  }

  function refresh() {
    if (!navigator.onLine) { fallbackWeather(); return; }
    (coords ? Promise.resolve(coords) : locate())
      .then(c => { coords = c; fetchWeather(c.lat, c.lon); })
      .catch(() => { console.warn('Location unavailable — weather disabled.'); fallbackWeather(); });
  }

  refresh();
  setInterval(refresh, 30 * 60 * 1000);   // every 30 minutes
  window.addEventListener('online', refresh);
}


// Remove CSS transition for auto mode (rAF drives opacity directly)
layerA.style.transition = 'none';
layerB.style.transition = 'none';

/* ══════════════════════════════════════════════
   CINEMATIC STARTUP SEQUENCE
   ══════════════════════════════════════════════ */
function runCinematicStartup() {
  const engineAudio = document.getElementById('engine-audio');

  // Attempt to play audio
  const playAudio = () => {
    // Check if src exists and is not just the empty page URL
    if (engineAudio && engineAudio.getAttribute('src')) {
      // Respect the saved volume/mute; the startup sound is not a reason to
      // jump to full volume.
      applyAudioSettings();
      engineAudio.play().catch(e => {
        console.warn("Autoplay blocked by browser. Audio will play on first click.");
      });
    }
  };

  const triggerIgnitionVisuals = () => {
    if (REDUCED_MOTION.matches) return;
    // A single, restrained flare on the lamps. The previous version also added
    // a perpetual 80 ms `engine-idle` shake, which re-rasterised the scene
    // every frame and left every image edge permanently soft.
    [layerA, layerB].forEach(layer => {
      const hlImg = layer.querySelector('.headlight-img');
      const svgHl = layer.querySelector('.svg-headlights');

      if (hlImg) {
        hlImg.style.opacity = '';
        hlImg.classList.add('headlight-flare');
        setTimeout(() => hlImg.classList.remove('headlight-flare'), 1200);
      }
      if (svgHl) {
        svgHl.style.opacity = '';
        svgHl.classList.add('headlight-flare');
        setTimeout(() => svgHl.classList.remove('headlight-flare'), 1200);
      }
    });

    const hud = document.getElementById('hud');
    if (hud) {
      hud.classList.remove('ui-glitch');
      void hud.offsetWidth;
      hud.classList.add('ui-glitch');
      setTimeout(() => hud.classList.remove('ui-glitch'), 1500);
    }
  };

  // 1. Initial delay
  setTimeout(() => {
    // 2. Play audio
    playAudio();

    // 3. Ignition flare & shake
    triggerIgnitionVisuals();

  }, 800);
}

// runCinematicStartup is triggered by the drawer's Start engine action only —
// never by a page load. See `startEngine()`.

/* ══════════════════════════════════════════════════════════════════════════
   PHASE 2 — SETTINGS, DEPTH CLOCK, PLAYBACK, PUBLIC API
   ══════════════════════════════════════════════════════════════════════════
   Kept in one place at the end of the engine so the boot path above stays
   readable. Everything here is additive: with no saved settings and no ridge
   data the wallpaper looks and behaves exactly as it did before.
   ══════════════════════════════════════════════════════════════════════════ */

/* ── Settings store ────────────────────────────────────────────────────────
   localStorage holds small preferences only. Imported images are blobs and
   live in IndexedDB (see app.js) — putting a 4 MB wallpaper in localStorage
   would blow the 5 MB quota and take the settings down with it. */

const SETTINGS_KEY = 'nightdrive.settings.v2';

const DEFAULT_SETTINGS = {
  // Clock
  clockVisible: true,
  clock24: true,
  clockScale: 100,          // %
  clockOpacity: 85,         // %
  clockOffset: 0,           // % of viewport height
  // Scene
  mode: 'scenes',           // 'scenes' | 'custom'
  useDesign: false,         // custom mode: whole wallpaper vs scene (bg+car)
  autoScene: true,
  sceneId: 'day',           // used when autoScene is off
  headlights: null,         // null = follow the period, true/false = override
  playback: true,
  transitionMs: 1600,
  // Appearance
  brightness: 100,          // % (app-level dimming)
  motion: true,
  particles: true,
  // Audio
  volume: 70,
  muted: false,
  startupEffect: 'manual',  // 'manual' | 'once' | 'always'
  // Drawer
  drawerEnabled: true,
  drawerPinned: false,
  // Custom scene framing
  carFit: 'contain',
  carScale: 100,
  carX: 50,
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
      if (v === undefined || v === null) return;
      if (typeof base[k] === 'boolean' && typeof v === 'boolean') base[k] = v;
      else if (typeof base[k] === 'number' && typeof v === 'number' && isFinite(v)) base[k] = v;
      else if (typeof base[k] === 'string' && typeof v === 'string') base[k] = v;
    });
  } catch (e) {
    // Corrupt or unreadable storage must never stop the wallpaper booting.
    console.warn('[NIGHTDRIVE] settings unreadable, using defaults', e);
  }
  return base;
}

const SETTINGS = loadSettings();

function saveSettings(patch) {
  if (patch) Object.keys(patch).forEach(function (k) {
    if (k in DEFAULT_SETTINGS) SETTINGS[k] = patch[k];
  });
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
  try {
    if (typeof localStorage !== 'undefined' && localStorage) localStorage.removeItem(SETTINGS_KEY);
  } catch (e) { /* nothing else to do */ }
  emit('settings', SETTINGS);
}

/* ── Tiny event bus (app.js subscribes; the engine never depends on it) ──── */

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

/* ── Ridge data: measured skyline per scene ──────────────────────────────── */

const RIDGES_URL = 'assets/ridges.json';
let RIDGES = null;

/**
 * Load the measured skylines. Failure is not fatal: without them the clock
 * simply sits in front of the scene at its default position, which is the
 * graceful fallback the brief asks for rather than a half-applied effect.
 */
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
  xhr.onerror = function () { /* fallback: no occlusion */ };
  xhr.open('GET', RIDGES_URL, true);
  xhr.send();
}

function ridgeFor(periodId) {
  if (!RIDGES || !RIDGES[periodId]) return null;
  const r = RIDGES[periodId];
  return r && Array.isArray(r.ridge) && r.ridge.length > 1 ? r : null;
}

/** Linear interpolation of ridge height at normalised x. */
function ridgeAt(ridge, x) {
  if (!ridge || !ridge.length) return 0.6;
  const clamped = Math.max(0, Math.min(1, x));
  for (let i = 0; i < ridge.length - 1; i++) {
    const [x0, y0] = ridge[i];
    const [x1, y1] = ridge[i + 1];
    if (clamped >= x0 && clamped <= x1) {
      const t = x1 === x0 ? 0 : (clamped - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return ridge[ridge.length - 1][1];
}

/** CSS polygon describing everything below the skyline. */
function ridgePolygon(ridge) {
  const pts = ridge.map(function (p) { return (p[0] * 100).toFixed(3) + '% ' + (p[1] * 100).toFixed(3) + '%'; });
  return 'polygon(0% 100%, ' + pts.join(', ') + ', 100% 100%)';
}

/**
 * The rectangle a `background-size: cover` plate actually occupies, so a
 * percentage clip-path lands on image pixels instead of element pixels at any
 * aspect ratio (a 3:2 window crops the sides, a 21:9 one crops top/bottom).
 */
function plateRect(iw, ih, vw, vh, fx, fy) {
  const scale = Math.max(vw / iw, vh / ih);
  const w = iw * scale;
  const h = ih * scale;
  return { left: (vw - w) * fx, top: (vh - h) * fy, width: w, height: h };
}

/**
 * The rectangle a `contain` fit occupies. Portrait windows show a tall plate
 * whole over a blurred backdrop, so the foreground copy has to use the same
 * rectangle or the occlusion lands in the wrong place.
 */
function plateRectContain(iw, ih, vw, vh) {
  const scale = Math.min(vw / iw, vh / ih);
  const w = iw * scale;
  const h = ih * scale;
  return { left: (vw - w) / 2, top: (vh - h) / 2, width: w, height: h };
}

function focusFor(periodId) {
  const entry = SCENE_ASSETS[periodId];
  if (!entry || !entry.focus) return [0.62, 0.74];
  return entry.focus.map(function (v) { return parseFloat(v) / 100; });
}

const fgA = document.querySelector('[data-fg="a"]');
const fgB = document.querySelector('[data-fg="b"]');
const clockEl = document.getElementById('clock');
const stageEl = document.getElementById('stage');
const fgPeriods = { a: null, b: null };

function fgForLayer(layer) { return layer === layerA ? fgA : (layer === layerB ? fgB : null); }

function applyForegroundFor(layer, periodId) {
  applyCarToLayer(layer);
  const img = fgForLayer(layer);
  if (!img) return;
  const key = layer === layerA ? 'a' : 'b';
  const data = ridgeFor(periodId);
  // No ridge, or a user-supplied wallpaper: nothing to occlude with.
  if (!data || customBackdrop || SETTINGS.clockVisible === false) {
    img.classList.remove('is-active');
    img.removeAttribute('src');
    fgPeriods[key] = null;
    return;
  }
  const src = (SCENE_ASSETS[periodId] && SCENE_ASSETS[periodId].landscape[0]) || null;
  if (!src) { img.classList.remove('is-active'); return; }
  fgPeriods[key] = periodId;
  if (img.getAttribute('src') !== src) img.src = src;
  img.classList.add('is-active');
  layoutForeground(img, periodId, layer);
  if (img.complete !== true) {
    img.addEventListener('load', function () { layoutForeground(img, periodId, layer); }, { once: true });
  }
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
  const rect = contained
    ? plateRectContain(iw, ih, vw, vh)
    : plateRect(iw, ih, vw, vh, f[0], f[1]);
  img.style.left = rect.left.toFixed(2) + 'px';
  img.style.top = rect.top.toFixed(2) + 'px';
  img.style.width = rect.width.toFixed(2) + 'px';
  img.style.height = rect.height.toFixed(2) + 'px';
  img.style.clipPath = ridgePolygon(data.ridge);
  img.style.webkitClipPath = ridgePolygon(data.ridge);
}

function syncForegroundOpacity(a, b) {
  if (fgA) fgA.style.opacity = String(a);
  if (fgB) fgB.style.opacity = String(b);
}

/**
 * Place the clock against the active scene's skyline.
 *
 * `--clock-y` is the ridge height, and the clock's transform lifts its box by
 * 70 % of its own height, so the lower 30 % falls behind the silhouette. The
 * offset slider moves it in viewport units without changing that relationship.
 */
function placeClock(periodId) {
  if (!clockEl) return;
  const data = customBackdrop ? null : ridgeFor(periodId);
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (!data) {
    clockEl.style.setProperty('--clock-x', '35%');
    clockEl.style.setProperty('--clock-y', '52%');
    clockEl.classList.add('no-depth');
    return;
  }
  clockEl.classList.remove('no-depth');

  const entry = SCENE_ASSETS[periodId] || {};
  const imgSrc = entry.landscape && entry.landscape[0];
  // The plate's own aspect decides the cover rectangle. Reading it from the
  // loaded scene image keeps this correct for portrait plates too.
  const sceneImg = (layerA && layerA.querySelector('.scene-img'));
  const useScene = sceneImg && sceneImg.naturalWidth ? sceneImg : null;
  const iw = useScene ? useScene.naturalWidth : (imgSrc ? 1376 : vw);
  const ih = useScene ? useScene.naturalHeight : 768;
  const f = focusFor(periodId);
  const contained = layerA && layerA.classList && layerA.classList.contains('layer--contain');
  const rect = contained
    ? plateRectContain(iw, ih, vw, vh)
    : plateRect(iw, ih, vw, vh, f[0], f[1]);

  const cx = data.clock && typeof data.clock.x === 'number' ? data.clock.x : 0.35;
  const x = rect.left + cx * rect.width;
  const y = rect.top + ridgeAt(data.ridge, cx) * rect.height;

  clockEl.style.setProperty('--clock-x', x.toFixed(1) + 'px');
  clockEl.style.setProperty('--clock-y', (y + (SETTINGS.clockOffset / 100) * vh).toFixed(1) + 'px');
}

const BRIGHT_PERIODS = { day: true, goldenHour: true, morning: true };

function applyClockChrome(periodId) {
  const bright = !!BRIGHT_PERIODS[periodId];
  if (clockEl) clockEl.classList.toggle('is-bright', bright);
  document.body.classList.toggle('scene-bright', bright);
}

function refreshDepth() {
  const periodId = currentId || layerAId || (SETTINGS.sceneId || 'day');
  [ [layerA, 'a'], [layerB, 'b'] ].forEach(function (pair) {
    const layer = pair[0];
    const key = pair[1];
    if (!layer) return;
    const img = fgForLayer(layer);
    const pid = fgPeriods[key] || (layer === layerA ? layerAId : layerBId);
    if (img && pid && img.classList.contains('is-active')) layoutForeground(img, pid, layer);
  });
  placeClock(periodId);
  applyClockChrome(periodId);
}

/* ── Appearance from settings ───────────────────────────────────────────── */

function applyClockSettings() {
  if (!clockEl) return;
  clockEl.classList.toggle('is-hidden', !SETTINGS.clockVisible);
  clockEl.style.setProperty('--clock-scale', String(SETTINGS.clockScale / 100));
  clockEl.style.setProperty('--clock-opacity', String(SETTINGS.clockOpacity / 100));
  if (fgA) fgA.style.display = SETTINGS.clockVisible ? '' : 'none';
  if (fgB) fgB.style.display = SETTINGS.clockVisible ? '' : 'none';
  updateHUD();
  refreshDepth();
}

function applyBrightness() {
  // 40–110 % maps to 0.4–1.1; the CSS filter dims the photograph only.
  const level = Math.max(0.4, Math.min(1.1, SETTINGS.brightness / 100));
  document.documentElement.style.setProperty('--stage-brightness', level.toFixed(3));
}

function applySavedAppearance() {
  applyClockSettings();
  applyBrightness();
  applyAudioSettings();
  if (SETTINGS.mode === 'scenes' && SETTINGS.autoScene === false) {
    const p = periodById(SETTINGS.sceneId);
    if (p) showPeriodManual(p, true);
  }
  if (SETTINGS.playback === false) setPlayback(false);
  if (SETTINGS.motion === false) stopParticles();
  emit('ready', null);
}

/* ── Audio ──────────────────────────────────────────────────────────────── */

function engineAudioEl() { return document.getElementById('engine-audio'); }

function applyAudioSettings() {
  const audio = engineAudioEl();
  if (!audio) return;
  audio.volume = SETTINGS.muted ? 0 : Math.max(0, Math.min(1, SETTINGS.volume / 100));
}

function setVolume(pct) {
  const value = Math.max(0, Math.min(100, Math.round(pct)));
  saveSettings({ volume: value });
  if (SETTINGS.muted && value > 0) saveSettings({ muted: false });
  applyAudioSettings();
  // The Windows host owns the real system mixer; a browser cannot touch it, so
  // this is only sent when a host has actually answered us.
  if (PLATFORM.webview2 && nativeHostActive) postToHost('set_volume:' + value);
  emit('volume', value);
}

function setMuted(muted) {
  saveSettings({ muted: !!muted });
  applyAudioSettings();
  if (PLATFORM.webview2 && nativeHostActive) postToHost('set_mute:' + (muted ? 1 : 0));
  emit('muted', !!muted);
}

/* ── Playback: pause the scene, keep the clock ──────────────────────────── */

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

/* ── Headlights override ────────────────────────────────────────────────── */

let headlightOverride = null;

function setHeadlights(value) {
  // value: true | false | null (follow the period)
  headlightOverride = value;
  saveSettings({ headlights: value });
  const layerList = [layerA, layerB];
  layerList.forEach(function (layer) {
    if (!layer) return;
    const op = value === null ? 0 : (value ? HEADLIGHT_OPACITY : 0);
    if (value !== null) setHeadlightOpacity(layer, op);
  });
  emit('headlights', value);
}

/* ── Custom scene: car layer, background, complete design ───────────────── */

let customCar = null;      // { src, fit, x, y, scale, opacity }
let customBackdrop = null; // { src, fit, ... }
let customDesign = null;   // { src }

function applyCarToLayer(layer) {
  if (!layer) return;
  const img = layer.querySelector('.car-img');
  if (!img) return;
  if (!customCar || !customCar.src) return;   // fillLayer cleared it already
  img.style.setProperty('--car-fit', customCar.fit === 'cover' ? 'cover' : 'contain');
  img.classList.add('is-loaded');
  if (img.getAttribute('src') !== customCar.src) img.src = customCar.src;
  layer.classList.add('layer--has-car');
}

function setCar(asset, opts) {
  const o = opts || {};
  customCar = asset && asset.src ? {
    src: asset.src,
    fit: o.fit || SETTINGS.carFit,
    scale: o.scale || SETTINGS.carScale,
    x: typeof o.x === 'number' ? o.x : SETTINGS.carX,
    y: typeof o.y === 'number' ? o.y : SETTINGS.carY
  } : null;
  [layerA, layerB].forEach(function (layer) {
    if (!layer) return;
    const img = layer.querySelector('.car-img');
    if (!img) return;
    if (customCar) {
      applyCarToLayer(layer);
      img.style.setProperty('--car-position', customCar.x + '% ' + customCar.y + '%');
      img.style.transform = 'scale(' + (customCar.scale / 100) + ')';
      img.style.transformOrigin = customCar.x + '% ' + customCar.y + '%';
    } else {
      img.removeAttribute('src');
      img.classList.remove('is-loaded');
      img.style.transform = '';
      layer.classList.remove('layer--has-car');
    }
  });
  emit('car', customCar);
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
    // An arbitrary photograph can be bright anywhere; the stronger halo is the
    // safe default, and the clock's own opacity control does the rest.
    if (clockEl) clockEl.classList.add('is-bright');
    document.body.classList.remove('scene-bright');
    // The built-in skyline no longer describes what is on screen.
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
  if (customDesign) {
    saveSettings({ mode: 'custom' });
  } else {
    saveSettings({ mode: 'scenes' });
  }
  emit('design', customDesign);
}

/* ── Engine start ───────────────────────────────────────────────────────── */

/**
 * The deliberate, user-requested engine start. This is the only path that
 * plays the ignition sound or shakes anything — a wallpaper refresh never
 * calls it unless the saved preference explicitly says "every load".
 */
function startEngine(opts) {
  const silent = opts && opts.silent;
  const audio = engineAudioEl();
  if (audio && !silent) {
    audio.volume = SETTINGS.muted ? 0 : Math.max(0, Math.min(1, SETTINGS.volume / 100));
    try { audio.currentTime = 0; } catch (e) { /* not seekable yet */ }
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
    setTimeout(function () { clockEl.classList.remove('clock-start'); }, 1800);
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
      try { sessionStorage.setItem('nightdrive.started', '1'); } catch (e) { /* private mode */ }
      startEngine();
    }
  }
  // 'manual' (the default): do nothing. The drawer has a Start engine button.
}

/* ── Scene control ──────────────────────────────────────────────────────── */

function setAutoScene(enabled) {
  saveSettings({ autoScene: !!enabled });
  if (enabled) {
    mode = 'auto';
    setModeAuto();
  } else {
    mode = 'manual';
    stopRaf();
    const p = periodById(currentId || SETTINGS.sceneId || 'day');
    if (p) showPeriodManual(p, true);
  }
  emit('scene', { auto: mode === 'auto', id: currentId });
}

function stepScene(direction) {
  const order = PERIODS.map(function (p) { return p.id; });
  const id = currentId || layerAId || SETTINGS.sceneId;
  const idx = Math.max(0, order.indexOf(id));
  const next = order[(idx + (direction || 1) + order.length) % order.length];
  const p = periodById(next);
  if (!p) return;
  saveSettings({ autoScene: false, sceneId: next });
  mode = 'manual';
  stopRaf();
  showPeriodManual(p, false);
  emit('scene', { auto: false, id: next });
}

function setScene(id) {
  const p = periodById(id);
  if (!p) return;
  saveSettings({ autoScene: false, sceneId: id });
  mode = 'manual';
  stopRaf();
  showPeriodManual(p, false);
  emit('scene', { auto: false, id: id });
}

/* ── Visibility / sleep ─────────────────────────────────────────────────── */

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

/* ── Exit ───────────────────────────────────────────────────────────────── */

function exitApp() {
  // Native hosts close their own window; a browser tab cannot be closed unless
  // it was opened by script, so say so instead of pretending it worked.
  if (PLATFORM.tauri && window.__TAURI__ && window.__TAURI__.window) {
    try { window.__TAURI__.window.getCurrent().close(); return; } catch (e) { /* fall through */ }
  }
  if (postToHost('quit')) return;
  window.close();
  setTimeout(function () {
    emit('exit-blocked', null);
  }, 120);
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
      hasRidges: !!RIDGES
    };
  },
  setScene: setScene,
  stepScene: stepScene,
  setAutoScene: setAutoScene,
  setHeadlights: setHeadlights,
  setPlayback: setPlayback,
  setVolume: setVolume,
  setMuted: setMuted,
  applyAudioSettings: applyAudioSettings,
  applyClockSettings: applyClockSettings,
  applyBrightness: applyBrightness,
  placeClock: placeClock,
  setCar: setCar,
  setBackground: setBackground,
  setDesign: setDesign,
  startEngine: startEngine,
  exit: exitApp,
  openSystemSettings: openSystemSettings,
  postToHost: postToHost,
  hostActive: function () { return nativeHostActive; },
  reducedMotion: REDUCED_MOTION,
  notify: function (msg) { emit('toast', msg); }
};

// Start the ridge request first so it overlaps the plate decode, then boot.
// Both are deferred to the end of the file so every binding above exists.
loadRidges();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
