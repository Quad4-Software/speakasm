/* speakasm service worker: offline shell, COOP/COEP isolation, auto-update */
const CACHE_VERSION = 'speakasm-v0.1.5';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;

const PRECACHE = [
  '/',
  '/index.html',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/voices.json',
  '/css/app.css',
  '/js/main.js',
  '/js/pwa.js',
  '/js/ui/app.js',
  '/js/ui/wave.js',
  '/js/audio/wav.js',
  '/js/text/clean.js',
  '/js/docs/extract.js',
  '/js/engine/kokoro.js',
  '/js/engine/kokoro-runtime.js',
  '/js/engine/kokoro-worker.js',
  '/icons/favicon-16.png',
  '/icons/favicon-32.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/voices/af_heart.png',
  '/icons/voices/af_bella.png',
  '/icons/voices/af_sarah.png',
  '/icons/voices/af_nicole.png',
  '/icons/voices/af_nova.png',
  '/icons/voices/af_sky.png',
  '/icons/voices/am_adam.png',
  '/icons/voices/am_michael.png',
  '/icons/voices/am_fenrir.png',
  '/icons/voices/am_puck.png',
  '/icons/voices/bf_emma.png',
  '/icons/voices/bf_isabella.png',
  '/icons/voices/bm_george.png',
  '/icons/voices/bm_lewis.png',
  '/fonts/bricolage-700.woff2',
  '/fonts/source-sans-400.woff2',
  '/fonts/source-sans-600.woff2',
  '/vendor/jszip/jszip.min.js',
  '/vendor/kokoro/kokoro.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      for (const url of PRECACHE) {
        try {
          await cache.add(url);
        } catch {
          /* optional assets may be missing until make assets */
        }
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('speakasm-') && !key.startsWith(CACHE_VERSION))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'GET_VERSION') {
    event.source && event.source.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
    return;
  }
  if (data.type === 'CACHE_URLS') {
    const port = event.ports && event.ports[0];
    event.waitUntil(cacheUrls(data.urls || [], port));
  }
});

/**
 * @param {string[]} urls
 * @param {MessagePort | undefined} port
 */
async function cacheUrls(urls, port) {
  try {
    const cache = await caches.open(ASSET_CACHE);
    const list = urls.filter((u) => typeof u === 'string' && u.startsWith('/'));
    for (let i = 0; i < list.length; i++) {
      const url = list[i];
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) {
        throw new Error(`Could not fetch ${url}`);
      }
      await cache.put(url, res.clone());
      port && port.postMessage({ type: 'CACHE_PROGRESS', done: i + 1, total: list.length });
    }
    port && port.postMessage({ type: 'CACHE_DONE' });
  } catch (err) {
    const msg = err && typeof err === 'object' && 'message' in err
      ? String(/** @type {{ message: string }} */ (err).message)
      : 'Could not cache models.';
    port && port.postMessage({ type: 'CACHE_ERROR', error: msg });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') {
    return;
  }
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') {
    return;
  }

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname === '/sw.js') {
    event.respondWith(networkOnly(req));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL_CACHE, '/index.html'));
    return;
  }

  if (
    url.pathname.startsWith('/models/') ||
    url.pathname.startsWith('/vendor/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.startsWith('/icons/')
  ) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});

/**
 * @param {Response} response
 * @returns {Response}
 */
function withIsolationHeaders(response) {
  if (!response || response.status === 0 || response.type === 'opaque') {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function networkOnly(req) {
  return fetch(req);
}

async function networkFirst(req, cacheName, fallbackPath) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone());
    }
    return withIsolationHeaders(fresh);
  } catch {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req);
    if (cached) {
      return withIsolationHeaders(cached);
    }
    if (fallbackPath) {
      const fallback = await cache.match(fallbackPath);
      if (fallback) {
        return withIsolationHeaders(fallback);
      }
    }
    return withIsolationHeaders(new Response('Offline', { status: 503, statusText: 'Offline' }));
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    return withIsolationHeaders(cached);
  }
  const fresh = await fetch(req);
  if (fresh && fresh.ok) {
    cache.put(req, fresh.clone());
  }
  return withIsolationHeaders(fresh);
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((fresh) => {
      if (fresh && fresh.ok) {
        cache.put(req, fresh.clone());
      }
      return fresh;
    })
    .catch(() => cached);
  const response = cached || (await network);
  return withIsolationHeaders(response);
}
