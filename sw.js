const CACHE = 'kb-v1';

const SHELL = [
  '/',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon.svg',
  'https://cdn.jsdelivr.net/npm/fuse.js@7/dist/fuse.min.js',
  'https://cdn.jsdelivr.net/npm/marked@9/marked.min.js',
];

// ── Install: cache app shell ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ──
self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API calls → network only (need server)
  if (url.pathname.startsWith('/api/')) return;

  // search-index.json → network first (changes on note save)
  if (url.pathname === '/search-index.json') {
    e.respondWith(networkFirst(request));
    return;
  }

  // Vault markdown & images → stale-while-revalidate
  if (url.pathname.startsWith('/vault/')) {
    e.respondWith(staleWhileRevalidate(request));
    return;
  }

  // CDN resources & app shell → cache first
  e.respondWith(cacheFirst(request));
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    return caches.match(req) || new Response('{}', {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function staleWhileRevalidate(req) {
  const cached = await caches.match(req);
  const fresh = fetch(req).then(res => {
    if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
    return res;
  }).catch(() => null);
  return cached || fresh;
}
