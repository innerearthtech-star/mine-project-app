// ── Service worker: app works with no signal ───────────────────────
// - App shell precached (HTML/CSS/JS/libs/icons)
// - Esri map tiles cached as you browse (view the site online once
//   and that area keeps working offline)
// - Uploaded photos cached after first view
// - Supabase API calls always go to the network (sync.js queues offline)

const VERSION = 'v34';
const SHELL_CACHE = `shell-${VERSION}`;
const TILE_CACHE = 'tiles-v1';
const PHOTO_CACHE = 'photos-v1';
const TILE_MAX = 4000;
const PHOTO_MAX = 600;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/config.js',
  './js/util.js',
  './js/db.js',
  './js/store.js',
  './js/sync.js',
  './js/map.js',
  './js/wells.js',
  './js/job.js',
  './js/contacts.js',
  './js/settings.js',
  './js/videos.js',
  './libs/leaflet/leaflet.js',
  './libs/leaflet/leaflet.css',
  './libs/supabase.js',
  './libs/tus.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-mask.png',
];

self.addEventListener('install', e => {
  // NOTE: no skipWaiting() here — a new version waits until the user taps
  // "Update" in the app (app.js posts SKIP_WAITING), so we never swap the
  // code out from under someone mid-task.
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING' || (e.data && e.data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith('shell-') && k !== SHELL_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Cache only verified 200s — an opaque or error response cached once
// (a 404 photo, a captive-portal page) would otherwise be served forever.
async function cacheFirst(cacheName, req, maxEntries) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    cache.put(req, res.clone());
    if (maxEntries) trim(cache, maxEntries);
  }
  return res;
}

async function trim(cache, max) {
  const keys = await cache.keys();
  if (keys.length > max) {
    for (const k of keys.slice(0, keys.length - max)) await cache.delete(k);
  }
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Supabase API / realtime — never intercept
  if (url.hostname.endsWith('.supabase.co')) {
    // …except public PHOTOS, cached for offline viewing. Videos are
    // deliberately not cached — multi-GB files would nuke the quota.
    if (url.pathname.includes('/storage/v1/object/public/photos/')) {
      e.respondWith(cacheFirst(PHOTO_CACHE, e.request, PHOTO_MAX));
    }
    return;
  }

  // Esri tiles — cache as you browse
  if (url.hostname === 'server.arcgisonline.com') {
    e.respondWith(
      cacheFirst(TILE_CACHE, e.request, TILE_MAX).catch(() => new Response('', { status: 404 }))
    );
    return;
  }

  // App navigation — network first so updates land, cached shell as
  // fallback. Only a real 200 gets cached (a captive-portal login page or
  // a 5xx must never replace the offline copy of the app).
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) caches.open(SHELL_CACHE).then(c => c.put('./index.html', res.clone()));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Same-origin static files — serve cached instantly, refresh in the
  // background so a Vercel deploy reaches phones by their next launch.
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const cached = await caches.match(e.request);
      const refresh = fetch(e.request).then(res => {
        if (res.ok) caches.open(SHELL_CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => null);
      return cached || (await refresh) || new Response('', { status: 504 });
    })());
  }
});
