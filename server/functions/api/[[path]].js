// survev observer's server (Cloudflare Pages Functions, D1 binding DB).
//   POST /api/upload   one batch from the userscript (gzip or plain text, at most 600 KB: the script sends at most 1500 lines a batch,
//                      about 200 KB zipped; 2 MB let one address store 120 MB a minute and 50 such rows broke the export). Rate limited per browser token and per
//                      address; the address itself is never stored, only a salted hash used for the limit.
//   GET  /api/export   (private: needs the EXPORT_KEY secret) batches after ?after=<id>, for the clip jury's puller: at most ?limit rows
//                      and about 4 MB of bodies a page (always one row at least), so a page fits the Worker's memory whatever was uploaded
//   POST /api/ack      (private) deletes batches up to {upto} once they are pulled
const TOKEN = /^[a-f0-9-]{16,40}$/, MAX_BYTES = 600000, EXPORT_BYTES = 4000000, PER_TOKEN_MIN = 12, PER_IP_MIN = 60, ORIGIN = 'https://survev.io';
const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Observer-Token, X-Observer-Encoding, X-Observer-Version', 'Access-Control-Max-Age': '86400' };
const json = (o, status, extra) => new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extra || {}) });

async function ipHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '', day = new Date().toISOString().slice(0, 10);
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode((env.IP_SALT || 'survev-observer') + '|' + day + '|' + ip));
  return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}
const b64 = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const authed = (request, env) => !!env.EXPORT_KEY && request.headers.get('X-Export-Key') === env.EXPORT_KEY;

export async function onRequest(ctx) {
  const { request, env } = ctx, url = new URL(request.url), p = url.pathname;
  try {
    if (p === '/api/upload') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
      const token = request.headers.get('X-Observer-Token') || '', enc = request.headers.get('X-Observer-Encoding') === 'gzip' ? 'gzip' : 'plain';
      if (!TOKEN.test(token)) return json({ error: 'bad token' }, 400, cors);
      const body = await request.arrayBuffer(), u = new Uint8Array(body);
      if (!u.length || u.length > MAX_BYTES) return json({ error: 'bad size' }, 413, cors);
      if (enc === 'gzip' ? !(u[0] === 0x1f && u[1] === 0x8b) : new TextDecoder().decode(u.subarray(0, 5)) !== '["B",') return json({ error: 'not a batch' }, 400, cors);
      const now = Date.now(), ip = await ipHash(request, env);
      const a = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM batches WHERE token = ? AND ts > ?) AS bt, (SELECT COUNT(*) FROM batches WHERE ip = ? AND ts > ?) AS bi').bind(token, now - 60e3, ip, now - 60e3).first();
      if (a && (a.bt >= PER_TOKEN_MIN || a.bi >= PER_IP_MIN)) return json({ error: 'slow down' }, 429, cors);
      await env.DB.prepare('INSERT INTO batches (token, ts, ip, enc, size, ver, body) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(token, now, ip, enc, u.length, (request.headers.get('X-Observer-Version') || '').slice(0, 40), body).run();
      return json({ ok: true }, 200, cors);
    }
    if (p === '/api/export' && request.method === 'GET') {
      if (!authed(request, env)) return json({ error: 'not found' }, 404);
      const after = +(url.searchParams.get('after') || 0), limit = Math.min(100, Math.max(1, +(url.searchParams.get('limit') || 50)));
      // the sizes first, then only the bodies that fit the page's byte budget
      const sizes = (await env.DB.prepare('SELECT id, size FROM batches WHERE id > ? ORDER BY id LIMIT ?').bind(after, limit).all()).results || []; if (!sizes.length) return json([]);
      let upto = sizes[0].id, sum = 0; for (const s of sizes) { if (sum && sum + s.size > EXPORT_BYTES) break; sum += s.size; upto = s.id; }
      const rows = (await env.DB.prepare('SELECT id, token, ts, enc, body FROM batches WHERE id > ? AND id <= ? ORDER BY id').bind(after, upto).all()).results || [];
      return json(rows.map(r => ({ id: r.id, token: r.token, ts: r.ts, enc: r.enc, body: b64(r.body) })));
    }
    if (p === '/api/ack' && request.method === 'POST') {
      if (!authed(request, env)) return json({ error: 'not found' }, 404);
      const b = await request.json().catch(() => ({})), upto = +b.upto; if (!(upto > 0)) return json({ error: 'bad upto' }, 400);
      const r = await env.DB.prepare('DELETE FROM batches WHERE id <= ?').bind(upto).run();
      return json({ ok: true, deleted: r.meta && r.meta.changes });
    }
    return json({ error: 'not found' }, 404);
  } catch (e) { return json({ error: 'server error' }, 500, p === '/api/upload' ? cors : undefined); }
}
