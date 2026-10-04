/* ══════════════════════════════════════════════
   NIGHTDRIVE — Service worker: offline engine shell
   Pre-caches every file the wallpaper needs at runtime, so the scene,
   HUD and controls keep working with no network at all.
   Bump CACHE_NAME (nightdrive-vX.Y.Z) whenever engine files change —
   the new worker then re-pre-caches and drops the old cache.
   ══════════════════════════════════════════════ */

'use strict';

const CACHE_NAME = 'nightdrive-v1.3.1';

// Paths are relative to this worker, so the app also works when it is
// hosted from a sub-directory. Every file listed here is validated by
// `npm test` (scripts/validate.mjs).
const PRECACHE_URLS = [
  './index.html',
  './script.js',
  './styles.css',
  './engine-start.wav',
  './assets/morning/scene.jpg',
  './assets/morning/scene.svg',
  './assets/day/scene.jpg',
  './assets/day/scene.svg',
  './assets/golden-hour/scene.jpg',
  './assets/golden-hour/scene.svg',
  './assets/dusk/scene.jpg',
  './assets/dusk/scene.svg',
  './assets/dusk/headlights.jpg',
  './assets/dusk/headlights.svg',
  './assets/night/scene.jpg',
  './assets/night/scene.svg',
  './assets/night/headlights.jpg',
  './assets/night/headlights.svg',
  './assets/midnight/scene.jpg',
  './assets/midnight/headlights.jpg',
  './assets/midnight/headlights.svg'
];

// The page loads script.js?v=5, styles.css?v=6, … so query strings are
// ignored when matching. Responses are stored under the plain path to keep
// exactly one cache entry per file.
const MATCH_OPTS = { ignoreSearch: true };
const cacheKey = (request) => {
  const url = new URL(request.url);
  return url.origin + url.pathname;
};

function cachePut(request, response) {
  if (!response || !response.ok) return response;
  const copy = response.clone();
  caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey(request), copy));
  return response;
}

/** Serve the cached copy instantly, refresh it in the background for next time. */
function staleWhileRevalidate(request) {
  return caches.match(request, MATCH_OPTS).then((cached) => {
    if (cached) {
      fetch(request).then((response) => cachePut(request, response)).catch(() => {});
      return cached;
    }
    return fetch(request).then((response) => cachePut(request, response));
  });
}

// Install — fetch and store the engine. A single missing file (e.g. a host
// that ships a trimmed asset set) must not break offline mode for the rest.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

// Activate — delete caches from older releases, then take over open pages.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Fonts (Google Fonts) and weather APIs stay network-only; offline the app
  // simply falls back to system fonts.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Page loads: prefer fresh HTML when online, fall back to the cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html', MATCH_OPTS))
    );
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
