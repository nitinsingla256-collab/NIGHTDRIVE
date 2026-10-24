/**
 * NIGHTDRIVE — interface layer
 *
 * Everything in this file is UI: the edge drawer, the settings panel, the
 * control wiring, image import and persistence. The scene engine
 * (script.js) owns rendering and exposes a small `window.ND` API; this file
 * never reaches into engine internals.
 *
 * Ground rules this file follows:
 *   - A control only shows a state that has been verified. Where the platform
 *     cannot do something, the control says so instead of pretending.
 *   - Imported images are blobs, so they go to IndexedDB. localStorage holds
 *     the small preferences only.
 *   - Nothing here runs the engine start sequence. That is an explicit action.
 */
(function () {
  'use strict';

  if (!window.ND) {
    // The engine failed to boot. Say so rather than showing dead controls.
    console.error('[NIGHTDRIVE] engine API missing — interface disabled');
    return;
  }

  var ND = window.ND;
  var S = ND.settings;
  var reduceMotion = !!(ND.reducedMotion && ND.reducedMotion.matches);

  /* ══════════════════════════════════════════════════════════════════════
     DOM
     ══════════════════════════════════════════════════════════════════════ */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var drawer = $('#drawer');
  var trigger = $('#drawer-trigger');
  var rail = $('#drawer-rail');
  var panel = $('#panel');
  var scrim = $('#panel-scrim');
  var toastEl = $('#toast');

  /* ══════════════════════════════════════════════════════════════════════
     TOASTS — the only way a control reports what actually happened
     ══════════════════════════════════════════════════════════════════════ */

  var toastTimer = null;
  function toast(message, tone, ms) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.setAttribute('data-tone', tone || 'info');
    toastEl.hidden = false;
    // Force a frame so the transition runs after `hidden` is removed.
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-visible');
      setTimeout(function () { toastEl.hidden = true; }, 260);
    }, ms || 3200);
  }
  ND.on('toast', function (msg) { toast(msg); });
  ND.on('storage-error', function (d) { toast(d.message, 'error', 5000); });
  ND.on('exit-blocked', function () {
    toast('This window cannot close itself. Use the tray icon, Alt+F4, or the close button.', 'error', 5000);
  });
  ND.on('audio-blocked', function () {
    toast('The system blocked audio until you interact with the window. Click Start engine again.', 'error', 4200);
  });

  /* ══════════════════════════════════════════════════════════════════════
     CAPABILITIES
     Every platform-gated control reads this instead of guessing.
     ══════════════════════════════════════════════════════════════════════ */

  var caps = {
    // The Windows (.NET/WebView2) and macOS (WKWebView) hosts answer
    // `open_*_settings`. A generic embedder such as Lively does not, and
    // `nativeHostActive` only flips once a host message arrives.
    hostSettings: false,
    hostVolume: false,
    hostBrightness: false,
    hostQuit: false
  };

  function refreshCapabilities() {
    var p = ND.platform || {};
    var active = typeof ND.hostActive === 'function' ? ND.hostActive() : false;
    // Ask the host once; the reply (if any) proves it is ours.
    if (p.webview2 && !active) ND.postToHost('hello');
    caps.hostSettings = !!(p.wkhost || (p.webview2 && active));
    caps.hostQuit = !!(p.wkhost || (p.webview2 && active) || p.tauri);
    // The Windows host owns the real mixer, so the slider becomes the system
    // volume there and the hint says so instead of claiming otherwise.
    caps.hostVolume = !!(p.webview2 && active);

    var hint = document.getElementById('volume-hint');
    if (hint) {
      hint.textContent = caps.hostVolume
        ? 'This slider sets the system volume, through the Windows host.'
        : "Controls NIGHTDRIVE's own sound. System volume is the OS mixer.";
    }
  }

  function unsupported(what) {
    var p = ND.platform || {};
    var host = p.windows ? 'the Windows host' : (p.mac ? 'the macOS host' : 'a native host');
    toast(what + ' needs ' + host + '. This build is running in a web engine, so the control reports state only.', 'error', 5000);
  }

  /* ══════════════════════════════════════════════════════════════════════
     STORAGE — IndexedDB for image blobs, localStorage for preferences
     ══════════════════════════════════════════════════════════════════════ */

  var DB_NAME = 'nightdrive';
  var DB_STORE = 'assets';
  var memoryFallback = {};      // used when IndexedDB is unavailable
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('indexedDB open failed')); };
    });
    return dbPromise;
  }

  function idbPut(key, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var req = tx.objectStore(DB_STORE).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbDelete(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      });
    });
  }

  /** Store a blob under `key`, falling back to memory if the DB is blocked. */
  function storeImage(key, blob) {
    var url = URL.createObjectURL(blob);
    return idbPut(key, blob).then(function () {
      return url;
    }).catch(function () {
      memoryFallback[key] = blob;
      toast('This browser blocks local storage for images. The wallpaper works now but will not survive a restart.', 'error', 6000);
      return url;
    });
  }

  function loadImage(key) {
    if (memoryFallback[key]) return Promise.resolve(URL.createObjectURL(memoryFallback[key]));
    return idbGet(key).then(function (blob) {
      return blob ? URL.createObjectURL(blob) : null;
    }).catch(function () { return null; });
  }

  /* ══════════════════════════════════════════════════════════════════════
     IMAGE IMPORT
     ══════════════════════════════════════════════════════════════════════ */

  var MAX_IMAGE_BYTES = 40 * 1024 * 1024;
  var ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

  function pickImage() {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = ACCEPTED.join(',');
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        input.remove();
        if (!file) { resolve(null); return; }
        if (ACCEPTED.indexOf(file.type) === -1) {
          toast('Unsupported file type. Use JPEG, PNG or WebP.', 'error');
          resolve(null); return;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          toast('That image is ' + Math.round(file.size / 1048576) + ' MB. The limit is 40 MB.', 'error', 5000);
          resolve(null); return;
        }
        resolve(file);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  function readDimensions(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = function () { resolve({ width: 0, height: 0 }); };
      img.src = url;
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     DRAWER
     ══════════════════════════════════════════════════════════════════════ */

  var drawerOpen = false;
  var openTimer = null;
  var closeTimer = null;

  function setDrawer(open, opts) {
    if (!drawer || !trigger) return;
    var o = opts || {};
    if (open === drawerOpen && !o.force) return;
    drawerOpen = open;
    drawer.classList.toggle('is-open', open);
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    // A collapsed drawer must not be reachable with Tab: aria-hidden alone
    // leaves its buttons focusable, which is a screen-reader trap.
    if ('inert' in drawer) drawer.inert = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (rail) rail.style.opacity = open ? '0' : '';
    if (open) {
      clearTimeout(closeTimer);
    } else if (document.activeElement && drawer.contains(document.activeElement)) {
      trigger.focus();
    }
  }

  function openDrawer() {
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    openTimer = setTimeout(function () { setDrawer(true); }, 90);
  }

  function scheduleClose() {
    clearTimeout(openTimer);
    if (S.drawerPinned) return;
    clearTimeout(closeTimer);
    // 380 ms of grace: long enough to cross the 14 px gap, short enough that
    // the panel never feels stuck open.
    closeTimer = setTimeout(function () {
      if (!S.drawerPinned && !drawerContainsFocus()) setDrawer(false);
    }, 380);
  }

  function drawerContainsFocus() {
    return !!(drawer && document.activeElement && drawer.contains(document.activeElement));
  }

  function bindDrawer() {
    if (!drawer || !trigger) return;

    // Pointer: the strip, the rail and the drawer body all keep it open.
    [trigger, rail, drawer].forEach(function (el) {
      if (!el) return;
      el.addEventListener('pointerenter', openDrawer);
      el.addEventListener('pointerleave', scheduleClose);
    });

    // A near-edge mouse move opens it too: the strip is only 14 px wide and
    // nobody aims that precisely at a wallpaper.
    window.addEventListener('mousemove', function (e) {
      if (!S.drawerEnabled) return;
      if (e.clientX <= 6) openDrawer();
    }, { passive: true });

    trigger.addEventListener('click', function () {
      setDrawer(!drawerOpen);
      if (drawerOpen) focusFirst(drawer);
    });

    trigger.addEventListener('focus', function () {
      if (S.drawerEnabled) setDrawer(true);
    });

    drawer.addEventListener('focusin', function () { clearTimeout(closeTimer); });
    drawer.addEventListener('focusout', function () { scheduleClose(); });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (panel && panel.classList.contains('is-open')) { closePanel(); return; }
      if (drawerOpen) { setDrawer(false); trigger.focus(); }
    });

    // Ctrl/Cmd+B toggles the drawer from anywhere — the mouse-free route.
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        setDrawer(!drawerOpen);
        if (drawerOpen) focusFirst(drawer);
      }
    });

    if (!S.drawerEnabled) document.body.classList.remove('drawer-enabled');
    else document.body.classList.add('drawer-enabled');
  }

  function focusFirst(root) {
    var el = root.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (el) el.focus({ preventScroll: true });
  }

  /* ══════════════════════════════════════════════════════════════════════
     PANEL
     ══════════════════════════════════════════════════════════════════════ */

  var panelOpen = false;
  var returnFocus = null;

  function openPanel() {
    if (!panel) return;
    returnFocus = document.activeElement;
    panel.hidden = false;
    if (scrim) scrim.hidden = false;
    requestAnimationFrame(function () {
      panel.classList.add('is-open');
      panel.setAttribute('aria-hidden', 'false');
      if (scrim) scrim.classList.add('is-open');
    });
    panelOpen = true;
    var first = panel.querySelector('button, input, select');
    if (first) first.focus({ preventScroll: true });
  }

  function closePanel() {
    if (!panel || !panelOpen) return;
    panelOpen = false;
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    if (scrim) scrim.classList.remove('is-open');
    setTimeout(function () {
      panel.hidden = true;
      if (scrim) scrim.hidden = true;
    }, 260);
    if (returnFocus && returnFocus.focus) returnFocus.focus({ preventScroll: true });
  }

  /* ══════════════════════════════════════════════════════════════════════
     UI HYDRATION — reflect verified state into the controls
     ══════════════════════════════════════════════════════════════════════ */

  function setPressed(sel, on) {
    var el = typeof sel === 'string' ? $(sel) : sel;
    if (!el) return;
    if (el.classList.contains('switch')) el.setAttribute('aria-checked', on ? 'true' : 'false');
    else el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function hydrate() {
    setPressed('#clock-visible', S.clockVisible);
    setPressed('#clock-24h', S.clock24);
    setPressed('#auto-scene', S.autoScene);
    setPressed('#auto-scene-setting', S.autoScene);
    setPressed('#headlights-btn', S.headlights === true);
    setPressed('#headlights-setting', S.headlights === true);
    setPressed('#playback-btn', S.playback);
    setPressed('#motion-toggle', S.motion);
    setPressed('#particles-toggle', S.particles);
    setPressed('#drawer-enabled', S.drawerEnabled);
    setPressed('#drawer-pinned-setting', S.drawerPinned);
    setPressed('#drawer-pin', S.drawerPinned);
    setPressed('#mute-btn', S.muted);

    setValue('#clock-scale', S.clockScale, '%');
    setValue('#clock-opacity', S.clockOpacity, '%');
    setValue('#clock-offset', S.clockOffset, '');
    setValue('#volume-range', S.volume, '%', '#volume-range-2', '#volume-range-2-out');
    setValue('#brightness-range', S.brightness, '%');
    setValue('#car-scale', S.carScale, '%');
    setValue('#car-x', S.carX, '%');
    setValue('#car-y', S.carY, '%');
    setValue('#bg-scale', S.bgScale, '%');
    setValue('#bg-x', S.bgX, '%');
    setValue('#bg-y', S.bgY, '%');
    setValue('#bg-brightness', S.bgBrightness, '%');
    setValue('#transition-speed', S.transitionMs, ' ms');

    var speedOut = $('#transition-speed-out');
    if (speedOut) speedOut.textContent = (S.transitionMs / 1000).toFixed(1) + ' s';

    setSeg('[data-action="bg.fit.cover"]', S.bgFit === 'cover');
    setSeg('[data-action="bg.fit.contain"]', S.bgFit === 'contain');
    setSeg('[data-action="car.fit.contain"]', S.carFit === 'contain');
    setSeg('[data-action="car.fit.cover"]', S.carFit === 'cover');
    setSeg('[data-action="mode.scene"]', S.mode === 'scenes');
    setSeg('[data-action="mode.custom"]', S.mode === 'custom');

    var startup = $('#startup-effect');
    if (startup) startup.value = S.startupEffect;

    updateSceneName(ND.state().sceneId);
    updatePlaybackIcon(S.playback);
    document.body.classList.toggle('drawer-enabled', !!S.drawerEnabled);

    var carControls = $('#car-controls');
    if (carControls) carControls.hidden = !hasCar;
    var bgControls = $('#bg-controls');
    if (bgControls) bgControls.hidden = !hasBackground;

    if (reduceMotion) {
      var hint = $('#motion-hint');
      if (hint) hint.textContent = 'Your system asks for reduced motion, so scene motion and the startup shake stay off.';
    }
  }

  function setSeg(sel, on) {
    var el = $(sel);
    if (el) el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function setValue(sel, value, suffix, mirrorSel, mirrorOutSel) {
    var el = $(sel);
    if (el) el.value = String(value);
    var out = document.getElementById((sel || '').replace('#', '') + '-out');
    if (out) out.textContent = value + (suffix || '');
    if (mirrorSel) {
      var m = $(mirrorSel);
      if (m) m.value = String(value);
      var mo = mirrorOutSel ? $(mirrorOutSel) : null;
      if (mo) mo.textContent = value + (suffix || '');
    }
  }

  function updateSceneName(id) {
    var el = $('#scene-name');
    if (!el) return;
    var period = (ND.periods || []).filter(function (p) { return p.id === id; })[0];
    el.textContent = period ? period.label : (S.autoScene ? 'Automatic' : '—');
  }

  function updatePlaybackIcon(playing) {
    var btn = $('#playback-btn');
    if (!btn) return;
    var use = btn.querySelector('use');
    if (use) use.setAttribute('href', playing ? '#i-play' : '#i-pause');
    var label = btn.querySelector('span');
    if (label) label.textContent = playing ? 'Playback' : 'Paused';
  }

  /* ══════════════════════════════════════════════════════════════════════
     CUSTOM ASSETS
     ══════════════════════════════════════════════════════════════════════ */

  var hasCar = false;
  var hasBackground = false;
  var pendingDesign = null;

  function applyCarOptions() {
    if (!hasCar) return;
    var src = carUrl;
    ND.setCar({ src: src }, { fit: S.carFit, scale: S.carScale, x: S.carX, y: S.carY });
  }

  var carUrl = null;
  var bgUrl = null;
  var designUrl = null;

  function importCar() {
    pickImage().then(function (file) {
      if (!file) return;
      return storeImage('car', file).then(function (url) {
        return readDimensions(url).then(function (dim) {
          if (!dim.width) { toast('That image could not be decoded.', 'error'); return; }
          carUrl = url;
          hasCar = true;
          applyCarOptions();
          toast(hasBackground
            ? 'Car image applied.'
            : 'Car image applied over the built-in scene. Import a background for a fully custom scene.', 'ok', 5000);
          hydrate();
        });
      });
    }).catch(function (e) {
      console.warn(e);
      toast('The car image could not be stored.', 'error');
    });
  }

  function clearCar() {
    carUrl = null;
    hasCar = false;
    ND.setCar(null);
    idbDelete('car').catch(function () { delete memoryFallback.car; });
    toast('Back to the photographed car.', 'ok');
    hydrate();
  }

  function importBackground() {
    pickImage().then(function (file) {
      if (!file) return;
      return storeImage('bg', file).then(function (url) {
        return readDimensions(url).then(function (dim) {
          if (!dim.width) { toast('That image could not be decoded.', 'error'); return; }
          bgUrl = url;
          hasBackground = true;
          S.mode = 'custom';
          S.useDesign = false;
          ND.save({ mode: 'custom', useDesign: false });
          ND.setBackground({ src: url }, {
            fit: S.bgFit, scale: S.bgScale, x: S.bgX, y: S.bgY, brightness: S.bgBrightness
          });
          toast('Background applied — ' + dim.width + '×' + dim.height + '.', 'ok');
          hydrate();
        });
      });
    }).catch(function (e) {
      console.warn(e);
      toast('The background could not be stored.', 'error');
    });
  }

  function clearBackground() {
    bgUrl = null;
    hasBackground = false;
    ND.setBackground(null);
    idbDelete('bg').catch(function () { delete memoryFallback.bg; });
    if (S.useDesign) {
      ND.setDesign(null);
      S.useDesign = false;
      designUrl = null;
      idbDelete('design').catch(function () { });
    }
    ND.save({ mode: hasCar ? 'custom' : 'scenes', useDesign: false });
    toast('Back to the built-in scenes.', 'ok');
    hydrate();
  }

  function importDesign() {
    pickImage().then(function (file) {
      if (!file) return;
      var url = URL.createObjectURL(file);
      readDimensions(url).then(function (dim) {
        if (!dim.width) { toast('That image could not be decoded.', 'error'); return; }
        pendingDesign = { file: file, url: url, width: dim.width, height: dim.height };
        var wrap = $('#design-preview-wrap');
        var img = $('#design-preview');
        var name = $('#design-name');
        var size = $('#design-size');
        if (img) img.src = url;
        if (name) name.textContent = file.name || 'Imported design';
        if (size) size.textContent = dim.width + '×' + dim.height;
        if (wrap) wrap.hidden = false;
        if (panel) panel.scrollTop = 0;
        toast('Preview ready. Apply it when you are happy with it.', 'ok');
      });
    });
  }

  function applyDesign() {
    if (!pendingDesign) { toast('Import a design first.', 'error'); return; }
    storeImage('design', pendingDesign.file).then(function (storedUrl) {
      designUrl = storedUrl;
      ND.setDesign({ src: storedUrl });
      ND.save({ mode: 'custom', useDesign: true });
      hasBackground = true;
      hasCar = false;
      ND.setCar(null);
      var wrap = $('#design-preview-wrap');
      if (wrap) wrap.hidden = true;
      pendingDesign = null;
      toast('Design applied as the whole wallpaper.', 'ok');
      hydrate();
    }).catch(function () {
      toast('The design could not be stored.', 'error');
    });
  }

  function discardDesign() {
    if (pendingDesign && pendingDesign.url) URL.revokeObjectURL(pendingDesign.url);
    pendingDesign = null;
    var wrap = $('#design-preview-wrap');
    if (wrap) wrap.hidden = true;
    toast('Import discarded.', 'info', 2200);
  }

  function clearDesign() {
    ND.setDesign(null);
    ND.save({ mode: 'scenes', useDesign: false });
    hasBackground = false;
    designUrl = null;
    idbDelete('design').catch(function () { delete memoryFallback.design; });
    toast('Back to the original NIGHTDRIVE design.', 'ok');
    hydrate();
  }

  /* ══════════════════════════════════════════════════════════════════════
     CONTROL REGISTRY
     One handler per data-action. `controls.html` markup refers only to these
     names, and validate.mjs fails if a button names an action that is missing
     here — that is how a dead control gets caught without a browser.
     ══════════════════════════════════════════════════════════════════════ */

  var actions = {
    'drawer.pin': function () {
      S.drawerPinned = !S.drawerPinned;
      ND.save({ drawerPinned: S.drawerPinned });
      setPressed('#drawer-pin', S.drawerPinned);
      setPressed('#drawer-pinned-setting', S.drawerPinned);
      if (S.drawerPinned) setDrawer(true);
      toast(S.drawerPinned ? 'Drawer pinned open.' : 'Drawer closes when the pointer leaves.', 'info', 2200);
    },
    'drawer.close': function () { setDrawer(false); },
    'drawer.enabled': function () {
      S.drawerEnabled = !S.drawerEnabled;
      ND.save({ drawerEnabled: S.drawerEnabled });
      setPressed('#drawer-enabled', S.drawerEnabled);
      document.body.classList.toggle('drawer-enabled', S.drawerEnabled);
      if (!S.drawerEnabled) setDrawer(false);
      toast(S.drawerEnabled ? 'Edge trigger enabled.' : 'Edge trigger disabled. Ctrl+B still opens the drawer.', 'info', 3000);
    },
    'panel.open': function () { openPanel(); },
    'panel.close': function () { closePanel(); },

    'system.wifi': function () {
      ND.openSystemSettings('wifi');
      if (caps.hostSettings) toast('Opening network settings…', 'ok', 2200);
      else unsupported('Opening Wi-Fi settings');
    },
    'system.bt': function () {
      ND.openSystemSettings('bt');
      if (caps.hostSettings) toast('Opening Bluetooth settings…', 'ok', 2200);
      else unsupported('Opening Bluetooth settings');
    },
    'system.volumeSettings': function () {
      ND.openSystemSettings('sound');
      if (caps.hostSettings) toast('Opening the system volume panel…', 'ok', 2200);
      else unsupported('Opening system volume');
    },
    'audio.mute': function () {
      S.muted = !S.muted;
      ND.setMuted(S.muted);
      setPressed('#mute-btn', S.muted);
      toast(S.muted ? 'NIGHTDRIVE audio muted.' : 'NIGHTDRIVE audio on at ' + S.volume + '%.', 'info', 2200);
    },

    'scene.prev': function () { ND.stepScene(-1); updateSceneName(ND.state().sceneId); },
    'scene.next': function () { ND.stepScene(1); updateSceneName(ND.state().sceneId); },
    'scene.cycle': function () { ND.stepScene(1); updateSceneName(ND.state().sceneId); },
    'scene.auto': function () {
      S.autoScene = !S.autoScene;
      ND.setAutoScene(S.autoScene);
      ND.setHeadlights(null);            // following the clock means following the lamps
      S.headlights = null;
      setPressed('#auto-scene', S.autoScene);
      setPressed('#auto-scene-setting', S.autoScene);
      setPressed('#headlights-btn', false);
      setPressed('#headlights-setting', false);
      updateSceneName(ND.state().sceneId);
      toast(S.autoScene ? 'Scene follows the clock.' : 'Scene fixed — use the arrows to change it.', 'info', 2600);
    },
    'scene.headlights': function () {
      var on = !(S.headlights === true);
      S.headlights = on;
      ND.setHeadlights(on);
      setPressed('#headlights-btn', on);
      setPressed('#headlights-setting', on);
      toast(on ? 'Headlights on.' : 'Headlights off.', 'info', 1800);
    },
    'scene.playback': function () {
      S.playback = !S.playback;
      ND.setPlayback(S.playback);
      updatePlaybackIcon(S.playback);
      toast(S.playback ? 'Playback resumed.' : 'Playback paused — the clock keeps time.', 'info', 2200);
    },
    'engine.start': function () {
      ND.startEngine();
      toast(S.muted ? 'Engine start — sound is muted.' : 'Engine started.', 'ok', 2400);
    },

    'clock.visible': function () {
      S.clockVisible = !S.clockVisible;
      ND.save({ clockVisible: S.clockVisible });
      ND.applyClockSettings();
      setPressed('#clock-visible', S.clockVisible);
      toast(S.clockVisible ? 'Clock shown.' : 'Clock hidden.', 'info', 1800);
    },
    'clock.format': function () {
      S.clock24 = !S.clock24;
      ND.save({ clock24: S.clock24 });
      ND.applyClockSettings();
      setPressed('#clock-24h', S.clock24);
      toast(S.clock24 ? '24-hour clock.' : '12-hour clock.', 'info', 1800);
    },

    'mode.scene': function () {
      ND.save({ mode: 'scenes', useDesign: false });
      S.mode = 'scenes';
      S.useDesign = false;
      ND.setDesign(null);
      if (hasBackground) {
        ND.setBackground({ src: bgUrl }, {
          fit: S.bgFit, scale: S.bgScale, x: S.bgX, y: S.bgY, brightness: S.bgBrightness
        });
      }
      if (hasCar) ND.setCar({ src: carUrl }, { fit: S.carFit, scale: S.carScale, x: S.carX, y: S.carY });
      toast(hasBackground ? 'Custom scene: background + car.' : 'Built-in scenes.', 'info', 2400);
      hydrate();
    },
    'mode.custom': function () {
      if (!hasBackground && !hasCar && !designUrl) {
        toast('Import a background or a car image first.', 'error', 3200);
        return;
      }
      ND.save({ mode: 'custom', useDesign: !!designUrl });
      S.mode = 'custom';
      if (designUrl) ND.setDesign({ src: designUrl });
      else if (hasBackground) ND.setBackground({ src: bgUrl }, { fit: S.bgFit, scale: S.bgScale, x: S.bgX, y: S.bgY, brightness: S.bgBrightness });
      if (hasCar) ND.setCar({ src: carUrl }, { fit: S.carFit, scale: S.carScale, x: S.carX, y: S.carY });
      toast('Custom scene active.', 'info', 2400);
      hydrate();
    },

    'car.import': importCar,
    'car.clear': clearCar,
    'car.fit.contain': function () { S.carFit = 'contain'; ND.save({ carFit: 'contain' }); applyCarOptions(); setSeg('[data-action="car.fit.contain"]', true); setSeg('[data-action="car.fit.cover"]', false); },
    'car.fit.cover': function () { S.carFit = 'cover'; ND.save({ carFit: 'cover' }); applyCarOptions(); setSeg('[data-action="car.fit.contain"]', false); setSeg('[data-action="car.fit.cover"]', true); },

    'bg.import': importBackground,
    'bg.clear': clearBackground,
    'bg.fit.cover': function () { S.bgFit = 'cover'; ND.save({ bgFit: 'cover' }); if (bgUrl) ND.setBackground({ src: bgUrl }, { fit: 'cover', scale: S.bgScale, x: S.bgX, y: S.bgY, brightness: S.bgBrightness }); setSeg('[data-action="bg.fit.cover"]', true); setSeg('[data-action="bg.fit.contain"]', false); },
    'bg.fit.contain': function () { S.bgFit = 'contain'; ND.save({ bgFit: 'contain' }); if (bgUrl) ND.setBackground({ src: bgUrl }, { fit: 'contain', scale: S.bgScale, x: S.bgX, y: S.bgY, brightness: S.bgBrightness }); setSeg('[data-action="bg.fit.cover"]', false); setSeg('[data-action="bg.fit.contain"]', true); },

    'design.import': importDesign,
    'design.apply': applyDesign,
    'design.discard': discardDesign,
    'design.clear': clearDesign,

    'perf.motion': function () {
      S.motion = !S.motion;
      ND.save({ motion: S.motion });
      setPressed('#motion-toggle', S.motion);
      if (!S.motion) ND.setPlayback(false);
      toast(S.motion ? 'Scene motion on.' : 'Scene motion off — a still photograph.', 'info', 2400);
    },
    'perf.particles': function () {
      S.particles = !S.particles;
      ND.save({ particles: S.particles });
      setPressed('#particles-toggle', S.particles);
      toast(S.particles ? 'Dust motes on.' : 'Dust motes off.', 'info', 1800);
    },

    'app.exit': function () {
      if (!caps.hostQuit) {
        // A browser tab cannot close itself; try, and tell the truth after.
        ND.exit();
        return;
      }
      ND.exit();
      toast('Closing NIGHTDRIVE…', 'info', 1600);
    },
    'app.reset': function () {
      if (!resetArmed) {
        resetArmed = true;
        toast('Click Restore defaults again to confirm.', 'error', 4200);
        clearTimeout(resetTimer);
        resetTimer = setTimeout(function () { resetArmed = false; }, 4200);
        return;
      }
      resetArmed = false;
      clearTimeout(resetTimer);
      doReset();
    }
  };

  var resetArmed = false;
  var resetTimer = null;

  function doReset() {
    ['car', 'bg', 'design'].forEach(function (k) { idbDelete(k).catch(function () { }); delete memoryFallback[k]; });
    hasCar = false;
    hasBackground = false;
    carUrl = null;
    bgUrl = null;
    designUrl = null;
    pendingDesign = null;
    ND.setCar(null);
    ND.setDesign(null);
    ND.setBackground(null);
    ND.reset();
    ND.applyClockSettings();
    ND.applyBrightness();
    ND.applyAudioSettings();
    ND.setHeadlights(null);
    ND.setPlayback(true);
    ND.setAutoScene(true);
    hydrate();
    toast('Everything restored to defaults.', 'ok');
  }

  function runAction(name, el) {
    var fn = actions[name];
    if (!fn) {
      console.warn('[NIGHTDRIVE] no handler for action', name);
      toast('That control is not available in this build.', 'error');
      return;
    }
    try {
      fn(el);
    } catch (e) {
      console.error('[NIGHTDRIVE] action failed', name, e);
      toast('That action failed: ' + e.message, 'error', 4500);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     RANGE INPUTS
     ══════════════════════════════════════════════════════════════════════ */

  function bindRange(id, handler) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', function () { handler(parseFloat(el.value), el); });
  }

  function bindRanges() {
    bindRange('volume-range', function (v) {
      S.volume = v;
      ND.setVolume(v);
      setValue('#volume-range', v, '%');
    });
    bindRange('volume-range-2', function (v) {
      S.volume = v;
      ND.setVolume(v);
      setValue('#volume-range', v, '%');
      var out2 = $('#volume-range-2-out');
      if (out2) out2.textContent = v + '%';
    });
    bindRange('brightness-range', function (v) {
      S.brightness = v;
      ND.save({ brightness: v });
      ND.applyBrightness();
      var out = $('#brightness-value');
      if (out) out.textContent = v + '%';
    });
    bindRange('clock-scale', function (v) {
      S.clockScale = v;
      ND.save({ clockScale: v });
      ND.applyClockSettings();
      var out = $('#clock-scale-out');
      if (out) out.textContent = v + '%';
    });
    bindRange('clock-opacity', function (v) {
      S.clockOpacity = v;
      ND.save({ clockOpacity: v });
      ND.applyClockSettings();
      var out = $('#clock-opacity-out');
      if (out) out.textContent = v + '%';
    });
    bindRange('clock-offset', function (v) {
      S.clockOffset = v;
      ND.save({ clockOffset: v });
      ND.applyClockSettings();
      var out = $('#clock-offset-out');
      if (out) out.textContent = String(v);
    });
    bindRange('transition-speed', function (v) {
      S.transitionMs = v;
      ND.save({ transitionMs: v });
      var out = $('#transition-speed-out');
      if (out) out.textContent = (v / 1000).toFixed(1) + ' s';
    });

    ['car-scale', 'car-x', 'car-y'].forEach(function (id) {
      bindRange(id, function (v) {
        var key = id === 'car-scale' ? 'carScale' : (id === 'car-x' ? 'carX' : 'carY');
        S[key] = v;
        ND.save({ [key]: v });
        var out = document.getElementById(id + '-out');
        if (out) out.textContent = v + '%';
        applyCarOptions();
      });
    });

    ['bg-scale', 'bg-x', 'bg-y', 'bg-brightness'].forEach(function (id) {
      bindRange(id, function (v) {
        var key = id === 'bg-scale' ? 'bgScale' : (id === 'bg-x' ? 'bgX' : (id === 'bg-y' ? 'bgY' : 'bgBrightness'));
        S[key] = v;
        ND.save({ [key]: v });
        var out = document.getElementById(id + '-out');
        if (out) out.textContent = v + '%';
        if (bgUrl) {
          ND.setBackground({ src: bgUrl }, {
            fit: S.bgFit, scale: S.bgScale, x: S.bgX, y: S.bgY, brightness: S.bgBrightness
          });
        }
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     BOOT
     ══════════════════════════════════════════════════════════════════════ */

  function restoreSavedAssets() {
    var jobs = [];
    jobs.push(loadImage('car').then(function (url) {
      if (!url) return;
      carUrl = url;
      hasCar = true;
    }));
    jobs.push(loadImage('bg').then(function (url) {
      if (!url) return;
      bgUrl = url;
      hasBackground = true;
    }));
    jobs.push(loadImage('design').then(function (url) {
      if (!url) return;
      designUrl = url;
    }));

    return Promise.all(jobs).then(function () {
      if (S.mode === 'custom') {
        if (S.useDesign && designUrl) ND.setDesign({ src: designUrl });
        else if (bgUrl) {
          ND.setBackground({ src: bgUrl }, { fit: S.bgFit, scale: S.bgScale, x: S.bgX, y: S.bgY, brightness: S.bgBrightness });
          if (hasCar) ND.setCar({ src: carUrl }, { fit: S.carFit, scale: S.carScale, x: S.carX, y: S.carY });
        }
      } else if (hasCar) {
        ND.setCar({ src: carUrl }, { fit: S.carFit, scale: S.carScale, x: S.carX, y: S.carY });
      }
      hydrate();
    }).catch(function (e) {
      console.warn('[NIGHTDRIVE] could not restore images', e);
      toast('Saved images could not be restored. The default scenes are showing.', 'error', 5000);
      hydrate();
    });
  }

  function bindMisc() {
    // Delegated clicks: every control in the markup carries data-action.
    document.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-action]') : null;
      if (!el) return;
      var name = el.getAttribute('data-action');
      if (!name) return;
      e.preventDefault();
      runAction(name, el);
    });

    // Panel scrim and close.
    if (scrim) scrim.addEventListener('click', closePanel);

    // Startup effect select.
    var startup = $('#startup-effect');
    if (startup) {
      startup.addEventListener('change', function () {
        S.startupEffect = startup.value;
        ND.save({ startupEffect: startup.value });
        toast(startup.value === 'manual'
          ? 'Startup effects only when you start the engine.'
          : startup.value === 'once'
            ? 'Startup effects play once per app launch.'
            : 'Startup effects play on every wallpaper load.', 'info', 3200);
      });
    }

    // Keep the UI in step with whatever the engine does on its own.
    ND.on('scene', function (d) { updateSceneName(d.id); });
    ND.on('settings', function () { });
    ND.on('ready', function () { refreshCapabilities(); hydrate(); });
  }

  function init() {
    document.body.classList.toggle('drawer-enabled', !!S.drawerEnabled);
    bindDrawer();
    bindRanges();
    bindMisc();
    hydrate();
    restoreSavedAssets();
    refreshCapabilities();

    // The Windows/macOS hosts answer our hello once they are listening.
    setTimeout(refreshCapabilities, 1200);
    setTimeout(refreshCapabilities, 4000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Exposed for tests and for the console.
  window.NDUI = {
    actions: actions,
    setDrawer: setDrawer,
    openPanel: openPanel,
    closePanel: closePanel,
    toast: toast,
    state: function () {
      return {
        drawerOpen: drawerOpen,
        panelOpen: panelOpen,
        hasCar: hasCar,
        hasBackground: hasBackground,
        pinned: S.drawerPinned
      };
    }
  };
})();
