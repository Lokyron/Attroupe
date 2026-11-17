/* global self, caches */

const CACHE_NOM = 'attroupe-coquille-v2';
const COQUILLE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/logo.png',
  '/icons/favicon-32.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NOM).then((cache) => cache.addAll(COQUILLE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cles) => Promise.all(cles.filter((c) => c !== CACHE_NOM).map((c) => caches.delete(c))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Données dynamiques, flux iCal et médias signés : réseau direct uniquement, jamais de cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ical/') || url.pathname.startsWith('/media/')) {
    return;
  }

  // Navigation hors ligne : réseau d'abord, repli sur la coquille en cache.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((reponse) => {
          if (reponse.ok) {
            const copie = reponse.clone();
            void caches.open(CACHE_NOM).then((cache) => cache.put('/', copie));
          }
          return reponse;
        })
        .catch(() => caches.match('/').then((r) => r ?? caches.match('/index.html'))),
    );
    return;
  }

  // Actifs statiques (/assets/*, icônes, manifeste) : stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE_NOM).then((cache) =>
      cache.match(request).then((enCache) => {
        const reseau = fetch(request)
          .then((reponse) => {
            if (reponse.ok) {
              void cache.put(request, reponse.clone());
            }
            return reponse;
          })
          .catch(() => enCache);
        return enCache ?? reseau;
      }),
    ),
  );
});

self.addEventListener('push', (event) => {
  let title = 'Attroupe';
  let body = '';
  let url = '/#/';
  let tag = 'attroupe';

  if (event.data) {
    try {
      const donnees = event.data.json();
      if (donnees && typeof donnees === 'object') {
        if (typeof donnees.title === 'string' && donnees.title !== '') title = donnees.title;
        if (typeof donnees.body === 'string') body = donnees.body;
        if (typeof donnees.url === 'string' && donnees.url !== '') url = donnees.url;
        if (typeof donnees.tag === 'string' && donnees.tag !== '') tag = donnees.tag;
      }
    } catch {
      body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/favicon-32.png',
      data: { url: url || '/#/' },
      tag,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const donnees = event.notification.data;
  const urlBrute = donnees && typeof donnees.url === 'string' && donnees.url !== '' ? donnees.url : '/#/';
  const urlCible = new URL(urlBrute, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((fenetres) => {
      for (const client of fenetres) {
        if (new URL(client.url).origin === self.location.origin) {
          if (client.url !== urlCible && 'navigate' in client && typeof client.navigate === 'function') {
            return client.navigate(urlCible).then((c) => (c ? c.focus() : undefined));
          }
          if ('focus' in client && typeof client.focus === 'function') {
            return client.focus();
          }
        }
      }
      return self.clients.openWindow(urlCible);
    }),
  );
});
