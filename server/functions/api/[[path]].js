// survev observer's server (Cloudflare Pages Functions, D1 binding DB).
//   POST /api/upload   one batch from the userscript (gzip or plain text, at most 600 KB: the script sends at most 1500 lines a batch,
//                      about 200 KB zipped; 2 MB let one address store 120 MB a minute and 50 such rows broke the export). Rate limited per browser token and per
//                      address; the address itself is never stored, only a salted hash used for the limit.
//   GET  /api/export   (private: needs the EXPORT_KEY secret) batches after ?after=<id>, for the clip jury's puller: at most ?limit rows
//                      and about 4 MB of bodies a page (always one row at least), so a page fits the Worker's memory whatever was uploaded
//   POST /api/ack      (private) deletes batches up to {upto} once they are pulled
//   POST /api/wire?sess=&match=&seq=[&m=]   (1.8.0) one chunk of the copy of what the game's server sent a player's game (gzip, at most 1 MB; the
//                      first chunk, seq 0, carries the meta m). Kept in the wire table, rate limited per session and per address, at most 48 MB a match,
//                      rows older than 7 days are dropped (on a seq 0 and on the export). A chunk with seq 1 or more needs the stored seq 0 of its match (409), and every chunk is
//                      refused (403) once the table holds 300 MB; both are 4xx the observer does not retry, it drops that match. The delete route keeps a
//                      pulled seq 0 of the last day as an empty stub, so a match still being played is not cut by a pull. Never published; the names in it are the ones the game's server sends to everyone.
//   GET  /api/export/wire?after=<rowid>&limit=<n>   (private) chunks after a rowid, about 4 MB a page, data as base64
//   POST /api/export/wire/delete   (private) deletes chunks up to the rowid {upto} once they are pulled
const TOKEN = /^[a-f0-9-]{16,40}$/, MAX_BYTES = 600000, EXPORT_BYTES = 4000000, PER_TOKEN_MIN = 12, PER_IP_MIN = 60, ORIGIN = 'https://survev.io';
const SESS = /^[a-z0-9]{1,32}$/, WIRE_MAX = 1000000, WIRE_MATCH_MAX = 48000000, WIRE_TOTAL_MAX = 300000000, WIRE_STUB = 864e5, WIRE_PER_SESS_MIN = 30, WIRE_PER_IP_MIN = 120, WIRE_KEEP = 7 * 864e5, REV = /^[0-9a-f]{7,40}$/, HOST = /^[\w.-]{1,80}:\d{1,5}$/;
const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Observer-Token, X-Observer-Encoding, X-Observer-Version', 'Access-Control-Max-Age': '86400' };
const json = (o, status, extra) => new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extra || {}) });

async function ipHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '', day = new Date().toISOString().slice(0, 10);
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode((env.IP_SALT || 'survev-observer') + '|' + day + '|' + ip));
  return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}
const b64 = buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const nnum = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
// the meta of a capture, or null when it is not in shape; only these fields are kept, so the pull can trust them
function wireMeta(text) {
  let m; try { m = JSON.parse(text); } catch (e) { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m) || !nnum(m.openEpochMs, 1e12, 4e12) || !nnum(m.firstFrameEpochMs, 1e12, 4e12) || !nnum(m.perfT0, 0, 1e10) || typeof m.url !== 'string' || !HOST.test(m.url) || typeof m.v !== 'string' || m.v.length > 40) return null;
  if (m.gitRevision != null && !(typeof m.gitRevision === 'string' && REV.test(m.gitRevision))) return null;
  return JSON.stringify({ openEpochMs: m.openEpochMs, firstFrameEpochMs: m.firstFrameEpochMs, perfT0: m.perfT0, url: m.url, gitRevision: m.gitRevision || null, v: m.v });
}
const authed = (request, env) => !!env.EXPORT_KEY && request.headers.get('X-Export-Key') === env.EXPORT_KEY;

async function wirePurge(env, now) { await env.DB.prepare('DELETE FROM wire WHERE at < ?').bind(now - WIRE_KEEP).run(); }
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
    if (p === '/api/wire') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
      const q = url.searchParams, sess = q.get('sess') || '', match = +q.get('match'), seq = +q.get('seq');
      if (!SESS.test(sess) || !Number.isInteger(match) || match < 1 || match > 99999 || !Number.isInteger(seq) || seq < 0 || seq > 30000) return json({ error: 'bad chunk' }, 400, cors);
      let meta = null; if (seq === 0) { const m = q.get('m') || ''; meta = m.length <= 1500 ? wireMeta(m) : null; if (!meta) return json({ error: 'bad meta' }, 400, cors); }
      const body = await request.arrayBuffer(), u = new Uint8Array(body);
      if (!u.length || u.length > WIRE_MAX) return json({ error: 'bad size' }, 413, cors);
      if (!(u[0] === 0x1f && u[1] === 0x8b)) return json({ error: 'not gzip' }, 400, cors);
      const now = Date.now(), ip = await ipHash(request, env);
      const a = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM wire WHERE sess = ? AND at > ?) AS bs, (SELECT COUNT(*) FROM wire WHERE iph = ? AND at > ?) AS bi, (SELECT COALESCE(SUM(size), 0) FROM wire WHERE sess = ? AND match = ?) AS bm, (SELECT COALESCE(SUM(size), 0) FROM wire) AS bt, (SELECT COUNT(*) FROM wire WHERE sess = ? AND match = ? AND seq = 0) AS z').bind(sess, now - 60e3, ip, now - 60e3, sess, match, sess, match).first();
      if (a && (a.bs >= WIRE_PER_SESS_MIN || a.bi >= WIRE_PER_IP_MIN)) return json({ error: 'slow down' }, 429, cors);
      if (a && a.bm + u.length > WIRE_MATCH_MAX) return json({ error: 'match full' }, 413, cors);
      if (a && seq >= 1 && !a.z) return json({ error: 'no first chunk' }, 409, cors); // 4xx the observer does not retry: it drops the match
      if (a && a.bt + u.length > WIRE_TOTAL_MAX) return json({ error: 'store full' }, 403, cors); // also a 4xx the observer drops on (5xx and 429 are retried)
      if (seq === 0) await wirePurge(env, now);
      await env.DB.prepare('INSERT OR IGNORE INTO wire (sess, match, seq, meta, data, size, at, iph) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(sess, match, seq, meta, body, u.length, now, ip).run(); // a chunk sent twice (a lost answer) is stored once
      return json({ ok: true }, 200, cors);
    }
    if (p === '/api/export/wire' && request.method === 'GET') {
      if (!authed(request, env)) return json({ error: 'not found' }, 404);
      await wirePurge(env, Date.now());
      const after = +(url.searchParams.get('after') || 0), limit = Math.min(100, Math.max(1, +(url.searchParams.get('limit') || 50)));
      const sizes = (await env.DB.prepare('SELECT rowid AS id, size FROM wire WHERE rowid > ? ORDER BY rowid LIMIT ?').bind(after, limit).all()).results || []; if (!sizes.length) return json([]);
      let upto = sizes[0].id, sum = 0; for (const s of sizes) { if (sum && sum + s.size > EXPORT_BYTES) break; sum += s.size; upto = s.id; }
      const rows = (await env.DB.prepare('SELECT rowid AS id, sess, match, seq, meta, at, data FROM wire WHERE rowid > ? AND rowid <= ? ORDER BY rowid').bind(after, upto).all()).results || [];
      return json(rows.map(r => ({ id: r.id, sess: r.sess, match: r.match, seq: r.seq, meta: r.meta, at: r.at, data: b64(r.data) })));
    }
    if (p === '/api/export/wire/delete' && request.method === 'POST') {
      if (!authed(request, env)) return json({ error: 'not found' }, 404);
      const b = await request.json().catch(() => ({})), upto = +b.upto; if (!(upto > 0)) return json({ error: 'bad upto' }, 400);
      // a first chunk of the last day stays as an empty stub (its meta): the chunks of a match still being played need it to be taken
      const keep = Date.now() - WIRE_STUB, r = await env.DB.prepare('DELETE FROM wire WHERE rowid <= ? AND NOT (seq = 0 AND at > ?)').bind(upto, keep).run();
      await env.DB.prepare("UPDATE wire SET data = x'', size = 0 WHERE rowid <= ? AND seq = 0 AND at > ? AND size > 0").bind(upto, keep).run();
      return json({ ok: true, deleted: r.meta && r.meta.changes });
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
  } catch (e) { return json({ error: 'server error' }, 500, p === '/api/upload' || p === '/api/wire' ? cors : undefined); }
}
