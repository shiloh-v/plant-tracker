// Minimal service worker for Shiloh's Plants.
// Caches the app shell so the page loads offline; lets Supabase API + storage
// requests go straight to the network (they need fresh data anyway).
const CACHE = 'plants-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.json', '/icon-192.svg', '/icon-512.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);

  // Bypass Supabase and any cross-origin API calls
  if (u.hostname.includes('supabase')) return;
  if (u.hostname.includes('cdn.jsdelivr.net')) return;
  if (u.hostname.includes('fonts.googleapis.com')) return;
  if (u.hostname.includes('fonts.gstatic.com')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        // Cache successful shell-like responses for next offline load
        if (resp.ok && resp.type === 'basic') {
          const respClone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, respClone));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
