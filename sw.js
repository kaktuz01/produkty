// Service worker: приложение работает офлайн.
// При обновлении файлов увеличьте номер версии ниже.
const VERSION = 'produkty-v19';
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
  await c.put('ctx', new Response(JSON.stringify({ db: d.db, list: d.list, me: d.me, dev: d.dev, seen: d.seen, seenT: d.seenT })));
}
async function loadCtx() {
  try { const r = await (await caches.open(CTX)).match('ctx'); return r ? await r.json() : null; } catch (e) { return null; }
}
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'ctx') e.waitUntil(saveCtx(e.data));
});

async function readJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('http ' + r.status);
  return (await r.json()) || {};
}
async function onPush() {
  const ctx = await loadCtx();
  let freshItems = null, freshTasks = null;           // null: узнать не удалось
  if (ctx && ctx.list && ctx.db) {
    try {
      const [items, tasks] = await Promise.all([
        readJson(`${ctx.db}/lists/${ctx.list}/items.json`),
        readJson(`${ctx.db}/lists/${ctx.list}/tasks.json`)
      ]);
      const seen = new Set(ctx.seen || []), seenT = new Set(ctx.seenT || []);
      freshItems = Object.entries(items)
        .filter(([id, x]) => x && typeof x === 'object' && x.n && !x.d && !seen.has(id) && x.a !== ctx.me).map(([, x]) => x);
      freshTasks = Object.entries(tasks)
        .filter(([id, x]) => x && typeof x === 'object' && x.n && !x.d && !seenT.has(id) && x.a !== ctx.me).map(([, x]) => x);
      ctx.seen = Object.keys(items); ctx.seenT = Object.keys(tasks);
      await saveCtx(ctx);
    } catch (err) { freshItems = freshTasks = null; }
  }
  const nI = freshItems ? freshItems.length : 0, nT = freshTasks ? freshTasks.length : 0;
  const quiet = !!freshItems && !nI && !nT;           // всё уже видели в открытом приложении
  let title = 'Семья', body = 'В списках есть новое', tag = 'fam', tabName = 'shop';
  const list = (arr, f) => arr.slice(0, 3).map(f).join(', ') + (arr.length > 3 ? ` и ещё ${arr.length - 3}` : '');
  const who = arr => [...new Set(arr.map(x => x.a).filter(Boolean))].join(', ');
  if (nT && !nI) {
    const mine = freshTasks.filter(x => ctx.dev && x.s === ctx.dev);
    title = mine.length ? 'Дело для вас' : 'Новое дело';
    body = (who(freshTasks) ? who(freshTasks) + ': ' : '') + list(freshTasks, x => x.n);
    tag = 'tasks'; tabName = 'tasks';
  } else if (nI && !nT) {
    title = 'Новое в покупках';
    body = (who(freshItems) ? who(freshItems) + ': ' : '') + list(freshItems, x => x.n);
  } else if (nI && nT) {
    title = 'Новое в семье';
    body = `Покупки: ${list(freshItems, x => x.n)}. Дела: ${list(freshTasks, x => x.n)}`;
  }
  // iOS требует показать уведомление на каждый пуш; «ненужное» показываем и сразу убираем
  await self.registration.showNotification(title, { body, icon: 'icon-192.png', tag: quiet ? 'quiet' : tag, renotify: !quiet, data: { tab: tabName } });
  if (quiet) (await self.registration.getNotifications({ tag: 'quiet' })).forEach(n => n.close());
}
self.addEventListener('push', e => e.waitUntil(onPush()));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const tabName = (e.notification.data && e.notification.data.tab) || 'shop';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { c.postMessage({ type: 'open-tab', tab: tabName }); return c.focus(); }
    }
    return self.clients.openWindow(new URL('./#' + tabName, self.registration.scope).href);
  })());
});
