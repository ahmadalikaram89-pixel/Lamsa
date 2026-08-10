// Minimal service worker — exists only to satisfy PWA installability
// criteria (Chrome requires a registered service worker with a fetch
// handler before offering "Add to Home Screen"). Deliberately does no
// caching, so it can never serve stale HTML/CSS/JS or API responses —
// every request passes straight through to the network.
self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request));
});
