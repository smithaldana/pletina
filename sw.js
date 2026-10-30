// Pletina se mudó a /musica/: este service worker se da de baja solo y lleva allí.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    await self.registration.unregister();
    const wins = await self.clients.matchAll({ type: 'window' });
    wins.forEach(w => w.navigate('/musica/'));
  })());
});
