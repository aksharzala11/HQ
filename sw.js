// HQ offline support. App files are network-first so new deploys show up right away;
// /api calls are never cached. Only touches HQ's own caches (Doable shares this origin).
const C = 'hq-v2';
const FILES = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x.startsWith('hq-') && x !== C).map(x => caches.delete(x))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(C).then(c => c.put(req, copy)); } return r; })
    .catch(() => caches.open(C).then(c => c.match(req, { ignoreSearch: true })).then(r => r || caches.open(C).then(c => c.match('./index.html')))));
});
