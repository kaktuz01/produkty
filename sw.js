// Service worker: приложение работает офлайн.
// При обновлении файлов увеличьте номер версии ниже.
const VERSION = 'produkty-v14';
const FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('produkty-v') && k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Сначала кэш (быстро и офлайн), в фоне обновляем из сети.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
      return cached || network;
    })
  );
});

/* ---------- уведомления ---------- */
// Страница сообщает, какой список открыт и какие продукты уже известны; пуш приходит пустым,
// а что нового, воркер узнаёт из самого списка.
const CTX = 'produkty-ctx';
async function saveCtx(d) {
  const c = await caches.open(CTX);
  await c.put('ctx', new Response(JSON.stringify({ db: d.db, list: d.list, me: d.me, seen: d.seen })));
}
async function loadCtx() {
  try { const r = await (await caches.open(CTX)).match('ctx'); return r ? await r.json() : null; } catch (e) { return null; }
}
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'ctx') e.waitUntil(saveCtx(e.data));
});

async function onPush() {
  const ctx = await loadCtx();
  let fresh = null;                       // null: узнать не удалось
  if (ctx && ctx.list && ctx.db) {
    try {
      const r = await fetch(`${ctx.db}/lists/${ctx.list}/items.json`, { cache: 'no-store' });
      if (r.ok) {
        const items = (await r.json()) || {};
        const seen = new Set(ctx.seen || []);
        fresh = Object.entries(items)
          .filter(([id, x]) => x && typeof x === 'object' && x.n && !x.d && !seen.has(id) && x.a !== ctx.me)
          .map(([, x]) => x);
        ctx.seen = Object.keys(items);
        await saveCtx(ctx);
      }
    } catch (err) { fresh = null; }
  }
  const quiet = !!fresh && !fresh.length;  // всё уже видели в открытом приложении
  let title = 'Семейный список', body = 'В списке есть новое';
  if (fresh && fresh.length) {
    const who = [...new Set(fresh.map(x => x.a).filter(Boolean))].join(', ');
    const names = fresh.slice(0, 4).map(x => x.n).join(', ') + (fresh.length > 4 ? ` и ещё ${fresh.length - 4}` : '');
    title = 'Новое в списке';
    body = (who ? who + ': ' : '') + names;
  }
  // iOS требует показать уведомление на каждый пуш; «ненужное» показываем и сразу убираем
  await self.registration.showNotification(title, { body, icon: 'icon-192.png', tag: quiet ? 'quiet' : 'fam', renotify: !quiet });
  if (quiet) (await self.registration.getNotifications({ tag: 'quiet' })).forEach(n => n.close());
}
self.addEventListener('push', e => e.waitUntil(onPush()));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { c.postMessage({ type: 'open-family' }); return c.focus(); }
    }
    return self.clients.openWindow(new URL('./#family', self.registration.scope).href);
  })());
});
