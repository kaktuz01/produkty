// Сервер уведомлений для «Продуктов». Без хранилища: подписки лежат в Firebase рядом со списком
// (lists/<код>/push/<хеш>), а здесь только отправка «пустого» Web Push с подписью VAPID.
// Телефон, получив такой пуш, сам смотрит в список и показывает, что нового.

const ID_RE = /^[a-z0-9]{20,40}$/;
const enc = new TextEncoder();

const b64u = buf => {
  const a = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of a) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type'
};
const reply = (body, status = 200, extra = {}) => new Response(body, { status, headers: { ...CORS, ...extra } });

let cached = null;
async function keys(env) {
  if (cached) return cached;
  const jwk = JSON.parse(env.VAPID_PRIVATE);
  const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const pub = new Uint8Array(65);                      // несжатая точка: 0x04 | X | Y
  pub[0] = 4; pub.set(fromB64u(jwk.x), 1); pub.set(fromB64u(jwk.y), 33);
  cached = { priv, pubB64: b64u(pub) };
  return cached;
}

async function vapidHeader(env, endpoint) {
  const { priv, pubB64 } = await keys(env);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'https://kaktuz01.github.io/produkty/'
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, enc.encode(head + '.' + claims));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${pubB64}`;
}

async function ping(env, endpoint) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { authorization: await vapidHeader(env, endpoint), ttl: '3600', urgency: 'normal', 'content-length': '0' }
  });
}

async function notify(env, list, from) {
  const base = `${env.DB_URL}/lists/${list}/push`;
  const r = await fetch(base + '.json');
  if (!r.ok) return { sent: 0, error: 'db ' + r.status };
  const subs = (await r.json()) || {};
  let sent = 0, dropped = 0;
  const jobs = Object.entries(subs).filter(([h, v]) => h !== from && v && typeof v.e === 'string').slice(0, 12).map(async ([h, v]) => {
    let url;
    try { url = new URL(v.e); } catch (e) { return; }
    if (url.protocol !== 'https:') return;
    try {
      const res = await ping(env, v.e);
      if (res.status === 404 || res.status === 410) { dropped++; await fetch(`${base}/${h}.json`, { method: 'DELETE' }); }
      else if (res.ok) sent++;
    } catch (e) { /* сеть: пропускаем */ }
  });
  await Promise.all(jobs);
  return { sent, dropped };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return reply(null, 204);
    try {
      if (url.pathname === '/vapid') return reply((await keys(env)).pubB64, 200, { 'content-type': 'text/plain' });
      if (url.pathname === '/notify' && req.method === 'POST') {
        const m = JSON.parse(await req.text());
        if (!m || !ID_RE.test(String(m.list))) return reply('bad list', 400);
        const out = await notify(env, m.list, m.from ? String(m.from).slice(0, 40) : '');
        return reply(JSON.stringify(out), 200, { 'content-type': 'application/json' });
      }
      return reply('produkty-push', 200, { 'content-type': 'text/plain' });
    } catch (e) {
      return reply('error', 500);
    }
  }
};
