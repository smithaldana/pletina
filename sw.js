/* Pletina · service worker: funciona sin conexión y recibe archivos compartidos */
const VERSION = 'pletina-v8';
const FONTS = 'pletina-fonts';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      // Solo cachés viejas de Pletina: el dominio lo comparten otras apps
      .then(keys => Promise.all(keys.filter(k => k.startsWith('pletina-') && k !== VERSION && k !== FONTS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // «Compartir → Pletina» desde otras apps (Archivos, Drive, WhatsApp…)
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;

  if (url.origin === location.origin) {
    if (req.mode === 'navigate') {
      // Red primero para recibir actualizaciones; caché si no hay conexión
      e.respondWith(
        fetch(req)
          .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); return res; })
          .catch(() => caches.match('./index.html'))
      );
      return;
    }
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      c.put(req, res.clone());
      return res;
    }));
  }
});

function openInbox() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('pletina-inbox', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function receiveShare(req) {
  let n = 0;
  try {
    const form = await req.formData();
    const files = form.getAll('media').filter(f => f && typeof f === 'object' && f.size);
    n = files.length;
    if (n) {
      const db = await openInbox();
      await new Promise((res, rej) => {
        const tx = db.transaction('files', 'readwrite');
        const store = tx.objectStore('files');
        files.forEach(f => store.add(f));
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    }
  } catch (err) { /* si falla, la app abre igual */ }
  return Response.redirect('./?compartido=' + n, 303);
}
