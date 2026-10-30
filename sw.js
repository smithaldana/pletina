/* Pletina · service worker: funciona sin conexión y recibe archivos compartidos */
const VERSION = 'pletina-v11';
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

  // Streaming desde Google Drive: el reproductor pide stream/<id> y aquí se reenvía con la sesión de Google
  const streamBase = new URL('./stream/', self.registration.scope).pathname;
  if (url.origin === location.origin && url.pathname.startsWith(streamBase)) {
    e.respondWith(streamDrive(req, url, decodeURIComponent(url.pathname.slice(streamBase.length))));
    return;
  }

  if (url.origin === location.origin) {
    // El manifiesto siempre de la red (si hay), para que Chrome vea los cambios de la app
    if (url.pathname.endsWith('/manifest.webmanifest')) {
      e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; }).catch(() => caches.match(req)));
      return;
    }
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

function readToken() {
  return new Promise(res => {
    let r;
    try { r = indexedDB.open('pletina'); } catch { return res(null); }
    r.onupgradeneeded = () => { try { r.transaction.abort(); } catch {} };
    r.onsuccess = () => {
      const db = r.result;
      try {
        const q = db.transaction('meta', 'readonly').objectStore('meta').get('gtok');
        q.onsuccess = () => { db.close(); res(q.result || null); };
        q.onerror = () => { db.close(); res(null); };
      } catch { db.close(); res(null); }
    };
    r.onerror = () => res(null);
  });
}

async function streamDrive(req, url, id) {
  const tok = await readToken();
  if (!tok || !tok.token || tok.exp < Date.now()) return new Response('Sesión de Google caducada', { status: 401 });
  const size = +url.searchParams.get('s') || 0, mime = url.searchParams.get('m') || '';
  const headers = { Authorization: 'Bearer ' + tok.token };
  const range = req.headers.get('Range');
  if (range) headers.Range = range;
  let r;
  try { r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { headers }); }
  catch { return new Response('Sin conexión', { status: 503 }); }
  if (!r.ok && r.status !== 206) return new Response('', { status: r.status });
  const out = new Headers();
  out.set('Content-Type', mime || r.headers.get('Content-Type') || 'application/octet-stream');
  out.set('Accept-Ranges', 'bytes');
  const len = r.headers.get('Content-Length');
  if (len) out.set('Content-Length', len);
  let status = r.status;
  if (range) {
    const cr = r.headers.get('Content-Range');
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (cr) out.set('Content-Range', cr);
    else if (m && size) {
      const start = +m[1], end = len ? start + (+len) - 1 : (m[2] ? +m[2] : size - 1);
      out.set('Content-Range', `bytes ${start}-${Math.min(end, size - 1)}/${size}`);
    }
    if (out.has('Content-Range')) status = 206;
  }
  return new Response(r.body, { status, headers: out });
}

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
