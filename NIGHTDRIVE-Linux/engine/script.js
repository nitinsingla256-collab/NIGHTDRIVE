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

function logToHost(step) {
  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.postMessage(JSON.stringify({ action: 'log_time:' + step }));
  }
}
logToHost("5. HTML engine loading (script.js executing)");

window.onerror = function(msg, url, line) {
  const errDiv = document.createElement('div');
  errDiv.style = 'position:absolute; top:20px; left:20px; z-index:9999; color:red; font-size:24px; background:black; padding:10px;';
  errDiv.innerText = 'JS Error: ' + msg + ' on line ' + line;
  document.body.appendChild(errDiv);
};

'use strict';

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
    ctColor: 'rgba(180,210,240,0.0)',  // colour-temperature tint (multiply)
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
    ctColor: 'rgba(255,252,240,0.0)',
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
    ctColor: 'rgba(255,160,60,0.08)',   // warm amber tint
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
    ctColor: 'rgba(100,60,120,0.10)',   // cool violet tint
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
    ctColor: 'rgba(30,50,100,0.12)',    // cool blue-night tint
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
    ctColor: 'rgba(10,20,40,0.15)',     // deeper blue/black tint
  }
];

const ASSETS = {
  morning: {
    scene: ['assets/morning/scene.jpg', 'assets/morning/scene.png', 'assets/morning/scene.svg'],
    headlights: ['assets/morning/headlights.svg']
  },
  day: {
    scene: ['assets/day/scene.jpg', 'assets/day/scene.png', 'assets/day/scene.svg'],
    headlights: ['assets/day/headlights.svg']
  },
  goldenHour: {
    scene: ['assets/golden-hour/scene.jpg', 'assets/golden-hour/scene.png', 'assets/golden-hour/scene.svg'],
    headlights: ['assets/golden-hour/headlights.svg']
  },
  dusk: {
    scene: ['assets/dusk/scene.jpg', 'assets/dusk/scene.png', 'assets/dusk/scene.svg'],
    headlights: ['assets/dusk/headlights.svg']
  },
  night: {
    scene: ['assets/night/scene.jpg', 'assets/night/scene.png', 'assets/night/scene.svg'],
    headlights: ['assets/night/headlights.svg']
  },
  midnight: {
    scene: ['assets/midnight/scene.jpg', 'assets/midnight/scene.png', 'assets/midnight/scene.svg'],
    headlights: ['assets/midnight/headlights.svg']
  }
};

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
const batteryStatusEl = document.getElementById('battery-status');

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

  // Format 12-hour AM/PM time
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const h12Str = String(h12).padStart(2, '0');
  const timeStr = h12Str + ':' + min + ' ' + ampm;

  // Date: "TUESDAY · 22 SEPTEMBER 2026"
  if (hudDateEl) hudDateEl.textContent =
    DAY_NAMES[d.getDay()].toUpperCase() + ' · ' + d.getDate() + ' ' + MONTH_NAMES[d.getMonth()].toUpperCase() + ' ' + d.getFullYear();

  // Time: "06:42 AM"
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
  if (batteryStatusEl) batteryStatusEl.textContent = charging ? 'Charging' : '';
  if (batteryWidget) batteryWidget.classList.remove('is-unavailable');
}

function showBatteryUnavailable() {
  if (batteryPctEl) batteryPctEl.textContent = 'N/A';
  if (batteryStatusEl) batteryStatusEl.textContent = 'No API';
  if (batteryWidget) batteryWidget.classList.add('is-unavailable');
}

function initBattery() {
  // ── Source 1: WebView2 native bridge (C# host → JS message) ──────────
  // When running inside the NightdriveHost app, the C# BatteryHelper sends
  // JSON messages via CoreWebView2.PostWebMessageAsJson every 30 seconds.
  // This gives genuine Windows battery data in all browsers/runtimes.
  if (window.chrome && window.chrome.webview) {
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
    if (batteryStatusEl) batteryStatusEl.textContent = '';
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

// WiFi button — open Windows network settings
if (wifiBtn) {
  wifiBtn.addEventListener('click', () => {
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage(JSON.stringify({ action: 'open_wifi_settings' }));
    } else {
      // Fallback: open ms-settings in the browser tab
      try { window.open('ms-settings:network-wifi'); } catch (e) { }
    }
  });
}

// Bluetooth button — open Windows Bluetooth settings
if (btBtn) {
  btBtn.addEventListener('click', () => {
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage(JSON.stringify({ action: 'open_bt_settings' }));
    } else {
      try { window.open('ms-settings:bluetooth'); } catch (e) { }
    }
  });
}

// Audio click — open Windows sound settings via C# bridge or ms-settings fallback
const audioWidgetEl = document.getElementById('conn-audio');
if (audioWidgetEl) {
  audioWidgetEl.addEventListener('click', () => {
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage(JSON.stringify({ action: 'open_sound_settings' }));
    } else {
      try { window.open('ms-settings:sound'); } catch (e) { }
    }
  });
}

// Initial state from browser navigator
setWifiState(navigator.onLine);
setBtState(null);

// Live WiFi state from browser events
window.addEventListener('online', () => setWifiState(true));
window.addEventListener('offline', () => setWifiState(false));

// C# WebView2 bridge (receives real system data)
if (window.chrome && window.chrome.webview) {
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
async function ensureAssets(periodId) {
  if (assetsReady[periodId]) return assetsCache[periodId];

  const assets = ASSETS[periodId] || { scene: [], headlights: [] };
  const period = periodById(periodId);
  const sceneAsset = await loadFirstAvailable(assets.scene);
  const hlAsset = period && period.headlights
    ? await loadFirstAvailable(assets.headlights)
    : null;

  assetsCache[periodId] = { scene: sceneAsset, headlights: hlAsset };
  assetsReady[periodId] = true;
  return assetsCache[periodId];
}

/* ══════════════════════════════════════════════
   LAYER POPULATION
   ══════════════════════════════════════════════ */

function fillLayer(layer, period, sceneAsset, headlightAsset) {
  const fallback = layer.querySelector('.scene-fallback');
  const svgScene = layer.querySelector('.svg-scene');
  const sceneImg = layer.querySelector('.scene-img');
  const svgLights = layer.querySelector('.svg-headlights');
  const headImg = layer.querySelector('.headlight-img');

  fallback.setAttribute('data-period', period.id);
  svgScene.innerHTML = '';
  svgLights.innerHTML = '';
  svgLights.classList.remove('is-on');
  headImg.removeAttribute('src');
  headImg.classList.remove('is-on');

  // Scene
  if (sceneAsset && sceneAsset.kind === 'svg') {
    svgScene.innerHTML = sceneAsset.svg;
    sceneImg.removeAttribute('src');
    sceneImg.classList.remove('is-loaded');
  } else if (sceneAsset && sceneAsset.kind === 'raster') {
    sceneImg.src = sceneAsset.src;
    sceneImg.classList.add('is-loaded');
  } else {
    sceneImg.removeAttribute('src');
    sceneImg.classList.remove('is-loaded');
  }

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

function lerpCTColor(colorA, colorB, t) {
  // Both are rgba(r,g,b,a) strings. We just crossfade opacity; the colours
  // are designed so that blending them by changing opacity is sufficient.
  // We use a single overlay with the "to" colour and set its opacity to t.
  return colorB;
}

function applyCTOverlay(blendState) {
  const fromP = periodById(blendState.from);
  const toP = periodById(blendState.to);
  if (!fromP || !toP) return;

  const t = blendState.ratio;

  // Use the "to" period colour; set opacity to fade it in
  // (If fully in one period, t=1 and we show that period's colour.)
  const ctColor = t >= 1 ? (toP.ctColor || 'transparent') : (toP.ctColor || 'transparent');
  ctOverlay.style.background = ctColor;
  ctOverlay.style.opacity = String(t * 0.85); // max 85% so it's subtle
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

/**
 * Set the opacity of all headlight overlay images/SVGs in a layer.
 * During the dusk blend window we fade from 0 → 0.72.
 * In full night the opacity is 0.72 (the Phase-2 default).
 */
function setHeadlightOpacity(layer, opacity) {
  const svgLights = layer.querySelector('.svg-headlights');
  const headImg = layer.querySelector('.headlight-img');
  const op = Math.max(0, Math.min(1, opacity));
  if (svgLights && !svgLights.classList.contains('headlight-flare')) svgLights.style.opacity = String(op);
  if (headImg && !headImg.classList.contains('headlight-flare')) headImg.style.opacity = String(op);
}

/**
 * Compute headlight opacity from the blend state.
 * Headlights are ON for dusk and night. During the dusk transition window
 * (approaching dusk from goldenHour) they fade in proportionally.
 * During the morning transition (night → morning) they fade out.
 */
function headlightOpacityFor(periodId, blendState) {
  const p = periodById(periodId);
  if (!p) return 0;
  if (!p.headlights) return 0;

  // The layer itself fades in/out via layer.style.opacity.
  // We simply return the target opacity (0.72) and let the layer transition and 
  // the volumetric blend math handle the interpolation linearly.
  return 0.72;
}

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
  fillLayer(layer, period, cached.scene, cached.headlights);
}

function rafTick() {
  if (mode !== 'auto') {
    rafHandle = null;
    return;
  }

  const m = minutesNow();
  const blend = computeBlend(m);

  // Determine which layers need which scenes
  const needFrom = blend.from;
  const needTo = blend.to;

  // Toggle Moon Visibility
  const stage = document.getElementById('stage');
  if (stage) {
    if (needTo === 'night' || needTo === 'midnight') {
      stage.classList.add('is-night');
    } else {
      stage.classList.remove('is-night');
    }
  }

  // If both are the same (no blend), just show fully
  if (needFrom === needTo) {
    if (layerAId !== needTo) {
      layerAId = needTo;
      ensureLayerPopulated(layerA, needTo);
    }
    layerA.style.opacity = '1';
    layerB.style.opacity = '0';

    // Headlights
    const period = periodById(needTo);
    const hlOp = period && period.headlights ? 0.72 : 0;
    setHeadlightOpacity(layerA, hlOp);
    setHeadlightOpacity(layerB, 0);

    const globalHlOp = hlOp / 0.72;
    // document.getElementById('volumetric-lights').style.opacity = String(globalHlOp); // Removed because SVG handles it
    if (typeof drawParticles === 'function') drawParticles(globalHlOp);

    applyCTOverlay(blend);
    applyAccentFromBlend(blend);
    updateBlendInfo(blend);

  } else {
    // Two different periods — blend
    const ratio = blend.ratio;  // 0 = fully "from", 1 = fully "to"

    // Populate layers if needed
    if (layerAId !== needFrom) {
      layerAId = needFrom;
      ensureLayerPopulated(layerA, needFrom);
    }
    if (layerBId !== needTo) {
      layerBId = needTo;
      ensureLayerPopulated(layerB, needTo);
    }

    layerA.style.opacity = String(1 - ratio);  // from fades out
    layerB.style.opacity = String(ratio);       // to fades in

    // Headlights for each layer
    const hlOpA = headlightOpacityFor(needFrom, blend);
    const hlOpB = headlightOpacityFor(needTo, blend);
    setHeadlightOpacity(layerA, hlOpA);
    setHeadlightOpacity(layerB, hlOpB);

    const globalHlOp = (hlOpA * (1 - ratio) + hlOpB * ratio) / 0.72;
    // document.getElementById('volumetric-lights').style.opacity = String(globalHlOp);
    if (typeof drawParticles === 'function') drawParticles(globalHlOp);

    applyCTOverlay(blend);
    applyAccentFromBlend(blend);
    updateBlendInfo(blend);

    // Update current/scene name for dev panel
    const domPeriod = ratio >= 0.5 ? periodById(needTo) : periodById(needFrom);
    if (domPeriod) {
      currentId = domPeriod.id;
      const sceneNameEl = document.getElementById('scene-name');
      if (sceneNameEl) sceneNameEl.textContent = domPeriod.label;
    }
  }

  // Sync dev-panel clock (always)
  const clockEl = document.getElementById('clock');
  if (clockEl) clockEl.textContent = formatTime(new Date());

  rafHandle = requestAnimationFrame(rafTick);
}

function applyAccentFromBlend(blend) {
  // Use the dominant (to) period for accent colour
  const p = periodById(blend.to) || periodById(blend.from);
  if (p) applyAccent(p);
}

function updateBlendInfo(blend) {
  const blendInfoEl = document.getElementById('blend-info');
  if (!blendInfoEl) return;
  if (blend.from === blend.to) {
    blendInfoEl.textContent = blend.to + ' 100%';
  } else {
      blend.from + ' -> ' + blend.to + ' (' + Math.round(blend.ratio * 100) + '%)';
      blend.from + ' → ' + blend.to + ' (' + Math.round(blend.ratio * 100) + '%)';
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

  // Restore CSS-driven transitions for manual mode
  layerA.style.transition = 'opacity 1.6s cubic-bezier(0.4,0,0.2,1)';
  layerB.style.transition = 'opacity 1.6s cubic-bezier(0.4,0,0.2,1)';

  const front = frontIsA ? layerA : layerB;
  const back = frontIsA ? layerB : layerA;

  fillLayer(back, period, cached.scene, cached.headlights);
  const hlOp = period.headlights ? 0.72 : 0;
  setHeadlightOpacity(back, hlOp);
  // document.getElementById('volumetric-lights').style.opacity = String(hlOp / 0.72);

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
  }, TRANSITION_MS);
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

// 1. Determine initial scene from clock
const _initM = minutesNow();
const _initBlend = computeBlend(_initM);

// Populate layerA with the "from" scene synchronously enough
// (ensureAssets is async but the rAF won't paint until assets resolve)
layerAId = _initBlend.from;
layerBId = _initBlend.to;

// Pre-load both scenes that may be visible at startup
Promise.all([
  ensureLayerPopulated(layerA, _initBlend.from),
  ensureLayerPopulated(layerB, _initBlend.to)
]).then(function () {
  logToHost("6. First actual engine frame (assets fetched and painted)");
  
  // STAGE 3: Notify host to hide fallback Image because first frame is ready
  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.postMessage(JSON.stringify({ action: 'hide_fallback' }));
  }

  // STAGE 4: Load secondary non-essential features
  updateHUD();
  clockTimer = setInterval(updateHUD, CLOCK_MS);
  logToHost("7. Essential widgets becoming visible");
  
  initBattery();
  initWeather();
  initParticles();
  logToHost("8. Optional features becoming ready");
  
  // Start transitions and cinematic audio glitch
  setModeAuto();
  runCinematicStartup();
});

/* ══════════════════════════════════════════════
   CINEMATIC PARTICLES (DUST)
   ══════════════════════════════════════════════ */
const particlesCanvas = document.getElementById('particles-canvas');
const ctx = particlesCanvas ? particlesCanvas.getContext('2d') : null;
let particles = [];
let pW = 0, pH = 0;

function initParticles() {
  if (!particlesCanvas || !ctx) return;
  pW = particlesCanvas.width = window.innerWidth;
  pH = particlesCanvas.height = window.innerHeight;
  window.addEventListener('resize', () => {
    pW = particlesCanvas.width = window.innerWidth;
    pH = particlesCanvas.height = window.innerHeight;
  });

  // Spawn initial dust
  for (let i = 0; i < 70; i++) {
    particles.push(spawnParticle(true));
  }
}

function spawnParticle(randomY = false) {
  // Spawn in the illuminated region in front of the car
  // Since beams go down-left, focus roughly between 10% and 65% of screen width
  const x = pW * (0.10 + Math.random() * 0.55);
  return {
    x: x,
    y: randomY ? (pH * 0.78 + Math.random() * pH * 0.22) : (pH + 10),
    vx: (Math.random() - 0.5) * 0.5, // gentle horizontal drift
    vy: -Math.random() * 0.4 - 0.1,  // slow upward drift
    size: Math.random() * 1.8 + 0.4,
    life: Math.random(), // 0 to 1
    lifeRate: Math.random() * 0.003 + 0.001
  };
}

function drawParticles(globalHlOp) {
  if (!ctx || globalHlOp <= 0) {
    if (particlesCanvas) particlesCanvas.style.opacity = '0';
    return;
  }
  particlesCanvas.style.opacity = '1';

  ctx.clearRect(0, 0, pW, pH);

  // Subtle glowing dust color
  ctx.fillStyle = `rgba(210, 225, 255, ${globalHlOp * 0.35})`;

  for (let i = 0; i < particles.length; i++) {
    let p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life += p.lifeRate;

    // Natural non-linear drift
    p.x += Math.sin(p.life * Math.PI * 3) * 0.3;

    // Fade in/out based on life (0->1->0)
    const fade = Math.sin(p.life * Math.PI);

    if (fade > 0) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.globalAlpha = fade;
      ctx.fill();
    }

    // Reset if life ended or if drifting too high (above car headlights at ~76.5%)
    if (p.life >= 1 || p.y < pH * 0.765) {
      particles[i] = spawnParticle(false);
    }
  }
}

// initParticles is called after first frame

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

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => fetchWeather(pos.coords.latitude, pos.coords.longitude),
      err => {
        console.warn("Geolocation failed. Weather unavailable.");
        const el = document.getElementById('weather-temp');
        if (el) el.textContent = '--°C';
      }
    );
  } else {
    const el = document.getElementById('weather-temp');
    if (el) el.textContent = '--°C';
  }
}


// Remove CSS transition for auto mode (rAF drives opacity directly)
layerA.style.transition = 'none';
layerB.style.transition = 'none';

/* ══════════════════════════════════════════════
   CINEMATIC STARTUP SEQUENCE
   ══════════════════════════════════════════════ */
function runCinematicStartup() {
  const engineAudio = document.getElementById('engine-audio');
  const btnStart = document.getElementById('btn-start-engine');
  const audioUnlock = document.getElementById('audio-unlock');

  // Attempt to play audio
  const playAudio = () => {
    // Check if src exists and is not just the empty page URL
    if (engineAudio && engineAudio.getAttribute('src')) {
      engineAudio.volume = 1.0;
      engineAudio.play().catch(e => {
        console.warn("Autoplay blocked by browser. Audio will play on first click.");
      });
    }
  };

  const triggerIgnitionVisuals = () => {
    [layerA, layerB].forEach(layer => {
      const hlImg = layer.querySelector('.headlight-img');
      const svgHl = layer.querySelector('.svg-headlights');

      if (hlImg) {
        hlImg.style.opacity = '';
        hlImg.classList.remove('engine-idle');
        void hlImg.offsetWidth;
        hlImg.classList.add('headlight-flare');
        setTimeout(() => {
          hlImg.classList.remove('headlight-flare');
          hlImg.classList.add('engine-idle');
        }, 1500);
      }

      if (svgHl) {
        svgHl.style.opacity = '';
        svgHl.classList.remove('engine-idle');
        void svgHl.offsetWidth;
        svgHl.classList.add('headlight-flare');
        setTimeout(() => {
          svgHl.classList.remove('headlight-flare');
          svgHl.classList.add('engine-idle');
        }, 1500);
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

  // If browser blocks audio on load, listen for first click to play
  document.addEventListener('click', () => {
    if (engineAudio && engineAudio.paused) {
      engineAudio.play().catch(() => { });
    }
  }, { once: true });

  // 1. Initial delay
  setTimeout(() => {
    // 2. Play audio
    playAudio();

    // 3. Ignition flare & shake
    triggerIgnitionVisuals();

  }, 800);
}

// runCinematicStartup is called after first frame
// Focus Assist button - open Windows Focus settings
const focusBtn = document.getElementById('focus-btn');
if (focusBtn) {
  focusBtn.addEventListener('click', () => {
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage(JSON.stringify({ action: 'open_focus_settings' }));
    } else {
      try { window.open('ms-settings:quietmomentshome'); } catch (e) { }
    }
  });
}

/* ══════════════════════════════════════════════
   MODE SWITCHER LOGIC
   ══════════════════════════════════════════════ */
;(function initThemeSwitcher() {
  const savedTheme = localStorage.getItem('nightdrive_theme') || 'windows';
  document.body.setAttribute('data-theme', savedTheme);

  const themeBtn = document.getElementById('theme-switcher-btn');
  const themeModal = document.getElementById('theme-modal');
  const themeClose = document.getElementById('theme-modal-close');
  const themeOptions = document.querySelectorAll('.theme-option');

  if (!themeBtn || !themeModal) return;

  function updateActiveOption() {
    const current = document.body.getAttribute('data-theme');
    themeOptions.forEach(opt => {
      if (opt.getAttribute('data-theme') === current) {
        opt.classList.add('active');
      } else {
        opt.classList.remove('active');
      }
    });
  }

  themeBtn.addEventListener('click', () => {
    updateActiveOption();
    themeModal.setAttribute('aria-hidden', 'false');
  });

  themeClose.addEventListener('click', () => {
    themeModal.setAttribute('aria-hidden', 'true');
  });

  themeOptions.forEach(opt => {
    opt.addEventListener('click', () => {
      const theme = opt.getAttribute('data-theme');
      document.body.setAttribute('data-theme', theme);
      localStorage.setItem('nightdrive_theme', theme);
      themeModal.setAttribute('aria-hidden', 'true');
      
      // Optionally notify C# host that theme changed (for diagnostic logging)
      logToHost("Theme changed to: " + theme);
    });
  });
})();