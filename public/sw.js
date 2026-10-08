// A service worker that does nothing but pass requests through to the network. Chrome on
// Android only offers "Install app" (the standalone window without the address bar) for a
// site that has one with a fetch handler; the app needs the server anyway, so nothing is
// cached and it doesn't work offline.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request))
})
