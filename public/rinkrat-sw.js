/* RinkRat Mobile Batch N1B — installable shell plus saved read-only matchup access. */
const RINKRAT_CACHE_VERSION = 'rc50-v1';
const RINKRAT_CACHE_PREFIX = 'rinkrat-pwa-';
const SHELL_CACHE = `${RINKRAT_CACHE_PREFIX}shell-${RINKRAT_CACHE_VERSION}`;
const ASSET_CACHE = `${RINKRAT_CACHE_PREFIX}assets-${RINKRAT_CACHE_VERSION}`;

const APP_SHELL_URLS = [
  '/',
  '/index.html',
  '/offline.html',
  '/favicon.ico',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  '/assets/branding/rinkrat-headshot.png',
  '/assets/branding/rinkrat-mascot-full.png',
];

const NETWORK_ONLY_PATHS = [
  '/release-manifest.json',
  '/rinkrat-sw.js',
  '/site.webmanifest',
];

const NETWORK_ONLY_PREFIXES = [
  '/v1/',
  '/stats/',
  '/espn/',
  '/security/',
];

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(RINKRAT_CACHE_PREFIX))
          .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (event.data?.type === 'CLEAR_RINKRAT_CACHES') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(RINKRAT_CACHE_PREFIX))
          .map((key) => caches.delete(key)),
      )),
    );
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin || isNetworkOnlyPath(url.pathname)) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isCacheableAssetRequest(request, url.pathname)) {
    event.respondWith(cacheFirstAsset(request));
  }
});

async function precacheAppShell() {
  const shellCache = await caches.open(SHELL_CACHE);
  const assetCache = await caches.open(ASSET_CACHE);

  await Promise.all(APP_SHELL_URLS.map(async (url) => {
    try {
      const response = await fetch(new Request(url, { cache: 'reload' }));

      if (!response.ok) {
        return;
      }

      await shellCache.put(url, response.clone());

      if (url === '/index.html') {
        await precacheBuiltShellAssets(response, assetCache);
      }
    } catch {
      // A later online visit can fill any shell entry that was temporarily unavailable.
    }
  }));
}

async function precacheBuiltShellAssets(indexResponse, assetCache) {
  let html = '';

  try {
    html = await indexResponse.text();
  } catch {
    return;
  }

  const assetUrls = extractBuiltShellAssetUrls(html);

  await Promise.all(assetUrls.map(async (url) => {
    try {
      const request = new Request(url, { cache: 'reload' });
      const response = await fetch(request);

      if (response.ok && response.type === 'basic') {
        await assetCache.put(request, response);
      }
    } catch {
      // The app remains installable even when one optional build asset cannot be prefetched.
    }
  }));
}

function extractBuiltShellAssetUrls(html) {
  const urls = new Set();
  const attributePattern = /(?:src|href)=["']([^"']+)["']/gi;
  let match;

  while ((match = attributePattern.exec(html)) !== null) {
    try {
      const url = new URL(match[1], self.location.origin);

      if (
        url.origin === self.location.origin &&
        /\.(?:js|css)$/i.test(url.pathname) &&
        !isNetworkOnlyPath(url.pathname)
      ) {
        urls.add(`${url.pathname}${url.search}`);
      }
    } catch {
      // Ignore malformed or unsupported index references.
    }
  }

  return [...urls];
}

function isNetworkOnlyPath(pathname) {
  return NETWORK_ONLY_PATHS.includes(pathname) ||
    NETWORK_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isCacheableAssetRequest(request, pathname) {
  if (['script', 'style', 'font', 'image', 'manifest'].includes(request.destination)) {
    return true;
  }

  return /\.(?:js|css|woff2?|png|jpe?g|webp|svg|ico|webmanifest)$/i.test(pathname);
}

async function networkFirstNavigation(request) {
  const shellCache = await caches.open(SHELL_CACHE);

  try {
    const response = await fetch(request);

    if (response.ok) {
      await shellCache.put('/index.html', response.clone());
      return response;
    }
  } catch {
    // Fall through to the previously loaded application shell.
  }

  return (await shellCache.match('/index.html')) ||
    (await shellCache.match('/')) ||
    (await shellCache.match('/offline.html')) ||
    Response.error();
}

async function cacheFirstAsset(request) {
  const assetCache = await caches.open(ASSET_CACHE);
  const cached = await assetCache.match(request);

  if (cached) {
    return cached;
  }

  const response = await fetch(request);

  if (response.ok && response.type === 'basic') {
    await assetCache.put(request, response.clone());
  }

  return response;
}
