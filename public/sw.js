const CACHE_NAME = 'iptv-admin-static-v1';

const STATIC_ASSETS = [
  '/logo.png',
  '/style.css',
  '/app.js',
  '/i18n.js',
  '/ai.js',
  '/ai-i18n.js',
  '/vendor/bootstrap.min.css',
  '/vendor/bootstrap.bundle.min.js',
  '/vendor/bootstrap-icons.min.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('iptv-admin-static-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Never cache login, API, stream, playlist, or other dynamic responses.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/share/') ||
    url.pathname.startsWith('/hdhr/') ||
    url.pathname.startsWith('/stalker_portal/') ||
    /\.(m3u8?|mpd|ts|m4s|mp4|mkv|mp3|aac|vtt)$/i.test(url.pathname) ||
    /(^|\/)(player_api\.php|get\.php|xmltv\.php|portal\.php)$/.test(url.pathname)
  ) {
    return;
  }

  // Only serve explicitly listed static assets from cache.
  if (!STATIC_ASSETS.includes(url.pathname)) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request);
    })
  );
});
