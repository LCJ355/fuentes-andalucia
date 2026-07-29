const CACHE = 'fuentes-v3';
const BASE = self.location.pathname.replace(/\/[^/]*$/, '');
const URLS = [
  BASE + '/index.html', BASE + '/style.css', BASE + '/main.js', BASE + '/photo_counts.js',
  BASE + '/fuentes_complete.json', BASE + '/fuentes_complete.js',
  BASE + '/manifest.json', BASE + '/lib/leaflet.js', BASE + '/lib/leaflet.css',
  BASE + '/lib/leaflet.markercluster.js', BASE + '/lib/MarkerCluster.css', BASE + '/lib/MarkerCluster.Default.css'
];
const TILE_CACHE = 'osm-tiles-v1';
const MAX_TILES = 2000;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    for (const url of URLS) {
      try {
        const resp = await fetch(url);
        if (resp.ok) await c.put(url, resp);
      } catch(_) { /* skip */ }
    }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = new Set([CACHE, TILE_CACHE]);
    for (const key of await caches.keys()) {
      if (!keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Map tiles -> progressive tile cache
  const tileHosts = ['tile.openstreetmap.org', 'tile.opentopomap.org', 'tile-cyclosm.openstreetmap.fr', 'server.arcgisonline.com'];
  if (tileHosts.some(h => url.hostname.endsWith(h))) {
    e.respondWith(tileStrategy(e.request));
    return;
  }

  // Everything else -> cache-first
  e.respondWith(cacheFirst(e.request));
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const c = await caches.open(CACHE);
      await c.put(req, resp.clone());
    }
    return resp;
  } catch(e) {
    return new Response('Offline', { status: 503 });
  }
}

async function tileStrategy(req) {
  const cached = await caches.match(req);
  if (cached) return cached;

  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const c = await caches.open(TILE_CACHE);
      // Limit tile cache size
      const keys = await c.keys();
      if (keys.length < MAX_TILES) {
        await c.put(req, resp.clone());
      } else {
        // Evict oldest tile when full
        const evict = keys.sort()[0];
        await c.delete(evict);
        await c.put(req, resp.clone());
      }
    }
    return resp;
  } catch(e) {
    // If image failed (offline), return a transparent pixel
    return new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect fill="#1a1a2e" width="256" height="256"/></svg>',
      { headers: { 'Content-Type': 'image/svg+xml' } }
    );
  }
}
