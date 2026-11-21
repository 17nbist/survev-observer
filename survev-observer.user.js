// ==UserScript==
// @name         survev observer
// @namespace    https://github.com/17nbist/survev-observer
// @version      1.1.0
// @description  Records what your survev.io game already shows you (where players are, where they aim, their shots) and sends it to the clip jury to help catch cheaters. It changes nothing in your game.
// @match        https://survev.io/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/17nbist/survev-observer/main/survev-observer.user.js
// @updateURL    https://raw.githubusercontent.com/17nbist/survev-observer/main/survev-observer.user.js
// ==/UserScript==

// What this does, in short:
//  1. Waits for the game to start, and keeps a reference to it (it does not change it).
//  2. Every time the game gets a world update from the server, it notes where every player your client can see is, where
//     they face, what they hold and wear, and the bullets in the air. Once a match it notes the map's shape (coast, rivers). Players are numbers only (the game's own ids), never names.
//  3. Every 10 seconds it zips those notes and sends them to https://survev-observer.pages.dev/api/upload.
// It sends nothing about you beyond what is in the game (no name, no account, no browser data). The badge in the bottom left
// corner shows that it is on and how much it sent; click it to pause or resume. See README.md for the full list.

(function () {
  'use strict';
  const ENDPOINT = window.__OBSERVER_ENDPOINT || 'https://survev-observer.pages.dev/api/upload';
  const VERSION = 'observer-1.1.0', FLUSH_MS = 10000, KEEP = 60000, MSG_KILL = 7;

  // ---------- 1. find the game ----------
  // The game's main object is passed through Function.prototype.call once while it boots. We look at each call until we see
  // it, keep it, and put Function.prototype.call back as it was. Nothing else in the page is touched.
  const origCall = Function.prototype.call;
  const isApp = v => { try { return v != null && typeof v === 'object' && 'audioManager' in v && 'pixi' in v && 'game' in v && 'inputBinds' in v; } catch (e) { return false; } };
  let app = null;
  Function.prototype.call = function (thisArg) {
    if (!app && isApp(thisArg)) { app = thisArg; Function.prototype.call = origCall; }
    return Reflect.apply(origCall, this, arguments);
  };
  setTimeout(() => { if (Function.prototype.call !== origCall) Function.prototype.call = origCall; }, 60000);

  // The shipped game renames most of its fields, so they are found by what they look like. Keys are remembered, never the
  // objects: the game builds new ones every match.
  const keys = o => { try { return Object.keys(o); } catch (e) { return []; } };
  const get = (o, k) => { try { return o[k]; } catch (e) { return undefined; } };
  const isVec = v => v && typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number';
  const isWorldPos = v => isVec(v) && Math.abs(v.x) > 5 && Math.abs(v.y) > 5 && Math.abs(v.x) < 5000 && Math.abs(v.y) < 5000;
  const isUnit = v => isVec(v) && Math.abs(Math.hypot(v.x, v.y) - 1) < 0.03;
  const findKey = (o, test) => keys(o).find(k => { const v = get(o, k); return v && test(v); }) || null;
  const protoKeys = o => { const out = []; for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) if (!out.includes(k)) out.push(k); return out; };
  const K = {};
  const pool = p => { if (!p) return []; if (K.pool && Array.isArray(p[K.pool])) return p[K.pool];
    for (const k of keys(p)) { const a = get(p, k); if (Array.isArray(a) && a.length && a[0] && a[0].__id != null) { K.pool = k; return a; } } return []; };
  const barn = g => { K.barn = K.barn && get(g, K.barn) && get(g, K.barn).playerPool ? K.barn : findKey(g, v => v.playerPool && typeof v.playerInfo === 'object'); return K.barn ? g[K.barn] : null; };
  const activePlayer = g => { const ok = v => typeof v === 'object' && v.__id != null && v.container && typeof v.active === 'boolean' && typeof v.layer === 'number';
    if (!K.me || !ok(get(g, K.me) || 0)) K.me = findKey(g, ok); return K.me ? g[K.me] : null; };
  const theMap = g => { if (!K.map) K.map = findKey(g, v => typeof v.mapName === 'string' || v.mapData); return K.map ? g[K.map] : null; };
  // a player's position and facing: the first of its four position-shaped fields (the raw server position; the others are
  // smoothed copies for drawing) and the first unit vector
  function playerKeys(p) {
    if (K.pos) return true; const ks = protoKeys(p), pos = ks.filter(k => !/sprite|container/i.test(k) && isWorldPos(get(p, k)));
    if (pos.length !== 4) return false; K.pos = pos[0]; K.dir = ks.filter(k => isUnit(get(p, k)))[0] || null; return true;
  }
  // a player's network state (gear, weapon, dead/downed): an object of 26 fields in a known order
  function net(p) {
    const ok = v => { if (!v || typeof v !== 'object' || Array.isArray(v)) return false; const ks = Object.keys(v); return ks.length === 26 && isVec(v[ks[0]]) && Array.isArray(v[ks[25]]) && typeof v[ks[24]] === 'string' && typeof v[ks[8]] === 'boolean'; };
    if (!K.net || !ok(get(p, K.net))) K.net = findKey(p, ok); const n = K.net && p[K.net]; if (!n) return {}; const k = Object.keys(n);
    return { outfit: n[k[2]], pack: n[k[3]], helmet: n[k[4]], chest: n[k[5]], weap: n[k[6]], dead: n[k[8]], downed: n[k[9]], anim: n[k[10]], action: n[k[12]], pan: n[k[14]], heal: n[k[15]], boost: n[k[16]], actItem: n[k[22]], scale: n[k[23]] };
  }
  const obstacles = g => { const m = theMap(g); if (!m) return []; if (!K.obst) K.obst = findKey(m, v => pool(v).some(o => o && typeof o.type === 'string' && isVec(o.pos))); return K.obst ? pool(m[K.obst]) : []; };
  const bullets = g => { if (!K.bul || !Array.isArray((get(g, K.bul) || {}).bullets)) K.bul = findKey(g, v => Array.isArray(v.bullets)); return K.bul ? g[K.bul].bullets : []; };
  // smoke: the barn with a numeric zIdx, an array and a pool (the renderer has zIdx and arrays too, but no pool)
  function smokes(g) {
    const ok = v => v && typeof v.zIdx === 'number' && K.pool && Object.values(v).some(Array.isArray) && Object.values(v).some(p => p && typeof p === 'object' && !Array.isArray(p) && Array.isArray(p[K.pool]));
    if (!K.smoke || !ok(get(g, K.smoke))) K.smoke = findKey(g, ok); const b = K.smoke && g[K.smoke]; if (!b) return [];
    for (const v of Object.values(b)) if (v && typeof v === 'object' && K.pool && Array.isArray(v[K.pool])) return v[K.pool]; return [];
  }

  // ---------- 2. the notes ----------
  // One JSON array per line, the same format the clip jury reads: M match start, m the map, u one world update (you and every
  // player in view), b a bullet, o an obstacle, K a kill, F/f smoke, I team ids, S who you watch after you die, D your death,
  // E match end, s names (weapons, gear, obstacle types) as numbers.
  const r2 = v => (typeof v === 'number' ? Math.round(v * 100) / 100 : 0), r4 = v => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : 0);
  const dir8 = d => (isVec(d) ? Math.round((Math.atan2(d.y, d.x) + Math.PI) / (2 * Math.PI) * 255) : 0);
  const sess = Math.random().toString(36).slice(2, 12);
  let buf = [], match = 0, inMatch = false, myId = 0, watching = 0, lastUpdate = 0, wasDead = false, game = null;
  const strings = new Map(), obsSeen = new Map(), bulSeen = new WeakMap(), smokeSeen = new Map(); let infoSig = '';
  const push = rec => { buf.push(rec); if (buf.length > KEEP) buf.splice(0, buf.length - KEEP); };
  const now = () => Math.round(performance.now());
  function str(s) { if (typeof s !== 'string' || !s) return 0; let i = strings.get(s); if (i === undefined) { i = strings.size + 1; strings.set(s, i); push(['s', i, s]); } return i; }

  function matchStart(g, me) {
    inMatch = true; match++; myId = me.__id; watching = 0; lastUpdate = 0; wasDead = false; infoSig = '';
    strings.clear(); obsSeen.clear(); smokeSeen.clear(); for (const k of ['barn', 'me', 'map', 'obst', 'bul', 'smoke', 'net']) K[k] = null;
    const m = theMap(g);
    push(['M', now(), { map: m && m.mapName || null, seed: m && m.seed || 0, w: m && m.width || 0, h: m && m.height || 0, host: location.hostname, myId, cfg: { who: 'contrib', v: VERSION } }]);
    const md = m && m.mapData;
    // the map's shape: coastline, grass edge, rivers (the game works them out from the seed), as flat x,y lists
    const tr = m && m.terrain, flat = a => (Array.isArray(a) ? a.flatMap(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]) : []);
    const terrain = tr ? { shore: flat(tr.shore), grass: flat(tr.grass), rivers: (tr.rivers || []).map(r => ({ looped: r.looped ? 1 : 0, water: flat(r.waterPoly), bank: flat(r.shorePoly) })) } : null;
    if (md && Array.isArray(md.objects)) push(['m', now(), md.objects.map(o => [str(o.type), r2(o.pos && o.pos.x), r2(o.pos && o.pos.y), o.ori | 0, r2(o.scale)]), (md.places || []).map(p => [str(p.name), r2(p.pos && p.pos.x), r2(p.pos && p.pos.y)]), terrain]);
    hookKills(g);
  }
  function matchEnd(why) { if (!inMatch) return; inMatch = false; push(['E', now(), why, 0, 0, null]); flush(); }

  // the kill feed: the server sends every kill to every client; the game reads it and only draws it. We read the same fields
  // first and put the reading position back, so the game reads them exactly as before.
  const hooked = new WeakSet(); let onMsgKey = null;
  function hookKills(g) {
    if (hooked.has(g)) return; hooked.add(g);
    try {
      if (!onMsgKey) { const pr = Object.getPrototypeOf(g); let best = 7;
        for (const k of Object.getOwnPropertyNames(pr)) { const d = Object.getOwnPropertyDescriptor(pr, k), f = d && d.value; if (typeof f !== 'function' || f.length !== 2) continue; const n = (String(f).match(/\.deserialize\(/g) || []).length; if (n > best) { best = n; onMsgKey = k; } } }
      const orig = onMsgKey && g[onMsgKey]; if (typeof orig !== 'function') return;
      g[onMsgKey] = function (type, s) {
        if (type === MSG_KILL && inMatch && s && typeof s.readBits === 'function') { const at = s.index;
          try { const dt = s.readUint8(), item = s.readBits(10), mp = s.readBits(12), tg = s.readUint16(), kl = s.readUint16(), cr = s.readUint16(); s.readUint8(); const dn = s.readBoolean(), kd = s.readBoolean();
            push(['K', now(), tg, kl, cr, dt, dn ? 1 : 0, kd ? 1 : 0, item, mp]); } catch (e) {}
          s.index = at; }
        return orig.call(this, type, s);
      };
    } catch (e) {}
  }

  function tick() {
    const g = app && app.game;
    if (!g || !g.initialized) { if (inMatch) matchEnd(wasDead ? 'dead' : 'left'); game = g; return; }
    const me = activePlayer(g), b = barn(g); if (!me || !b || !me.active || !playerKeys(me)) return;
    if (paused) return; // paused: nothing is noted and nothing is sent
    if (!inMatch || g !== game) { if (inMatch) matchEnd('left'); game = g; matchStart(g, me); }
    const lu = g.lastUpdateTime; if (typeof lu !== 'number' || lu === lastUpdate) return;
    const gap = lastUpdate ? lu - lastUpdate : 0; lastUpdate = lu; const t = now();
    if (me.__id !== watching && (me.__id !== myId || watching)) { watching = me.__id === myId ? 0 : me.__id; push(['S', t, watching]); }
    if (watching && !wasDead) { wasDead = true; push(['D', t, 0, 0]); } // the game shows someone else once you are dead
    // you (or the player you watch after you die), then everyone else in view
    const n = net(me), pos = me[K.pos] || { x: 0, y: 0 }, flags = (n.dead ? 1 : 0) | (n.downed ? 2 : 0) | (n.pan ? 8 : 0) | (n.heal ? 16 : 0) | (n.boost ? 32 : 0);
    if (me.__id === myId && n.dead && !wasDead) { wasDead = true; push(['D', t, 0, 0]); }
    const meRec = [r2(pos.x), r2(pos.y), dir8(K.dir && me[K.dir]), me.layer | 0, 0, 0, 0, str(n.weap), 0, 0, 0, 0, 0, 0, str(n.helmet), str(n.chest), str(n.pack), 0, 0, n.anim | 0, n.action | 0, str(n.actItem), flags, 0, 0];
    const info = b.playerInfo || {}, mine = info[myId] || {}, players = [];
    for (const p of pool(b.playerPool)) {
      if (!p || !p.active || p.__id === me.__id) continue; const pp = p[K.pos]; if (!isVec(pp)) continue; const q = net(p), pi = info[p.__id] || {};
      const mate = (mine.groupId > 0 && pi.groupId === mine.groupId) || (mine.teamId > 0 && pi.teamId === mine.teamId);
      players.push([p.__id, r2(pp.x), r2(pp.y), dir8(K.dir && p[K.dir]), p.layer | 0, str(q.weap), str(q.helmet), str(q.chest), str(q.pack),
        (q.dead ? 1 : 0) | (q.downed ? 2 : 0) | (mate ? 4 : 0) | (q.pan ? 8 : 0) | (q.heal ? 16 : 0) | (q.boost ? 32 : 0), q.anim | 0, q.action | 0, str(q.actItem), r2(typeof q.scale === 'number' ? q.scale : 1), str(q.outfit)]);
    }
    push(['u', t, Math.round(lu), 0, 0, Math.round(gap), meRec, players, null]);
    const ids = Object.keys(info), sig = ids.join(','); if (sig !== infoSig) { infoSig = sig; push(['I', t, ids.map(k => [+k, (info[k] || {}).teamId | 0, (info[k] || {}).groupId | 0])]); }
    // obstacles: once when first seen (with their shape), then only when they change (broken, door opened, damaged)
    for (const o of obstacles(g)) {
      if (!o || !o.active || !isVec(o.pos)) continue; const door = o.isDoor && o.door, hp = typeof o.healthT === 'number' ? Math.round(o.healthT * 20) : 20;
      const fl = (o.dead ? 1 : 0) | (door && door.open ? 2 : 0) | (door && door.locked ? 4 : 0) | (!o.dead && o.collidable !== false && !(typeof o.height === 'number' && o.height < 0.25) ? 16 : 0);
      const first = !obsSeen.has(o.__id), c = o.collider;
      const col = !(first || o.isDoor) || !c ? null : c.type === 0 && c.pos ? [0, r2(c.pos.x), r2(c.pos.y), r2(c.rad)] : c.type === 1 && c.min && c.max ? [1, r2(c.min.x), r2(c.min.y), r2(c.max.x), r2(c.max.y)] : null;
      const s2 = fl * 32 + hp + (o.isDoor ? '|' + col : '');
      if (obsSeen.get(o.__id) !== s2) { obsSeen.set(o.__id, s2); const rec = ['o', t, o.__id, str(o.type), r2(o.pos.x), r2(o.pos.y), o.layer | 0, fl, hp]; if (col) rec.push(col); push(rec); }
    }
    // bullets, once each
    for (const q of bullets(g)) {
      if (!q || !q.alive || !isVec(q.startPos) || !isVec(q.dir)) continue; const k = q.startPos.x + ',' + q.startPos.y;
      if (bulSeen.get(q) === k) continue; bulSeen.set(q, k);
      push(['b', t, q.playerId | 0, r2(q.startPos.x), r2(q.startPos.y), r4(q.dir.x), r4(q.dir.y), r2(q.speed), q.layer | 0, q.reflectCount | 0]);
    }
    // smoke clouds: seen, grown, gone
    const seen = new Set();
    for (const o of smokes(g)) { if (!o || !o.active) continue; let p = null; const nums = [];
      for (const k of Object.keys(o)) { if (k === '__id' || k === '__type' || k === 'active') continue; const v = o[k]; if (!p && isVec(v)) p = v; else if (typeof v === 'number') nums.push(v); }
      if (!p || nums.length < 2) continue; seen.add(o.__id); const prev = smokeSeen.get(o.__id);
      if (prev === undefined || Math.abs(nums[0] - prev) > 0.5) { smokeSeen.set(o.__id, nums[0]); push(['F', t, o.__id, r2(p.x), r2(p.y), r2(nums[0]), nums[1] | 0]); } }
    for (const id of smokeSeen.keys()) if (!seen.has(id)) { smokeSeen.delete(id); push(['f', t, id]); }
  }

  // ---------- 3. sending ----------
  // A random id for this browser (no account, nothing personal), so a batch's lines can be kept together.
  let token = null; try { token = localStorage.getItem('observer.token'); } catch (e) {}
  if (!token) { token = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16)).replace(/[^a-f0-9-]/g, '').slice(0, 40); try { localStorage.setItem('observer.token', token); } catch (e) {} }
  let paused = false, sentBytes = 0, sending = false, lastError = '';
  try { paused = localStorage.getItem('observer.paused') === '1'; } catch (e) {}
  async function zip(text) {
    if (typeof CompressionStream !== 'function') return { body: new TextEncoder().encode(text), enc: 'plain' };
    const s = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')); return { body: new Uint8Array(await new Response(s).arrayBuffer()), enc: 'gzip' };
  }
  async function flush() {
    if (sending || !buf.length || paused) return; sending = true;
    const lines = buf; buf = [];
    const text = JSON.stringify(['B', sess, VERSION, match, Math.round(Date.now() - performance.now())]) + '\n' + lines.map(r => JSON.stringify(r)).join('\n') + '\n';
    try {
      const z = await zip(text);
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Observer-Token': token, 'X-Observer-Encoding': z.enc, 'X-Observer-Version': VERSION }, body: z.body });
      if (res.ok) { sentBytes += z.body.length; lastError = ''; } else { lastError = 'server said ' + res.status; if (res.status >= 500 || res.status === 429) buf = lines.concat(buf).slice(-KEEP); }
    } catch (e) { lastError = 'offline'; buf = lines.concat(buf).slice(-KEEP); }
    sending = false; badge();
  }

  // ---------- the badge ----------
  let el = null;
  function badge() {
    if (!document.body) return;
    if (!el) { el = document.createElement('div'); el.title = 'survev observer: click to pause or resume';
      el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;font:11px system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:3px 7px;border-radius:3px;cursor:pointer;user-select:none';
      el.onclick = () => { paused = !paused; try { localStorage.setItem('observer.paused', paused ? '1' : '0'); } catch (e) {} buf = []; inMatch = false; badge(); }; // a resume starts the match notes afresh
      document.body.appendChild(el); }
    el.textContent = 'observer ' + (paused ? 'paused (click to resume)' : (inMatch ? 'recording' : 'on') + ' · ' + (sentBytes / 1024).toFixed(0) + ' KB sent' + (lastError ? ' · ' + lastError : ''));
  }

  function loop() { try { tick(); } catch (e) {} requestAnimationFrame(loop); }
  requestAnimationFrame(loop);
  setInterval(() => { flush(); badge(); }, FLUSH_MS);
  setInterval(badge, 2000);
})();
