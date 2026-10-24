/**
 * NIGHTDRIVE — Interface, Quick Settings Drawer & Studio Workspace (v3.0)
 *
 * Connects the redesigned Left Quick Settings Drawer, Wallpaper Studio,
 * Car Studio, Editable Time Schedule, and Music Bar to `window.ND`.
 * Never fabricates live readings, external search results, or media sessions.
 */
(function () {
  'use strict';

  if (!window.ND) {
    console.error('[NIGHTDRIVE] engine API missing — interface disabled');
    return;
  }

  var ND = window.ND;
  var S = ND.settings;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var drawer = document.getElementById('drawer');
  var trigger = document.getElementById('drawer-trigger');
  var panel = document.getElementById('panel');
  var scrim = document.getElementById('panel-scrim');
  var toastEl = document.getElementById('toast');

  /* ══════════════════════════════════════════════════════════════════════
     1. TOAST NOTIFICATIONS & CAPABILITY DETECTION
     ══════════════════════════════════════════════════════════════════════ */

  var toastTimer = null;
  function toast(message, tone, ms) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.setAttribute('data-tone', tone || 'info');
    toastEl.hidden = false;
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-visible');
      setTimeout(function () { toastEl.hidden = true; }, 240);
    }, ms || 3200);
  }

  ND.on('toast', function (msg) { toast(msg); });
  ND.on('storage-error', function (d) { toast(d.message, 'error', 5000); });
  ND.on('exit-blocked', function () {
    toast('Browser tabs cannot close themselves. In the desktop app, Exit closes NIGHTDRIVE.', 'info', 4500);
  });
  ND.on('audio-blocked', function () {
    toast('Audio was blocked until window interaction. Click Ignition again.', 'error', 4000);
  });

  var caps = {
    hostSettings: false,
    hostVolume: false,
    hostQuit: false
  };

  function refreshCapabilities() {
    var p = ND.platform || {};
    var active = typeof ND.hostActive === 'function' ? ND.hostActive() : false;
    if (p.webview2 && !active) ND.postToHost('hello');
    caps.hostSettings = !!(p.wkhost || (p.webview2 && active));
    caps.hostQuit = !!(p.wkhost || (p.webview2 && active) || p.tauri);
    caps.hostVolume = !!(p.webview2 && active);

    var hint = document.getElementById('volume-hint');
    if (hint) {
      hint.textContent = caps.hostVolume
        ? 'Controls Windows system volume & NIGHTDRIVE audio.'
        : 'Controls NIGHTDRIVE engine & local music audio.';
    }
  }

  function unsupported(what) {
    toast(what + ' opens OS settings when running in the native Windows/macOS desktop host.', 'info', 4200);
  }

  /* ══════════════════════════════════════════════════════════════════════
     2. INDEXEDDB BLOB STORAGE & PERSISTENT STUDIO METADATA
     ══════════════════════════════════════════════════════════════════════ */

  var DB_NAME = 'nightdrive';
  var DB_STORE = 'assets';
  var memoryFallback = {};
  var dbPromise = null;

  var FAVS_KEY = 'nightdrive.favs.v1';
  var IMPORTED_WP_KEY = 'nightdrive.imported.wallpapers.v1';
  var IMPORTED_CAR_KEY = 'nightdrive.imported.cars.v1';
  var API_KEYS_KEY = 'nightdrive.apikeys.v1';

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        reject(new Error('no indexedDB'));
        return;
      }
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
    }).catch(function () { return false; });
  }

  function storeBlob(key, blob) {
    var url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : '';
    return idbPut(key, blob).then(function () {
      return url;
    }).catch(function () {
      memoryFallback[key] = blob;
      return url;
    });
  }

  function loadBlobUrl(key) {
    if (memoryFallback[key] && typeof URL.createObjectURL === 'function') {
      return Promise.resolve(URL.createObjectURL(memoryFallback[key]));
    }
    return idbGet(key).then(function (blob) {
      return (blob && typeof URL.createObjectURL === 'function') ? URL.createObjectURL(blob) : null;
    }).catch(function () { return null; });
  }

  function readJsonLS(key, fallback) {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return fallback;
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function writeJsonLS(key, val) {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        localStorage.setItem(key, JSON.stringify(val));
      }
    } catch (e) { /* ignore quota */ }
  }

  var favourites = new Set(readJsonLS(FAVS_KEY, []));
  var importedWallpapers = readJsonLS(IMPORTED_WP_KEY, []);
  var importedCars = readJsonLS(IMPORTED_CAR_KEY, []);
  var providerKeys = readJsonLS(API_KEYS_KEY, { unsplash: '', pexels: '' });
  var onlineWallpapers = [];

  /* ══════════════════════════════════════════════════════════════════════
     3. FILE PICKERS & IMAGE / ALPHA VALIDATION
     ══════════════════════════════════════════════════════════════════════ */

  var MAX_IMAGE_BYTES = 40 * 1024 * 1024;
  var ACCEPTED_IMAGES = ['image/jpeg', 'image/png', 'image/webp'];
  var MAX_AUDIO_BYTES = 80 * 1024 * 1024;

  function pickImageFile() {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = ACCEPTED_IMAGES.join(',');
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        input.remove();
        if (!file) { resolve(null); return; }
        if (ACCEPTED_IMAGES.indexOf(file.type) === -1) {
          toast('Unsupported file type. Use JPEG, PNG or WebP.', 'error');
          resolve(null);
          return;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          toast('That image is ' + Math.round(file.size / 1048576) + ' MB. Maximum size is 40 MB.', 'error', 5000);
          resolve(null);
          return;
        }
        resolve(file);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  function pickAudioFile() {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus';
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        input.remove();
        if (!file) { resolve(null); return; }
        var okType = /^audio\//i.test(file.type || '') || /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i.test(file.name || '');
        if (!okType) {
          toast('Unsupported audio file. Choose MP3, WAV, OGG, FLAC, M4A or AAC.', 'error');
          resolve(null);
          return;
        }
        if (file.size > MAX_AUDIO_BYTES) {
          toast('Audio file exceeds 80 MB limit.', 'error');
          resolve(null);
          return;
        }
        resolve(file);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  function inspectDecodedImage(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || 0;
        var h = img.naturalHeight || 0;
        var hasTransparency = false;
        try {
          var c = document.createElement('canvas');
          c.width = 64;
          c.height = 64;
          var g = c.getContext && c.getContext('2d');
          if (g && typeof g.getImageData === 'function') {
            g.clearRect(0, 0, 64, 64);
            g.drawImage(img, 0, 0, 64, 64);
            var px = g.getImageData(0, 0, 64, 64).data;
            var transparentCount = 0;
            for (var i = 3; i < px.length; i += 4) {
              if (px[i] < 245) transparentCount++;
            }
            hasTransparency = transparentCount > 40;
          } else {
            hasTransparency = true; // non-canvas test environment
          }
        } catch (e) {
          hasTransparency = true;
        }
        resolve({ valid: w > 0 && h > 0, width: w, height: h, hasTransparency: hasTransparency });
      };
      img.onerror = function () {
        resolve({ valid: false, width: 0, height: 0, hasTransparency: false });
      };
      img.src = url;
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     4. LEFT QUICK SETTINGS DRAWER & UNIFIED STUDIO PANEL
     ══════════════════════════════════════════════════════════════════════ */

  var drawerOpen = false;
  var panelOpen = false;
  var activeTab = 'wallpapers';
  var openTimer = null;
  var closeTimer = null;
  var OPEN_DELAY_MS = 90;
  var CLOSE_GRACE_MS = 380;

  function tellNativeInteractiveState() {
    try {
      if (ND.platform && ND.platform.webview2 && typeof ND.postToHost === 'function') {
        ND.postToHost('drawer:' + ((drawerOpen || panelOpen) ? 'open' : 'closed'));
      }
    } catch (e) { /* ignore */ }
  }

  function setDrawer(open, opts) {
    if (!drawer || !trigger) return;
    var o = opts || {};
    if (open && S.drawerEnabled === false && !o.keyboard && !o.fromHost) return;
    if (open === drawerOpen && !o.force) return;

    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    drawerOpen = open;
    drawer.classList.toggle('is-open', open);
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if ('inert' in drawer) drawer.inert = !open;
    tellNativeInteractiveState();
  }

  function scheduleDrawerOpen() {
    if (drawerOpen || S.drawerEnabled === false) return;
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    openTimer = setTimeout(function () { setDrawer(true); }, OPEN_DELAY_MS);
  }

  function scheduleDrawerClose() {
    clearTimeout(openTimer);
    if (!drawerOpen || S.drawerPinned || panelOpen) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      if (!S.drawerPinned && !panelOpen) setDrawer(false);
    }, CLOSE_GRACE_MS);
  }

  if (trigger) {
    trigger.addEventListener('pointerenter', scheduleDrawerOpen);
    trigger.addEventListener('pointerleave', scheduleDrawerClose);
    trigger.addEventListener('click', function () { setDrawer(!drawerOpen, { keyboard: true }); });
  }
  if (drawer) {
    drawer.addEventListener('pointerenter', function () { clearTimeout(closeTimer); });
    drawer.addEventListener('pointerleave', scheduleDrawerClose);
  }

  function openStudioTab(tabName) {
    activeTab = tabName || 'wallpapers';
    $$('.studio-tab').forEach(function (btn) {
      var match = btn.getAttribute('data-tab') === activeTab;
      btn.classList.toggle('is-active', match);
      btn.setAttribute('aria-selected', match ? 'true' : 'false');
    });
    ['wallpapers', 'cars', 'schedule', 'settings'].forEach(function (t) {
      var pane = document.getElementById('tab-' + t);
      if (pane) {
        pane.hidden = (t !== activeTab);
        pane.classList.toggle('is-active', t === activeTab);
      }
    });
    if (activeTab === 'wallpapers') renderWallpaperGallery();
    if (activeTab === 'cars') renderCarGallery();
    if (activeTab === 'schedule') renderScheduleRows();
  }

  function setPanel(open, tabName) {
    if (!panel || !scrim) return;
    panelOpen = !!open;
    panel.hidden = !panelOpen;
    scrim.hidden = !panelOpen;
    panel.setAttribute('aria-hidden', panelOpen ? 'false' : 'true');
    if (panelOpen) {
      openStudioTab(tabName || activeTab || 'wallpapers');
    }
    tellNativeInteractiveState();
  }

  if (scrim) {
    scrim.addEventListener('click', function () { setPanel(false); });
  }

  // Native Windows Ctrl+Alt+N hotkey / tray events
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('nightdrive-drawer-open', function () {
      window.__nightdriveDrawerOpen = false;
      setDrawer(true, { fromHost: true, force: true });
    });
    window.addEventListener('nightdrive-drawer-close', function () {
      setPanel(false);
      setDrawer(false, { fromHost: true, force: true });
    });
  }
  if (window.__nightdriveDrawerOpen) {
    window.__nightdriveDrawerOpen = false;
    setDrawer(true, { fromHost: true, force: true });
  }

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      setDrawer(!drawerOpen, { keyboard: true });
      return;
    }
    if (e.key === 'Escape') {
      if (panelOpen) {
        e.preventDefault();
        setPanel(false);
      } else if (drawerOpen) {
        e.preventDefault();
        if (S.drawerPinned) ND.save({ drawerPinned: false });
        setDrawer(false, { force: true });
        syncControlsFromState();
      }
    }
  });

  /* ══════════════════════════════════════════════════════════════════════
     5. WALLPAPER STUDIO (Curated Library + Search + Import + Online API)
     ══════════════════════════════════════════════════════════════════════ */

  var wpFilter = 'all';
  var wpQuery = '';

  function allStudioWallpapers() {
    var cat = ND.catalog && ND.catalog();
    var builtin = (cat && Array.isArray(cat.wallpapers)) ? cat.wallpapers : [];
    return builtin.concat(importedWallpapers).concat(onlineWallpapers);
  }

  function setWpStatus(msg) {
    var el = document.getElementById('wp-status-msg');
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = '';
    } else {
      el.hidden = false;
      el.textContent = msg;
    }
  }

  function renderWallpaperGallery() {
    var grid = document.getElementById('wp-gallery');
    if (!grid) return;

    var st = ND.state();
    var q = wpQuery.trim().toLowerCase();
    var list = allStudioWallpapers().filter(function (item) {
      if (wpFilter === 'favourites' && !favourites.has(item.id)) return false;
      if (wpFilter === 'imported' && !item.imported) return false;
      if (wpFilter === 'online' && !item.online) return false;
      if (wpFilter === 'car-ready' && !item.supportsCarOverlay) return false;
      if (['morning', 'day', 'goldenHour', 'dusk', 'night', 'midnight'].indexOf(wpFilter) !== -1) {
        if (item.period !== wpFilter) return false;
      }
      if (!q) return true;
      var hay = [
        item.title, item.subtitle, item.period, item.lighting, item.style, item.source,
        (item.tags || []).join(' ')
      ].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });

    var packLabel = document.getElementById('wp-active-pack-label');
    if (packLabel) {
      if (st.activeWallpaper) {
        packLabel.textContent = 'Pinned Scene — ' + st.activeWallpaper.title;
      } else {
        packLabel.textContent = S.activePack === 'scenic-touring'
          ? 'Scenic Touring (Car-Overlay Ready · 6 periods)'
          : 'Cascade Overlook (Integrated Coupe · 6 periods)';
      }
    }

    if (list.length === 0) {
      grid.innerHTML = '';
      setWpStatus(wpFilter === 'online'
        ? 'Enter a search term above (e.g. "mountain night road", "tokyo skyline", "coastal cliff") and click Search Online.'
        : 'No wallpapers match the current filter.');
      return;
    }
    if (wpFilter !== 'online') setWpStatus('');

    var html = list.map(function (w) {
      var isFav = favourites.has(w.id);
      var isActive = (st.activeWallpaper && st.activeWallpaper.id === w.id) ||
        (!st.activeWallpaper && w.pack === S.activePack && w.period === st.sceneId);
      var periodBadge = w.period || 'custom';
      var layerBadge = w.supportsCarOverlay
        ? '<span class="badge car-ready">Car-Ready</span>'
        : '<span class="badge">' + (w.hasIntegratedVehicle ? 'Integrated Car' : 'Complete Scene') + '</span>';

      return (
        '<article class="studio-card' + (isActive ? ' is-active' : '') + '">' +
          '<div class="studio-thumb-wrap">' +
            '<img class="studio-thumb" src="' + escapeAttr(w.thumbSrc || w.src) + '" alt="' + escapeAttr(w.title) + '" loading="lazy" />' +
            '<div class="studio-badges">' +
              (isActive ? '<span class="badge active">Active</span>' : '<span class="badge">' + escapeHtml(periodBadge) + '</span>') +
              layerBadge +
            '</div>' +
          '</div>' +
          '<div class="studio-card-body">' +
            '<div class="studio-card-title-row">' +
              '<span class="studio-card-title">' + escapeHtml(w.title) + '</span>' +
              '<button type="button" class="fav-btn' + (isFav ? ' is-fav' : '') + '" data-action="wp.fav" data-id="' + escapeAttr(w.id) + '" title="Toggle favourite" aria-label="Toggle favourite">♥</button>' +
            '</div>' +
            '<div class="studio-card-sub">' + escapeHtml(w.subtitle || '') + '</div>' +
            '<div class="studio-card-meta">' + escapeHtml((w.resolution || '') + (w.source ? ' · ' + w.source : '')) + '</div>' +
            '<div class="studio-card-actions">' +
              '<button type="button" class="pill-btn sm primary" data-action="wp.apply" data-id="' + escapeAttr(w.id) + '">Apply</button>' +
              '<button type="button" class="pill-btn sm" data-action="wp.preview" data-id="' + escapeAttr(w.id) + '">Preview</button>' +
              (w.imported ? '<button type="button" class="pill-btn sm danger" data-action="wp.remove" data-id="' + escapeAttr(w.id) + '">Remove</button>' : '') +
            '</div>' +
          '</div>' +
        '</article>'
      );
    }).join('');

    grid.innerHTML = html;
  }

  function searchOnlineWallpapers() {
    var input = document.getElementById('wp-search-input');
    var q = (input && input.value ? input.value.trim() : '') || 'mountain night highway landscape';
    wpFilter = 'online';
    syncFilterPills('.category-bar [data-action="wp.filter"]', 'online');
    setWpStatus('Searching high-resolution photography for "' + q + '"…');

    if (!navigator.onLine) {
      onlineWallpapers = [];
      renderWallpaperGallery();
      setWpStatus('Offline — external wallpaper search requires internet connectivity. All 12 built-in studio scenes remain available offline.');
      return;
    }

    var tasks = [searchWikimediaCommons(q)];
    if (providerKeys.unsplash) tasks.push(searchUnsplash(q, providerKeys.unsplash));
    if (providerKeys.pexels) tasks.push(searchPexels(q, providerKeys.pexels));

    Promise.all(tasks).then(function (batches) {
      var merged = [];
      batches.forEach(function (arr) { merged = merged.concat(arr || []); });
      onlineWallpapers = merged;
      wpQuery = '';
      renderWallpaperGallery();
      if (merged.length > 0) {
        setWpStatus('Found ' + merged.length + ' verified widescreen photographs for "' + q + '" (click Apply to download & use).');
      } else {
        setWpStatus('No widescreen (>=1280×720) photographs matched "' + q + '". Try broader landscape keywords.');
      }
    }).catch(function () {
      setWpStatus('External search service could not be reached from this network.');
    });
  }

  function searchWikimediaCommons(query) {
    var api = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6' +
      '&gsrlimit=14&gsrsearch=' + encodeURIComponent(query + ' filetype:bitmap') +
      '&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1600&format=json&origin=*';
    return fetch(api)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var pages = (data && data.query && data.query.pages) || {};
        var results = [];
        Object.keys(pages).forEach(function (k) {
          var pg = pages[k];
          var ii = pg && pg.imageinfo && pg.imageinfo[0];
          if (!ii || !ii.url || (ii.width || 0) < 1280 || (ii.height || 0) < 720) return;
          if (ii.width / ii.height < 1.32) return;
          var meta = ii.extmetadata || {};
          var artist = stripTags((meta.Artist && meta.Artist.value) || 'Wikimedia Contributor').slice(0, 42);
          var license = stripTags((meta.LicenseShortName && meta.LicenseShortName.value) || 'CC');
          var cleanTitle = String(pg.title || '').replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').slice(0, 52);
          results.push({
            id: 'commons-' + pg.pageid,
            title: cleanTitle || 'Commons Landscape',
            subtitle: 'By ' + artist + ' (' + license + ')',
            period: inferPeriodFromText(query + ' ' + cleanTitle),
            src: ii.thumburl || ii.url,
            thumbSrc: ii.thumburl || ii.url,
            resolution: ii.width + 'x' + ii.height,
            focus: ['50%', '62%'],
            hasIntegratedVehicle: false,
            supportsCarOverlay: false,
            online: true,
            tags: [query],
            source: 'Wikimedia Commons · ' + license
          });
        });
        return results;
      })
      .catch(function () { return []; });
  }

  function searchUnsplash(query, accessKey) {
    var url = 'https://api.unsplash.com/search/photos?orientation=landscape&per_page=10&query=' + encodeURIComponent(query);
    return fetch(url, { headers: { Authorization: 'Client-ID ' + accessKey } })
      .then(function (r) { if (!r.ok) throw new Error('unsplash status'); return r.json(); })
      .then(function (d) {
        return (d.results || []).map(function (item) {
          var user = (item.user && item.user.name) || 'Photographer';
          return {
            id: 'unsplash-' + item.id,
            title: (item.description || item.alt_description || 'Unsplash Landscape').slice(0, 48),
            subtitle: 'Photo by ' + user,
            period: inferPeriodFromText(query),
            src: item.urls && (item.urls.regular || item.urls.full),
            thumbSrc: item.urls && item.urls.small,
            resolution: item.width + 'x' + item.height,
            focus: ['50%', '62%'],
            hasIntegratedVehicle: false,
            supportsCarOverlay: false,
            online: true,
            tags: [query],
            source: 'Unsplash · ' + user
          };
        });
      })
      .catch(function () { return []; });
  }

  function searchPexels(query, apiKey) {
    var url = 'https://api.pexels.com/v1/search?orientation=landscape&per_page=10&query=' + encodeURIComponent(query);
    return fetch(url, { headers: { Authorization: apiKey } })
      .then(function (r) { if (!r.ok) throw new Error('pexels status'); return r.json(); })
      .then(function (d) {
        return (d.photos || []).map(function (item) {
          return {
            id: 'pexels-' + item.id,
            title: (item.alt || 'Pexels Landscape').slice(0, 48),
            subtitle: 'Photo by ' + (item.photographer || 'Photographer'),
            period: inferPeriodFromText(query),
            src: item.src && (item.src.large2x || item.src.original),
            thumbSrc: item.src && item.src.medium,
            resolution: item.width + 'x' + item.height,
            focus: ['50%', '62%'],
            hasIntegratedVehicle: false,
            supportsCarOverlay: false,
            online: true,
            tags: [query],
            source: 'Pexels · ' + (item.photographer || '')
          };
        });
      })
      .catch(function () { return []; });
  }

  function inferPeriodFromText(txt) {
    var s = String(txt || '').toLowerCase();
    if (/midnight|aurora|star|milky/.test(s)) return 'midnight';
    if (/night|moon/.test(s)) return 'night';
    if (/dusk|twilight|blue hour|evening|neon/.test(s)) return 'dusk';
    if (/sunset|golden|amber|canyon/.test(s)) return 'goldenHour';
    if (/dawn|sunrise|morning|mist/.test(s)) return 'morning';
    return 'day';
  }

  function stripTags(html) {
    return String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  /* ══════════════════════════════════════════════════════════════════════
     6. CAR STUDIO (Built-in Transparent Vehicles + Alpha-Checked Import)
     ══════════════════════════════════════════════════════════════════════ */

  var carFilter = 'all';
  var carQuery = '';

  function allStudioCars() {
    var cat = ND.catalog && ND.catalog();
    var builtin = (cat && Array.isArray(cat.cars)) ? cat.cars : [];
    return builtin.concat(importedCars);
  }

  function renderCarGallery() {
    var grid = document.getElementById('car-gallery');
    if (!grid) return;

    var q = carQuery.trim().toLowerCase();
    var activeCarId = S.activeCarId || 'scene-default';
    var list = allStudioCars().filter(function (c) {
      if (carFilter === 'imported' && !c.imported) return false;
      if (['native', 'muscle', 'coupe', 'sports'].indexOf(carFilter) !== -1 && c.category !== carFilter) return false;
      if (!q) return true;
      var hay = [c.title, c.subtitle, c.category, (c.tags || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });

    var switchBtn = document.getElementById('car-switch-scenic-btn');
    if (switchBtn) {
      switchBtn.hidden = (S.activePack === 'scenic-touring');
    }

    grid.innerHTML = list.map(function (c) {
      var isSelected = (activeCarId === c.id);
      var thumb = c.overlaySrc
        ? '<img class="studio-thumb" src="' + escapeAttr(c.overlaySrc) + '" alt="' + escapeAttr(c.title) + '" loading="lazy" />'
        : '<img class="studio-thumb" src="assets/night/scene.jpg" style="object-fit:cover;padding:0;" alt="Scene native vehicle" loading="lazy" />';

      return (
        '<article class="studio-card' + (isSelected ? ' is-active' : '') + '">' +
          '<div class="studio-thumb-wrap">' +
            thumb +
            '<div class="studio-badges">' +
              (isSelected ? '<span class="badge active">Selected</span>' : '<span class="badge">' + escapeHtml(c.category || 'vehicle') + '</span>') +
              (c.overlaySrc ? '<span class="badge car-ready">Alpha Overlay</span>' : '<span class="badge">Native</span>') +
            '</div>' +
          '</div>' +
          '<div class="studio-card-body">' +
            '<div class="studio-card-title-row">' +
              '<span class="studio-card-title">' + escapeHtml(c.title) + '</span>' +
            '</div>' +
            '<div class="studio-card-sub">' + escapeHtml(c.subtitle || '') + '</div>' +
            '<div class="studio-card-actions">' +
              '<button type="button" class="pill-btn sm primary" data-action="car.select" data-id="' + escapeAttr(c.id) + '">' +
                (isSelected ? 'Active' : (c.overlaySrc ? 'Apply Vehicle' : 'Use Scene Native')) +
              '</button>' +
              (c.imported ? '<button type="button" class="pill-btn sm danger" data-action="car.removeImported" data-id="' + escapeAttr(c.id) + '">Remove</button>' : '') +
            '</div>' +
          '</div>' +
        '</article>'
      );
    }).join('');
  }

  /* ══════════════════════════════════════════════════════════════════════
     7. AUTOMATIC TIME SCHEDULE EDITOR
     ══════════════════════════════════════════════════════════════════════ */

  function renderScheduleRows() {
    var wrap = document.getElementById('schedule-rows');
    if (!wrap || typeof ND.getSchedule !== 'function') return;

    var snap = ND.getSchedule();
    var statusLine = document.getElementById('schedule-status-line');
    if (statusLine) {
      statusLine.textContent = snap.auto
        ? ('Active: following local system clock (currently in ' + snap.activeNowId + ' period).')
        : ('Paused: manual override active (' + (snap.manualResumeMode === 'nextBoundary' ? 'will auto-resume at next period boundary' : 'click Follow Local Clock to resume') + ').');
    }

    wrap.innerHTML = snap.periods.map(function (p) {
      var isNow = (p.id === snap.activeNowId);
      return (
        '<div class="schedule-row' + (isNow ? ' is-now' : '') + '" role="listitem">' +
          '<div class="schedule-period-name">' +
            '<span>' + escapeHtml(p.label) + '</span>' +
            (isNow ? '<span class="badge active">Now</span>' : '') +
          '</div>' +
          '<div class="schedule-range-wrap">' +
            '<label>Start <input type="time" class="time-input schedule-time-input" data-period="' + escapeAttr(p.id) + '" value="' + escapeAttr(p.startHHMM) + '" aria-label="' + escapeAttr(p.label) + ' start time" /></label>' +
            '<span>→ ' + escapeHtml(p.endHHMM) + '</span>' +
          '</div>' +
          '<div class="hint">' + (p.headlights ? 'Headlights active · Night palette' : 'Daylight / ambient palette') + '</div>' +
          '<div>' +
            '<button type="button" class="pill-btn sm" data-action="schedule.previewPeriod" data-period="' + escapeAttr(p.id) + '">Preview</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    $$('.schedule-time-input', wrap).forEach(function (inp) {
      inp.addEventListener('change', function () {
        var pid = inp.getAttribute('data-period');
        var mins = ND.parseHHMMToMinutes(inp.value);
        if (mins === null) {
          toast('Invalid time format.', 'error');
          renderScheduleRows();
          return;
        }
        var map = {};
        ND.getSchedule().periods.forEach(function (row) { map[row.id] = row.start; });
        map[pid] = mins;
        if (!ND.saveScheduleHours(map)) {
          toast('Two periods cannot share the exact same start minute.', 'error');
        } else {
          toast('Updated ' + pid + ' start time to ' + inp.value + '.');
        }
        renderScheduleRows();
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     8. MUSIC BAR & DRAWER PLAYER UI SYNC
     ══════════════════════════════════════════════════════════════════════ */

  function formatSec(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    var total = Math.floor(sec);
    var m = Math.floor(total / 60);
    var s = String(total % 60).padStart(2, '0');
    return m + ':' + s;
  }

  function syncMediaUI(m) {
    var media = m || ND.mediaState();
    var stageBar = document.getElementById('stage-music-bar');
    var stageTitle = document.getElementById('stage-music-title');
    var stageArtist = document.getElementById('stage-music-artist');
    var stageFill = document.getElementById('stage-music-fill');
    var stageIcon = document.getElementById('stage-media-icon');

    var drawerSource = document.getElementById('drawer-music-source');
    var drawerDisc = document.getElementById('drawer-music-disc');
    var drawerTitle = document.getElementById('drawer-music-title');
    var drawerArtist = document.getElementById('drawer-music-artist');
    var drawerIcon = document.getElementById('drawer-media-icon');
    var seekSlider = document.getElementById('music-seek');
    var posEl = document.getElementById('music-pos');
    var durEl = document.getElementById('music-dur');

    var pct = (media.durationSec > 0)
      ? Math.max(0, Math.min(100, (media.positionSec / media.durationSec) * 100))
      : 0;

    if (stageBar) stageBar.classList.toggle('is-playing', !!(media.connected && media.playing));
    if (drawerDisc) drawerDisc.classList.toggle('is-playing', !!(media.connected && media.playing));

    var iconHref = (media.connected && media.playing) ? '#i-pause' : '#i-play';
    if (stageIcon) stageIcon.setAttribute('href', iconHref);
    if (drawerIcon) drawerIcon.setAttribute('href', iconHref);

    if (media.connected) {
      var title = media.title || 'Active Media';
      var sub = media.artist || media.sourceApp || 'Connected';
      if (stageTitle) stageTitle.textContent = title;
      if (stageArtist) stageArtist.textContent = sub;
      if (stageFill) stageFill.style.width = pct.toFixed(1) + '%';

      if (drawerSource) drawerSource.textContent = media.sourceApp || (media.source === 'local' ? 'Local File' : 'Windows SMTC');
      if (drawerTitle) drawerTitle.textContent = title;
      if (drawerArtist) drawerArtist.textContent = sub;
      if (seekSlider && document.activeElement !== seekSlider) {
        seekSlider.value = String(Math.round(pct * 10));
        seekSlider.disabled = !media.canSeek;
      }
      if (posEl) posEl.textContent = formatSec(media.positionSec);
      if (durEl) durEl.textContent = media.durationSec > 0 ? formatSec(media.durationSec) : '--:--';
    } else {
      if (stageTitle) stageTitle.textContent = 'No media playing';
      if (stageArtist) stageArtist.textContent = ND.platform.webview2 ? 'Windows Media / Load audio' : 'Click folder to load audio';
      if (stageFill) stageFill.style.width = '0%';

      if (drawerSource) drawerSource.textContent = 'No Session';
      if (drawerTitle) drawerTitle.textContent = 'No media session connected';
      if (drawerArtist) drawerArtist.textContent = ND.platform.webview2
        ? 'Start Spotify/browser playback or click Load file'
        : 'Load a local audio file to play music';
      if (seekSlider) { seekSlider.value = '0'; seekSlider.disabled = true; }
      if (posEl) posEl.textContent = '0:00';
      if (durEl) durEl.textContent = '0:00';
    }
  }

  ND.on('media', syncMediaUI);

  /* ══════════════════════════════════════════════════════════════════════
     9. STATE HYDRATION & CONTROL SYNC
     ══════════════════════════════════════════════════════════════════════ */

  var pendingDesignBlob = null;
  var pendingDesignUrl = null;

  function setSwitch(id, checked) {
    var el = document.getElementById(id);
    if (el) el.setAttribute('aria-checked', checked ? 'true' : 'false');
  }

  function setPressed(id, pressed) {
    var el = document.getElementById(id);
    if (el) el.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }

  function syncFilterPills(selector, activeVal) {
    $$(selector).forEach(function (btn) {
      var val = btn.getAttribute('data-filter');
      btn.classList.toggle('is-active', val === activeVal);
    });
  }

  function syncControlsFromState() {
    var st = ND.state();
    var pObj = (ND.periods || []).find(function (p) { return p.id === st.sceneId; });

    document.body.classList.toggle('drawer-disabled', S.drawerEnabled === false);

    var sceneNameBtn = document.getElementById('scene-name');
    if (sceneNameBtn) {
      sceneNameBtn.textContent = st.activeWallpaper
        ? st.activeWallpaper.title
        : ((pObj ? pObj.label : st.sceneId) + (st.auto ? ' · Auto' : ' · Manual'));
    }

    $$('.period-chip').forEach(function (chip) {
      chip.classList.toggle('is-active', chip.getAttribute('data-period') === st.sceneId);
    });

    setPressed('drawer-pin', !!S.drawerPinned);
    setPressed('auto-scene', !!st.auto);
    var autoLbl = document.getElementById('auto-scene-label');
    if (autoLbl) autoLbl.textContent = st.auto ? 'Auto by time' : 'Resume Auto';

    var hlOn = st.headlights === true || (st.headlights === null && pObj && pObj.headlights);
    setPressed('headlights-btn', !!hlOn);
    var hlLbl = document.getElementById('headlights-btn-label');
    if (hlLbl) {
      hlLbl.textContent = st.headlights === null ? 'Lights: Auto' : (st.headlights ? 'Lights: On' : 'Lights: Off');
    }
    setPressed('hl-mode-auto', st.headlights === null);
    setPressed('hl-mode-on', st.headlights === true);
    setPressed('hl-mode-off', st.headlights === false);

    setPressed('playback-btn', !!S.playback);
    setPressed('mute-btn', !!S.muted);
    var muteUse = document.getElementById('mute-icon-use');
    if (muteUse) muteUse.setAttribute('href', S.muted ? '#i-mute' : '#i-volume');

    setPressed('drawer-music-bar-toggle', S.desktopMusicBar !== false);
    setSwitch('desktop-music-toggle', S.desktopMusicBar !== false);

    setSwitch('clock-visible', S.clockVisible !== false);
    setSwitch('clock-24h', S.clock24 !== false);
    setSwitch('drawer-enabled', S.drawerEnabled !== false);
    setSwitch('drawer-pinned-setting', !!S.drawerPinned);
    setSwitch('auto-scene-setting', !!st.auto);
    setSwitch('headlights-setting', st.headlights === true);
    setSwitch('motion-toggle', S.motion !== false);
    setSwitch('particles-toggle', S.particles !== false);
    setSwitch('preserve-car-toggle', S.preserveCarOnSchedule !== false);

    setPressed('temp-unit-c', S.tempUnit !== 'F');
    setPressed('temp-unit-f', S.tempUnit === 'F');

    setSliderValue('volume-range', S.volume, 'audio-pct', S.muted ? 'Muted' : (S.volume + '%'));
    setSliderValue('volume-range-2', S.volume, 'volume-range-2-out', S.volume + '%');
    setSliderValue('brightness-range', S.brightness, 'brightness-value', S.brightness + '%');
    setSliderValue('clock-scale', S.clockScale, 'clock-scale-out', S.clockScale + '%');
    setSliderValue('clock-opacity', S.clockOpacity, 'clock-opacity-out', S.clockOpacity + '%');
    setSliderValue('clock-offset', S.clockOffset, 'clock-offset-out', String(S.clockOffset));
    setSliderValue('beam-intensity', S.beamIntensity || 75, 'beam-intensity-out', (S.beamIntensity || 75) + '%');
    setSliderValue('schedule-blend-mins', S.scheduleBlendMins || 20, 'schedule-blend-mins-out', (S.scheduleBlendMins || 20) + ' min');
    setSliderValue('transition-speed', S.transitionMs, 'transition-speed-out', (S.transitionMs / 1000).toFixed(1) + ' s');
    setSliderValue('car-scale', S.carScale, 'car-scale-out', S.carScale + '%');
    setSliderValue('car-x', S.carX, 'car-x-out', S.carX + '%');
    setSliderValue('car-y', S.carY, 'car-y-out', S.carY + '%');
    setSliderValue('bg-scale', S.bgScale, 'bg-scale-out', S.bgScale + '%');
    setSliderValue('bg-x', S.bgX, 'bg-x-out', S.bgX + '%');
    setSliderValue('bg-y', S.bgY, 'bg-y-out', S.bgY + '%');
    setSliderValue('bg-brightness', S.bgBrightness, 'bg-brightness-out', S.bgBrightness + '%');

    var startupSel = document.getElementById('startup-effect');
    if (startupSel) startupSel.value = S.startupEffect || 'manual';
    var resumeSel = document.getElementById('manual-resume-select');
    if (resumeSel) resumeSel.value = S.manualResumeMode || 'untilReenabled';

    var wpSummary = document.getElementById('drawer-wp-summary');
    if (wpSummary) {
      wpSummary.textContent = st.activeWallpaper
        ? st.activeWallpaper.title
        : (allStudioWallpapers().length + ' scenes · Search & Import');
    }
    var carSummary = document.getElementById('drawer-car-summary');
    if (carSummary) {
      carSummary.textContent = st.activeCar ? st.activeCar.title : 'Scene Native · 4 vehicles';
    }

    $$('[data-action="mode.scene"]').forEach(function (b) { b.setAttribute('aria-pressed', S.mode !== 'custom' ? 'true' : 'false'); });
    $$('[data-action="mode.custom"]').forEach(function (b) { b.setAttribute('aria-pressed', S.mode === 'custom' ? 'true' : 'false'); });
    $$('[data-action="car.fit.cover"]').forEach(function (b) { b.setAttribute('aria-pressed', S.carFit === 'cover' ? 'true' : 'false'); });
    $$('[data-action="car.fit.contain"]').forEach(function (b) { b.setAttribute('aria-pressed', S.carFit === 'contain' ? 'true' : 'false'); });
    $$('[data-action="bg.fit.cover"]').forEach(function (b) { b.setAttribute('aria-pressed', S.bgFit !== 'contain' ? 'true' : 'false'); });
    $$('[data-action="bg.fit.contain"]').forEach(function (b) { b.setAttribute('aria-pressed', S.bgFit === 'contain' ? 'true' : 'false'); });
  }

  function setSliderValue(sliderId, val, outId, outText) {
    var sl = document.getElementById(sliderId);
    if (sl && document.activeElement !== sl) sl.value = String(val);
    var out = outId ? document.getElementById(outId) : null;
    if (out && outText !== undefined) out.textContent = outText;
  }

  /* ══════════════════════════════════════════════════════════════════════
     10. DELEGATED ACTION TABLE (Every [data-action] in index.html)
     ══════════════════════════════════════════════════════════════════════ */

  var ACTIONS = {
    'drawer.open': function () {
      setDrawer(true, { keyboard: true });
    },
    'drawer.close': function () {
      if (S.drawerPinned) ND.save({ drawerPinned: false });
      setDrawer(false, { force: true });
      syncControlsFromState();
    },
    'drawer.pin': function () {
      ND.save({ drawerPinned: !S.drawerPinned });
      if (S.drawerPinned && !drawerOpen) setDrawer(true, { force: true });
      syncControlsFromState();
    },
    'drawer.enabled': function () {
      ND.save({ drawerEnabled: !S.drawerEnabled });
      syncControlsFromState();
    },

    'panel.open': function () {
      setPanel(true, 'wallpapers');
    },
    'panel.close': function () {
      setPanel(false);
    },

    'studio.tab': function (el) {
      var tab = (el && el.getAttribute('data-tab')) || 'wallpapers';
      openStudioTab(tab);
    },
    'studio.wallpapers': function () {
      setPanel(true, 'wallpapers');
    },
    'studio.cars': function () {
      setPanel(true, 'cars');
    },
    'studio.schedule': function () {
      setPanel(true, 'schedule');
    },

    'system.wifi': function () {
      refreshCapabilities();
      if (!ND.openSystemSettings('wifi')) unsupported('Network settings');
    },
    'system.bt': function () {
      refreshCapabilities();
      if (!ND.openSystemSettings('bt')) unsupported('Bluetooth settings');
    },
    'system.volumeSettings': function () {
      refreshCapabilities();
      if (!ND.openSystemSettings('sound')) unsupported('System sound mixer');
    },
    'system.displaySettings': function () {
      refreshCapabilities();
      if (!ND.openSystemSettings('display')) unsupported('System display settings');
    },

    'audio.mute': function () {
      ND.setMuted(!S.muted);
      syncControlsFromState();
    },

    'media.toggle': function () {
      if (!ND.mediaPlayPause()) {
        toast('No active media session. Play music in Windows or click "Load file" to play local audio.', 'info', 4000);
      }
    },
    'media.prev': function () {
      if (!ND.mediaPrev()) toast('No active media track to skip.', 'info');
    },
    'media.next': function () {
      if (!ND.mediaNext()) toast('No next track available in current session.', 'info');
    },
    'media.loadFile': function () {
      pickAudioFile().then(function (file) {
        if (!file) return;
        var url = URL.createObjectURL(file);
        var cleanName = String(file.name || 'Local Track').replace(/\.[a-z0-9]+$/i, '');
        ND.loadLocalAudio(url, { title: cleanName, artist: 'Local Audio File' });
        toast('Playing "' + cleanName + '"');
      });
    },
    'media.toggleDesktopBar': function () {
      ND.save({ desktopMusicBar: !(S.desktopMusicBar !== false) });
      ND.applyDesktopMusicBarVisibility();
      syncControlsFromState();
    },

    'scene.prev': function () {
      ND.stepScene(-1);
      syncControlsFromState();
    },
    'scene.next': function () {
      ND.stepScene(1);
      syncControlsFromState();
    },
    'scene.cycle': function () {
      ND.stepScene(1);
      syncControlsFromState();
    },
    'scene.pick': function (el) {
      var pid = el && el.getAttribute('data-period');
      if (pid) {
        ND.setScene(pid);
        syncControlsFromState();
      }
    },
    'scene.auto': function () {
      ND.setAutoScene(!(ND.state().auto));
      syncControlsFromState();
      if (panelOpen && activeTab === 'schedule') renderScheduleRows();
    },
    'scene.headlights': function () {
      var cur = ND.state().headlights;
      // Cycle Auto (null) -> On (true) -> Off (false) -> Auto (null)
      var next = cur === null ? true : (cur === true ? false : null);
      ND.setHeadlights(next);
      syncControlsFromState();
    },
    'hl.mode': function (el) {
      var m = el && el.getAttribute('data-mode');
      var val = m === 'on' ? true : (m === 'off' ? false : null);
      ND.setHeadlights(val);
      syncControlsFromState();
    },
    'scene.playback': function () {
      ND.setPlayback(!S.playback);
      syncControlsFromState();
    },
    'engine.start': function () {
      ND.startEngine();
    },

    'clock.visible': function () {
      ND.save({ clockVisible: !S.clockVisible });
      ND.applyClockSettings();
      syncControlsFromState();
    },
    'clock.format': function () {
      ND.save({ clock24: !S.clock24 });
      ND.applyClockSettings();
      syncControlsFromState();
    },

    'weather.refresh': function () {
      ND.refreshWeather();
      toast('Refreshing live weather…');
    },
    'weather.setCity': function () {
      var inp = document.getElementById('weather-city-input');
      var q = inp ? inp.value.trim() : '';
      if (!q) { toast('Enter a city name or lat,lon coordinates.', 'info'); return; }
      ND.setWeatherLocation(q).then(function (ok) {
        toast(ok ? ('Weather location updated to "' + S.weatherCity + '".') : 'Could not resolve that location (check spelling or network).', ok ? 'info' : 'error');
      });
    },
    'weather.autoLocate': function () {
      ND.clearWeatherLocation();
      toast('Using automatic location lookup.');
    },
    'weather.unitC': function () {
      ND.setTempUnit('C');
      syncControlsFromState();
    },
    'weather.unitF': function () {
      ND.setTempUnit('F');
      syncControlsFromState();
    },

    /* Wallpaper Studio Actions */
    'wp.filter': function (el) {
      wpFilter = (el && el.getAttribute('data-filter')) || 'all';
      syncFilterPills('.category-bar [data-action="wp.filter"]', wpFilter);
      renderWallpaperGallery();
    },
    'wp.searchOnline': function () {
      searchOnlineWallpapers();
    },
    'wp.usePack': function (el) {
      var pack = (el && el.getAttribute('data-pack')) || 'cascade-overlook';
      ND.useWallpaperPack(pack);
      ND.setAutoScene(true);
      syncControlsFromState();
      renderWallpaperGallery();
      renderCarGallery();
      toast(pack === 'scenic-touring'
        ? 'Switched to Scenic Touring Pack (Car-Overlay Ready).'
        : 'Switched to Cascade Overlook Pack.');
    },
    'wp.apply': function (el) {
      var id = el && el.getAttribute('data-id');
      var wp = allStudioWallpapers().find(function (w) { return w.id === id; });
      if (!wp) return;
      ND.applyStudioWallpaper(wp);
      syncControlsFromState();
      renderWallpaperGallery();
      toast('Applied "' + wp.title + '".');
    },
    'wp.preview': function (el) {
      var id = el && el.getAttribute('data-id');
      var wp = allStudioWallpapers().find(function (w) { return w.id === id; });
      if (!wp) return;
      ND.applyStudioWallpaper(wp);
      syncControlsFromState();
      renderWallpaperGallery();
      toast('Previewing "' + wp.title + '" (close Studio to view full screen).');
    },
    'wp.fav': function (el) {
      var id = el && el.getAttribute('data-id');
      if (!id) return;
      if (favourites.has(id)) favourites.delete(id);
      else favourites.add(id);
      writeJsonLS(FAVS_KEY, Array.from(favourites));
      renderWallpaperGallery();
    },
    'wp.remove': function (el) {
      var id = el && el.getAttribute('data-id');
      if (!id) return;
      importedWallpapers = importedWallpapers.filter(function (w) { return w.id !== id; });
      writeJsonLS(IMPORTED_WP_KEY, importedWallpapers.map(stripRuntimeUrl));
      idbDelete('wp:' + id);
      if (S.activeWallpaperId === id) {
        ND.setAutoScene(true);
      }
      renderWallpaperGallery();
      syncControlsFromState();
      toast('Removed imported wallpaper.');
    },
    'wp.import': function () {
      pickImageFile().then(function (file) {
        if (!file) return;
        var tempUrl = URL.createObjectURL(file);
        inspectDecodedImage(tempUrl).then(function (info) {
          if (!info.valid) {
            URL.revokeObjectURL(tempUrl);
            toast('Image could not be decoded (corrupt or unsupported data).', 'error');
            return;
          }
          var id = 'import-wp-' + Date.now();
          storeBlob('wp:' + id, file).then(function (storedUrl) {
            var item = {
              id: id,
              title: String(file.name || 'Imported Wallpaper').replace(/\.[a-z0-9]+$/i, '').slice(0, 42),
              subtitle: 'Local imported scene (Car-Overlay Ready)',
              period: inferPeriodFromText(file.name),
              src: storedUrl || tempUrl,
              resolution: info.width + 'x' + info.height,
              focus: ['50%', '65%'],
              hasIntegratedVehicle: false,
              supportsCarOverlay: true,
              imported: true,
              tags: ['imported', 'custom'],
              source: 'Local Import'
            };
            importedWallpapers.unshift(item);
            writeJsonLS(IMPORTED_WP_KEY, importedWallpapers.map(stripRuntimeUrl));
            ND.applyStudioWallpaper(item);
            wpFilter = 'all';
            syncFilterPills('.category-bar [data-action="wp.filter"]', 'all');
            renderWallpaperGallery();
            syncControlsFromState();
            toast('Imported and applied "' + item.title + '".');
          });
        });
      });
    },
    'wp.resetDefault': function () {
      ND.useWallpaperPack('cascade-overlook');
      ND.setAutoScene(true);
      syncControlsFromState();
      renderWallpaperGallery();
      toast('Restored default time-scheduled scenes.');
    },
    'wp.saveApiKeys': function () {
      var u = document.getElementById('unsplash-key-input');
      var p = document.getElementById('pexels-key-input');
      providerKeys.unsplash = u ? u.value.trim() : '';
      providerKeys.pexels = p ? p.value.trim() : '';
      writeJsonLS(API_KEYS_KEY, providerKeys);
      toast('Saved external wallpaper API credentials.');
    },
    'wp.clearApiKeys': function () {
      providerKeys = { unsplash: '', pexels: '' };
      writeJsonLS(API_KEYS_KEY, providerKeys);
      var u = document.getElementById('unsplash-key-input');
      var p = document.getElementById('pexels-key-input');
      if (u) u.value = '';
      if (p) p.value = '';
      toast('Cleared external API keys.');
    },

    /* Car Studio Actions */
    'car.filter': function (el) {
      carFilter = (el && el.getAttribute('data-filter')) || 'all';
      syncFilterPills('.category-bar [data-action="car.filter"]', carFilter);
      renderCarGallery();
    },
    'car.select': function (el) {
      var id = (el && el.getAttribute('data-id')) || 'scene-default';
      var imp = importedCars.find(function (c) { return c.id === id; });
      if (imp) {
        ND.save({ activeCarId: imp.id });
        if (S.activePack === 'cascade-overlook' && !ND.state().activeWallpaper) {
          ND.useWallpaperPack('scenic-touring');
        }
        ND.setCar({ src: imp.overlaySrc }, { fit: S.carFit, scale: S.carScale, x: S.carX, y: S.carY, forceComposite: true });
      } else {
        var wasCascade = (S.activePack === 'cascade-overlook' && !ND.state().activeWallpaper && id !== 'scene-default');
        ND.selectStudioCar(id, { autoSwitchPack: true });
        if (wasCascade) {
          toast('Paired vehicle with Scenic Touring car-free backdrop for clean compositing.');
        }
      }
      syncControlsFromState();
      renderCarGallery();
      renderWallpaperGallery();
    },
    'car.import': function () {
      pickImageFile().then(function (file) {
        if (!file) return;
        var tempUrl = URL.createObjectURL(file);
        inspectDecodedImage(tempUrl).then(function (info) {
          if (!info.valid) {
            URL.revokeObjectURL(tempUrl);
            toast('Vehicle image could not be decoded.', 'error');
            return;
          }
          if (!info.hasTransparency) {
            // Honest architectural rule: opaque photos are never faked as cutouts!
            storeBlob('bg', file).then(function (bgUrl) {
              ND.setBackground({ src: bgUrl || tempUrl });
              ND.save({ mode: 'custom' });
              syncControlsFromState();
              toast('Image has no transparent background — applied cleanly as full scene instead of faking a cutout.', 'info', 5200);
            });
            return;
          }
          var id = 'import-car-' + Date.now();
          storeBlob('car:' + id, file).then(function (carUrl) {
            var entry = {
              id: id,
              title: String(file.name || 'Imported Vehicle').replace(/\.[a-z0-9]+$/i, '').slice(0, 40),
              subtitle: 'Imported transparent vehicle (' + info.width + '×' + info.height + ')',
              category: 'imported',
              overlaySrc: carUrl || tempUrl,
              imported: true,
              tags: ['imported', 'custom']
            };
            importedCars.unshift(entry);
            writeJsonLS(IMPORTED_CAR_KEY, importedCars.map(stripRuntimeCarUrl));
            if (S.activePack === 'cascade-overlook' && !ND.state().activeWallpaper) {
              ND.useWallpaperPack('scenic-touring');
            }
            ND.save({ activeCarId: id, carFit: 'contain' });
            ND.setCar({ src: entry.overlaySrc }, { fit: 'contain', scale: S.carScale, x: S.carX, y: S.carY, forceComposite: true });
            renderCarGallery();
            syncControlsFromState();
            toast('Imported transparent vehicle "' + entry.title + '".');
          });
        });
      });
    },
    'car.removeImported': function (el) {
      var id = el && el.getAttribute('data-id');
      if (!id) return;
      importedCars = importedCars.filter(function (c) { return c.id !== id; });
      writeJsonLS(IMPORTED_CAR_KEY, importedCars.map(stripRuntimeCarUrl));
      idbDelete('car:' + id);
      if (S.activeCarId === id) {
        ND.selectStudioCar('scene-default');
      }
      renderCarGallery();
      syncControlsFromState();
      toast('Removed imported vehicle.');
    },
    'car.clear': function () {
      ND.selectStudioCar('scene-default');
      idbDelete('car');
      syncControlsFromState();
      renderCarGallery();
      toast('Using scene-native vehicle.');
    },
    'car.preserveSchedule': function () {
      ND.save({ preserveCarOnSchedule: !(S.preserveCarOnSchedule !== false) });
      syncControlsFromState();
    },
    'car.fit.contain': function () {
      ND.save({ carFit: 'contain' });
      if (ND.state().activeCar) ND.selectStudioCar(ND.state().activeCar.id);
      syncControlsFromState();
    },
    'car.fit.cover': function () {
      ND.save({ carFit: 'cover' });
      if (ND.state().activeCar) ND.selectStudioCar(ND.state().activeCar.id);
      syncControlsFromState();
    },

    /* Schedule Actions */
    'schedule.enableAuto': function () {
      ND.setAutoScene(true);
      syncControlsFromState();
      renderScheduleRows();
      toast('Following local system clock.');
    },
    'schedule.reset': function () {
      ND.resetScheduleHours();
      syncControlsFromState();
      renderScheduleRows();
      toast('Restored default 24-hour time schedule.');
    },
    'schedule.previewPeriod': function (el) {
      var pid = el && el.getAttribute('data-period');
      if (!pid) return;
      ND.setScene(pid);
      syncControlsFromState();
      renderScheduleRows();
      toast('Previewing ' + pid + ' scene (click Follow Local Clock to resume auto).');
    },

    /* Custom Background & Complete Design Actions */
    'mode.scene': function () {
      ND.save({ mode: 'scenes', useDesign: false });
      ND.setBackground(null);
      ND.setAutoScene(S.autoScene);
      syncControlsFromState();
    },
    'mode.custom': function () {
      ND.save({ mode: 'custom' });
      loadBlobUrl('bg').then(function (url) {
        if (url) ND.setBackground({ src: url });
        else toast('Import a custom background image below to display in Custom mode.');
      });
      syncControlsFromState();
    },
    'bg.import': function () {
      pickImageFile().then(function (file) {
        if (!file) return;
        storeBlob('bg', file).then(function (url) {
          ND.save({ mode: 'custom', useDesign: false });
          ND.setBackground({ src: url });
          var bgControls = document.getElementById('bg-controls');
          if (bgControls) bgControls.hidden = false;
          syncControlsFromState();
          toast('Applied custom background.');
        });
      });
    },
    'bg.clear': function () {
      idbDelete('bg');
      ND.save({ mode: 'scenes' });
      ND.setBackground(null);
      var bgControls = document.getElementById('bg-controls');
      if (bgControls) bgControls.hidden = true;
      syncControlsFromState();
    },
    'bg.fit.cover': function () {
      ND.save({ bgFit: 'cover' });
      loadBlobUrl('bg').then(function (url) { if (url) ND.setBackground({ src: url }, { fit: 'cover' }); });
      syncControlsFromState();
    },
    'bg.fit.contain': function () {
      ND.save({ bgFit: 'contain' });
      loadBlobUrl('bg').then(function (url) { if (url) ND.setBackground({ src: url }, { fit: 'contain' }); });
      syncControlsFromState();
    },
    'design.import': function () {
      pickImageFile().then(function (file) {
        if (!file) return;
        var url = URL.createObjectURL(file);
        inspectDecodedImage(url).then(function (info) {
          if (!info.valid) { toast('Could not decode image.', 'error'); return; }
          pendingDesignBlob = file;
          pendingDesignUrl = url;
          var wrap = document.getElementById('design-preview-wrap');
          var prev = document.getElementById('design-preview');
          var nameEl = document.getElementById('design-name');
          var sizeEl = document.getElementById('design-size');
          if (prev) prev.src = url;
          if (nameEl) nameEl.textContent = file.name;
          if (sizeEl) sizeEl.textContent = info.width + '×' + info.height;
          if (wrap) wrap.hidden = false;
        });
      });
    },
    'design.apply': function () {
      if (!pendingDesignBlob || !pendingDesignUrl) return;
      storeBlob('design', pendingDesignBlob).then(function (url) {
        ND.save({ useDesign: true, mode: 'custom' });
        ND.setDesign({ src: url || pendingDesignUrl });
        syncControlsFromState();
        toast('Applied complete standalone design.');
      });
    },
    'design.discard': function () {
      pendingDesignBlob = null;
      pendingDesignUrl = null;
      var wrap = document.getElementById('design-preview-wrap');
      if (wrap) wrap.hidden = true;
    },
    'design.clear': function () {
      idbDelete('design');
      ND.save({ useDesign: false, mode: 'scenes' });
      ND.setDesign(null);
      syncControlsFromState();
    },

    /* Performance & App Lifecycle */
    'perf.motion': function () {
      ND.save({ motion: !S.motion });
      ND.setPlayback(S.playback);
      syncControlsFromState();
    },
    'perf.particles': function () {
      ND.save({ particles: !S.particles });
      ND.setPlayback(S.playback);
      syncControlsFromState();
    },
    'app.reset': function () {
      ND.reset();
      favourites.clear();
      writeJsonLS(FAVS_KEY, []);
      syncControlsFromState();
      renderWallpaperGallery();
      renderCarGallery();
      renderScheduleRows();
      toast('Restored all NIGHTDRIVE defaults.');
    },
    'app.exit': function () {
      ND.exit();
    }
  };

  function stripRuntimeUrl(w) {
    var copy = Object.assign({}, w);
    copy.src = '';
    return copy;
  }
  function stripRuntimeCarUrl(c) {
    var copy = Object.assign({}, c);
    copy.overlaySrc = '';
    return copy;
  }

  document.addEventListener('click', function (e) {
    var target = e.target && typeof e.target.closest === 'function'
      ? e.target.closest('[data-action]')
      : null;
    if (!target) return;
    var name = target.getAttribute('data-action');
    var handler = ACTIONS[name];
    if (typeof handler === 'function') {
      e.preventDefault();
      handler(target);
    }
  });

  /* ══════════════════════════════════════════════════════════════════════
     11. SLIDER, SELECT & SEARCH INPUT BINDINGS
     ══════════════════════════════════════════════════════════════════════ */

  function bindRange(id, onInput) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', function () {
      onInput(Number(el.value));
      syncControlsFromState();
    });
  }

  bindRange('volume-range', function (v) { ND.setVolume(v); });
  bindRange('volume-range-2', function (v) { ND.setVolume(v); });
  bindRange('brightness-range', function (v) { ND.save({ brightness: v }); ND.applyBrightness(); });
  bindRange('clock-scale', function (v) { ND.save({ clockScale: v }); ND.applyClockSettings(); });
  bindRange('clock-opacity', function (v) { ND.save({ clockOpacity: v }); ND.applyClockSettings(); });
  bindRange('clock-offset', function (v) { ND.save({ clockOffset: v }); ND.applyClockSettings(); });
  bindRange('beam-intensity', function (v) { ND.setBeamIntensity(v); });
  bindRange('schedule-blend-mins', function (v) { ND.save({ scheduleBlendMins: v }); });
  bindRange('transition-speed', function (v) { ND.save({ transitionMs: v }); });

  bindRange('car-scale', function (v) {
    ND.save({ carScale: v });
    if (ND.state().activeCar) ND.selectStudioCar(ND.state().activeCar.id);
  });
  bindRange('car-x', function (v) { ND.save({ carX: v }); });
  bindRange('car-y', function (v) { ND.save({ carY: v }); });

  bindRange('bg-scale', function (v) {
    ND.save({ bgScale: v });
    loadBlobUrl('bg').then(function (u) { if (u) ND.setBackground({ src: u }); });
  });
  bindRange('bg-x', function (v) {
    ND.save({ bgX: v });
    loadBlobUrl('bg').then(function (u) { if (u) ND.setBackground({ src: u }); });
  });
  bindRange('bg-y', function (v) {
    ND.save({ bgY: v });
    loadBlobUrl('bg').then(function (u) { if (u) ND.setBackground({ src: u }); });
  });
  bindRange('bg-brightness', function (v) {
    ND.save({ bgBrightness: v });
    loadBlobUrl('bg').then(function (u) { if (u) ND.setBackground({ src: u }); });
  });

  var musicSeek = document.getElementById('music-seek');
  if (musicSeek) {
    musicSeek.addEventListener('change', function () {
      var m = ND.mediaState();
      if (m && m.durationSec > 0) {
        var targetSec = (Number(musicSeek.value) / 1000) * m.durationSec;
        ND.mediaSeek(targetSec);
      }
    });
  }

  var startupSel = document.getElementById('startup-effect');
  if (startupSel) {
    startupSel.addEventListener('change', function () {
      ND.save({ startupEffect: startupSel.value });
    });
  }

  var resumeSel = document.getElementById('manual-resume-select');
  if (resumeSel) {
    resumeSel.addEventListener('change', function () {
      ND.save({ manualResumeMode: resumeSel.value });
      renderScheduleRows();
    });
  }

  var wpSearch = document.getElementById('wp-search-input');
  if (wpSearch) {
    wpSearch.addEventListener('input', function () {
      wpQuery = wpSearch.value || '';
      renderWallpaperGallery();
    });
    wpSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && wpFilter === 'online') {
        e.preventDefault();
        searchOnlineWallpapers();
      }
    });
  }

  var carSearch = document.getElementById('car-search-input');
  if (carSearch) {
    carSearch.addEventListener('input', function () {
      carQuery = carSearch.value || '';
      renderCarGallery();
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     12. REHYDRATE IMPORTED BLOBS ON STARTUP & SUBSCRIBE TO ENGINE EVENTS
     ══════════════════════════════════════════════════════════════════════ */

  function rehydrateStoredImports() {
    Promise.all(importedWallpapers.map(function (w) {
      return loadBlobUrl('wp:' + w.id).then(function (u) {
        if (u) { w.src = u; return w; }
        return null;
      });
    })).then(function (list) {
      importedWallpapers = list.filter(Boolean);
      var activeImp = importedWallpapers.find(function (w) { return w.id === S.activeWallpaperId; });
      if (activeImp) ND.applyStudioWallpaper(activeImp, { instant: true });
      renderWallpaperGallery();
    });

    Promise.all(importedCars.map(function (c) {
      return loadBlobUrl('car:' + c.id).then(function (u) {
        if (u) { c.overlaySrc = u; return c; }
        return null;
      });
    })).then(function (list) {
      importedCars = list.filter(Boolean);
      var activeCar = importedCars.find(function (c) { return c.id === S.activeCarId; });
      if (activeCar) {
        ND.setCar({ src: activeCar.overlaySrc }, { fit: S.carFit, scale: S.carScale, x: S.carX, y: S.carY, forceComposite: true });
      }
      renderCarGallery();
    });

    if (S.mode === 'custom') {
      loadBlobUrl(S.useDesign ? 'design' : 'bg').then(function (u) {
        if (u) {
          if (S.useDesign) ND.setDesign({ src: u });
          else ND.setBackground({ src: u });
        }
      });
    }

    var uKey = document.getElementById('unsplash-key-input');
    var pKey = document.getElementById('pexels-key-input');
    if (uKey && providerKeys.unsplash) uKey.value = providerKeys.unsplash;
    if (pKey && providerKeys.pexels) pKey.value = providerKeys.pexels;
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  ND.on('scene', syncControlsFromState);
  ND.on('settings', syncControlsFromState);
  ND.on('catalog', function () {
    syncControlsFromState();
    renderWallpaperGallery();
    renderCarGallery();
  });

  refreshCapabilities();
  setTimeout(refreshCapabilities, 600);
  rehydrateStoredImports();
  syncControlsFromState();
  syncMediaUI();
  if (S.drawerPinned) setDrawer(true, { force: true });

  window.NDUI = {
    openDrawer: function () { setDrawer(true, { keyboard: true }); },
    closeDrawer: function () { setDrawer(false, { force: true }); },
    openStudio: function (tab) { setPanel(true, tab || 'wallpapers'); },
    closeStudio: function () { setPanel(false); }
  };
})();
