// ==UserScript==
// @name         survev observer
// @namespace    https://github.com/17nbist/survev-observer
// @version      1.4.2
// @description  Records what your survev.io game already shows you (where players are, where they aim, their shots) and sends it to the clip jury to help catch cheaters, and replays your death through the game itself. It changes nothing in your game.
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
//  4. It keeps a copy of what the server sends your game during the match (the game's socket, about 3 KB a second), in this tab
//     only: it is never uploaded. When you die, a "Death replay" button opens survev.io in a new tab, where the game's own client
//     plays that copy back: your death drawn by the game itself, exactly as you saw it (the killcam, part 0 below). Without a copy
//     (the observer started after the match did) the button opens the clip jury's map replay instead, handing it this match's notes
//     and the players' names directly: they go to that page in your browser and nowhere else; they are never in what is uploaded.
//  5. Only if you are signed in to a survev.io account: once a match is over it asks survev.io for your own match history (the list on
//     your stats page) and finds that match's game id, and sends that id. A report to the game's moderators needs it. Your account's
//     name is used for that one question to survev.io and is never sent to us; but the game id points at the game's public stats page,
//     where every player's name is, yours too. Not signed in: this step never runs.
// It sends nothing else about you beyond what is in the game (no name, no account, no browser data). The badge in the bottom left
// corner shows that it is on and how much it sent; click it to pause or resume. See README.md for the full list.

(function () {
  'use strict';
  const ENDPOINT = window.__OBSERVER_ENDPOINT || 'https://survev-observer.pages.dev/api/upload';
  const REPLAY = 'https://clip-jury.pages.dev', REPLAY_MS = 60000; // the death replay page, and how much of the match it can show
  const VERSION = 'observer-1.4.2', FLUSH_MS = 10000, KEEP = 60000, BATCH = 1500, MSG_KILL = 7, MSG_UPDATE = 6; // BATCH: lines in one upload at most (the server takes 600 KB)

  // ---------- 0. a copy of the game's socket, and the killcam ----------
  // The approach of "Surviv.io input replay recorder" (greasyfork.org/scripts/447501, MIT, by garlic, samer kizi and preacher):
  // the page's WebSocket becomes a subclass that keeps every binary message the server sends to the game's socket (/play), with
  // its time. It changes, delays and sends nothing: the game gets each message exactly as before, and the copy never leaves this
  // tab. The Death replay button hands it to a killcam tab (killcam() below), where the game's own client plays it back.
  const NativeWS = typeof window.WebSocket === 'function' ? window.WebSocket : null, KC_URL = 'wss://vb-killcam.invalid/play', KC_BEFORE = 20000, KC_AFTER = 2000, WIRE_MAX = 64e6;
  // a killcam tab is known by its link alone: ?u= is the stand-in address (never a #hash, which the game reads as a team to join)
  const KILLCAM = (() => { try { const u = new URLSearchParams(location.search).get('u'); return !!u && atob(u) === KC_URL; } catch (e) { return false; } })();
  let wire = null; // the game socket of this match: {url, openEpoch, t0, frames: [[performance.now(), ArrayBuffer]], bytes}
  if (!KILLCAM && NativeWS) {
    try {
      class ObserverWS extends NativeWS {
        constructor(url, protocols) {
          if (protocols === undefined) super(url); else super(url, protocols);
          try {
            if (/\/play(?:[?#]|$)/.test(String(url))) {
              const rec = wire = { url: String(url), openEpoch: Date.now(), t0: performance.now(), frames: [], bytes: 0 };
              this.addEventListener('message', e => { const d = e.data; if (d instanceof ArrayBuffer && rec.bytes < WIRE_MAX) { rec.frames.push([performance.now(), d]); rec.bytes += d.byteLength; } });
            }
          } catch (e) {}
        }
      }
      window.WebSocket = ObserverWS;
    } catch (e) {}
  }

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

  if (KILLCAM) { killcam(); return; } // a killcam tab only plays a replay: nothing below (notes, uploads, the badge) runs in it

  // ---------- 0b. the killcam tab ----------
  // The Death replay button opens survev.io/?u=<the stand-in address>&jt=vb. The game's own client starts there as it
  // always does and joins the address in the link (main.ts tryJoinGameFromParam: no matchmaking request is made), which is the
  // stand-in below: it hands the client what the server sent your game in that match, in order. Everything before the last 20 s
  // goes at once behind a cover (each world update builds on the ones before, so none can be left out), the 3 s before them at 4x so
  // the effects of the fast part die out, then the rest on its own clock. The client draws it as it did live: your view, your HUD,
  // the doors, the kill feed. Nothing goes to any server from this tab: what the client sends is dropped, the stand-in address
  // (.invalid) can never connect anywhere, a real game cannot be joined here, and no notes are kept or sent.
  function killcam() {
    const KC = { sock: null, data: null, started: false, bursting: false, ready: false, rec: null, playing: true, speed: 1, user: 1, vt: 0, base: 0, i: 0, from: 0, to: 0, done: false, ui: null };
    // the game's settings are read here, never written; your facing comes from the recording, not this tab's mouse (local rotation off)
    try { const SPr = Storage.prototype, gi = SPr.getItem, si = SPr.setItem;
      SPr.getItem = function (k) { const v = gi.call(this, k); if (k !== 'surviv_config' || this !== window.localStorage) return v; try { const c = JSON.parse(v || '{}'); c.localRotation = false; return JSON.stringify(c); } catch (e) { return v; } };
      SPr.setItem = function (k, v) { if (k === 'surviv_config' && this === window.localStorage) return; return si.call(this, k, v); }; } catch (e) {}
    // the page's frame clock runs at the replay's speed and stops while paused, so the game's own motion slows and stops with it
    // (the greasyfork recorder's slow motion)
    const raf = window.requestAnimationFrame.bind(window); let rl = null, rv = 0;
    window.requestAnimationFrame = cb => raf(ts => { if (rl === null) { rl = ts; rv = ts; } rv += (ts - rl) * (KC.started && !KC.bursting ? (KC.playing ? KC.speed : 0) : 1); rl = ts; return cb(rv); });
    function WS(url, protocols) {
      if (String(url) !== KC_URL) { if (/\/play(?:[?#]|$)/.test(String(url))) throw new Error('a killcam tab joins no real game'); return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols); }
      this.url = KC_URL; this.readyState = 0; this.binaryType = 'blob'; this.bufferedAmount = 0; this.protocol = ''; this.extensions = '';
      this.onopen = this.onmessage = this.onclose = this.onerror = null; KC.sock = this; setTimeout(start, 0);
    }
    WS.prototype.send = function () {}; // the game's join and inputs go nowhere
    WS.prototype.close = function () { this.readyState = 3; };
    WS.prototype.addEventListener = WS.prototype.removeEventListener = function () {};
    WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
    if (NativeWS) window.WebSocket = WS;
    // the copy comes from the tab that opened this one (same site only), asked for until it arrives
    window.addEventListener('message', ev => { const d = ev.data; if (ev.origin !== location.origin || !window.opener || ev.source !== window.opener || !d || d.vbKillcam !== 1 || KC.data || !Array.isArray(d.frames)) return; KC.data = d; start(); });
    const ask = () => { try { if (window.opener && !KC.data) window.opener.postMessage({ vbKillcamReady: 1 }, location.origin); } catch (e) {} };
    ask(); const askT = setInterval(() => { if (KC.data) clearInterval(askT); else ask(); }, 1000); setTimeout(() => { clearInterval(askT); if (!KC.data) bar('no replay arrived: open it from the Death replay button'); }, 30000);
    function start() {
      if (KC.started || !KC.sock || !KC.data) return; KC.started = true;
      const s = KC.sock, D = KC.data, F = D.frames, last = F.length ? F[F.length - 1][0] : 0, first = F.length ? F[0][0] : 0;
      KC.from = Math.min(last, Math.max(first, +D.from || first)); KC.to = Math.max(KC.from, Math.min(last, D.to == null ? last : +D.to)); const pre = Math.max(first, KC.from - 3000);
      s.readyState = 1; try { s.onopen && s.onopen({ type: 'open' }); } catch (e) {}
      const am = app && app.audioManager, wasMute = !!(am && am.mute), mute = m => { try { if (am && typeof am.setMute === 'function') am.setMute(m || wasMute); } catch (e) {} };
      const give = ab => { if (s.readyState === 1 && s.onmessage) try { s.onmessage({ data: ab, type: 'message' }); } catch (e) {} };
      KC.bursting = true; mute(true); bar();
      const burst = () => { const stop = performance.now() + 30; while (KC.i < F.length && F[KC.i][0] < pre && performance.now() < stop) give(F[KC.i++][1]); bar();
        if (KC.i < F.length && F[KC.i][0] < pre) { setTimeout(burst, 0); return; }
        KC.bursting = false; KC.speed = 4; KC.vt = pre; KC.base = performance.now(); pump(); };
      const pump = () => { const now = performance.now(); if (KC.playing) KC.vt += (now - KC.base) * KC.speed; KC.base = now;
        if (KC.speed === 4 && KC.vt >= KC.from) { KC.vt = KC.from; KC.speed = KC.user; mute(false); KC.playing = false; KC.ready = true; } // the last 20 s: unmuted, uncovered, at the chosen speed, once Play or Save video is pressed
        if (KC.vt > KC.to) KC.vt = KC.to;
        while (KC.i < F.length && F[KC.i][0] <= KC.vt) give(F[KC.i++][1]);
        KC.done = KC.vt >= KC.to; bar(); if (!KC.done) setTimeout(pump, 8); else if (KC.rec) setTimeout(stopRec, 1000); };
      setTimeout(burst, 50);
    }
    // the bar: where in the replay, pause, speed, from the start again; a cover over the game while it catches up; at the start, Play or
    // Save video
    function bar(note) {
      if (!document.body) return; const D = KC.data;
      if (!KC.ui) { const u = KC.ui = {}; u.cover = document.createElement('div'); u.cover.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#0d1117;color:#fff;display:flex;align-items:center;justify-content:center;font:700 22px system-ui,sans-serif';
        u.box = document.createElement('div'); u.box.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:6px;align-items:center;background:rgba(0,0,0,.72);color:#fff;font:700 14px system-ui,sans-serif;padding:6px 10px;border-radius:6px;user-select:none';
        const btn = (t, f, box, big) => { const b = document.createElement('button'); b.textContent = t; b.style.cssText = 'font:700 ' + (big ? '20px' : '13px') + ' system-ui,sans-serif;color:#fff;background:' + (big ? '#d9512c' : '#3a3f47') + ';border:0;border-radius:' + (big ? '8px' : '4px') + ';padding:' + (big ? '14px 28px' : '4px 9px') + ';cursor:pointer'; b.onclick = e => { e.preventDefault(); e.stopPropagation(); f(b); }; (box || u.box).appendChild(b); return b; };
        u.title = document.createElement('span'); u.title.textContent = 'KILLCAM'; u.title.style.color = '#ff8a65'; u.box.appendChild(u.title);
        u.play = btn('Pause', () => { if (!KC.ready || KC.done) return; if (!KC.went) { go(false); return; } KC.playing = !KC.playing; KC.base = performance.now(); bar(); });
        u.sp = [0.25, 0.5, 1, 2].map(x => btn(x + 'x', () => { KC.user = x; if (KC.speed !== 4) KC.speed = x; KC.base = performance.now(); bar(); }));
        btn('Restart', () => location.reload());
        u.time = document.createElement('span'); u.time.style.cssText = 'min-width:84px;text-align:right;font-variant-numeric:tabular-nums'; u.box.appendChild(u.time);
        u.start = document.createElement('div'); u.start.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;display:none;flex-direction:column;gap:12px;align-items:center;background:rgba(0,0,0,.78);color:#fff;font:600 14px system-ui,sans-serif;padding:22px 28px;border-radius:10px;text-align:center';
        btn('\u25B6 Play', () => go(false), u.start, true); btn('\u25CF Save video', () => go(true), u.start, true);
        u.msg = document.createElement('div'); u.msg.style.cssText = 'max-width:320px;color:#ccc'; u.msg.textContent = 'Save video asks to record this tab, plays the replay with sound and downloads it as a video file.'; u.start.appendChild(u.msg);
        document.body.appendChild(u.cover); document.body.appendChild(u.box); document.body.appendChild(u.start); }
      const u = KC.ui, catching = !KC.started || KC.bursting || KC.speed === 4;
      u.cover.style.display = catching ? 'flex' : 'none';
      u.cover.textContent = note || (!D ? 'waiting for the replay...' : 'loading your death replay... ' + Math.round(100 * KC.i / Math.max(1, D.frames.length)) + '%');
      u.start.style.display = KC.ready && !KC.playing && !KC.went ? 'flex' : 'none';
      u.box.style.display = KC.rec ? 'none' : 'flex'; // not in the video
      u.play.textContent = KC.done ? 'Done' : KC.playing || !KC.went ? 'Pause' : 'Play';
      u.sp.forEach((b, k) => { b.style.background = [0.25, 0.5, 1, 2][k] === KC.user ? '#d9512c' : '#3a3f47'; });
      if (D && D.death != null) { const r = (KC.vt - D.death) / 1000; u.time.textContent = (r < 0 ? '-' : '+') + Math.abs(r).toFixed(1) + ' s'; }
    }
    // Play, or Save video: the browser asks which tab to record (this one is offered first); the replay then plays with the bar hidden
    // and the file downloads at its end (mp4 where the browser can make one, else webm). Stopping the share early saves what was recorded.
    async function go(rec) {
      if (!KC.ready || KC.went) return;
      if (rec) {
        let s; try { s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60, cursor: 'never' }, audio: true, preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'include' }); }
        catch (e) { KC.ui.msg.textContent = 'No video: ' + (e && e.name === 'NotAllowedError' ? 'recording was not allowed.' : 'this browser cannot record a tab.') + ' Play still works.'; return; }
        const type = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find(x => window.MediaRecorder && MediaRecorder.isTypeSupported(x));
        let mr; try { mr = new MediaRecorder(s, type ? { mimeType: type, videoBitsPerSecond: 8e6 } : undefined); } catch (e) { s.getTracks().forEach(x => x.stop()); KC.ui.msg.textContent = 'No video: this browser cannot record. Play still works.'; return; }
        const parts = []; KC.rec = { mr, s, type: mr.mimeType || type || 'video/webm' }; mr.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
        mr.onstop = () => { const ty = KC.rec ? KC.rec.type : 'video/webm', a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(parts, { type: ty }));
          a.download = 'survev-death-replay-' + new Date(D0()).toISOString().slice(0, 19).replace(/[T:]/g, '-') + (/mp4/.test(ty) ? '.mp4' : '.webm'); document.body.appendChild(a); a.click(); a.remove();
          s.getTracks().forEach(x => x.stop()); KC.rec = null; bar(); };
        s.getVideoTracks().forEach(x => { x.onended = stopRec; }); mr.start(1000);
        KC.went = true; bar(); await new Promise(r => setTimeout(r, 400)); // the recording has its first frames before the replay moves
      }
      KC.went = true; KC.playing = true; KC.base = performance.now(); bar();
    }
    const D0 = () => { const D = KC.data; return D && D.openEpoch ? D.openEpoch + (D.death || 0) - (D.frames.length ? D.frames[0][0] : 0) : Date.now(); };
    function stopRec() { const r = KC.rec; if (r && r.mr.state !== 'inactive') try { r.mr.stop(); } catch (e) {} }
    window.__killcamGo = go; // tools/test-observer-killcam.js presses Play
    const tick = () => { if (document.body) bar(); else setTimeout(tick, 50); }; tick();
    window.__killcam = KC; // tools/test-observer-killcam.js reads where the replay is
  }

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
    return { pos: n[k[0]], dir: n[k[1]], role: n[k[24]], perks: n[k[25]], outfit: n[k[2]], pack: n[k[3]], helmet: n[k[4]], chest: n[k[5]], weap: n[k[6]], dead: n[k[8]], downed: n[k[9]], anim: n[k[10]], action: n[k[12]], pan: n[k[14]], heal: n[k[15]], boost: n[k[16]], actItem: n[k[22]], scale: n[k[23]] };
  }
  // your own view: the server sends each client a small block about the player it shows (8 fields in a known order: health, view
  // distance, boost, scope, ...). Two are read, the view distance and the scope's name, so a replay shows what was on your screen.
  // (1.4.2: also its health, boost, slot, inventory and weapons, for the replay's HUD)
  function local(p) {
    const ok = v => { if (!v || typeof v !== 'object' || Array.isArray(v)) return false; const k = Object.keys(v);
      return k.length === 8 && typeof v[k[0]] === 'number' && typeof v[k[1]] === 'number' && typeof v[k[2]] === 'number' && typeof v[k[3]] === 'string' && typeof v[k[4]] === 'number' && !!v[k[5]] && typeof v[k[5]] === 'object' && !Array.isArray(v[k[5]]) && Array.isArray(v[k[6]]) && typeof v[k[7]] === 'number'; };
    if (!K.loc || !ok(get(p, K.loc))) K.loc = findKey(p, ok); const d = K.loc && p[K.loc]; if (!d) return { zoom: 0, scope: '', weaps: [] }; const k = Object.keys(d);
    return { zoom: d[k[1]] > 0 && d[k[1]] < 500 ? d[k[1]] : 0, scope: /^\d+xscope$/.test(d[k[3]]) ? d[k[3]] : '', hp: d[k[0]], boost: d[k[2]], cur: d[k[4]], inv: d[k[5]], weaps: d[k[6]] };
  }
  // loot, grenades in flight, airdrops, planes and the zone: their classes keep plain field names (client loot.ts, projectile.ts, airdrop.ts,
  // plane.ts, gas.ts); only the game's key for each is renamed, so each is found by what it holds
  const holder = (g, kk, test) => { if (!K[kk] || !test(get(g, K[kk]) || 0)) K[kk] = findKey(g, test); return K[kk] ? g[K[kk]] : null; };
  const lootPool = g => { const b = holder(g, 'loot', v => !!v.lootPool); return b ? pool(b.lootPool) : []; };
  const projPool = g => { const b = holder(g, 'proj', v => !!v.projectilePool); return b ? pool(b.projectilePool) : []; };
  const airPool = g => { const b = holder(g, 'air', v => !!v.airdropPool); return b ? pool(b.airdropPool) : []; };
  const planeList = g => { const b = holder(g, 'plane', v => Array.isArray(v.planes)); return b ? b.planes : []; };
  const gasOf = g => holder(g, 'gas', v => typeof v.mode === 'number' && v.circleOld && v.circleNew && typeof v.duration === 'number');
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
  // player in view), b a bullet, o an obstacle, K a kill, F/f smoke, X an explosion, e an emote, n a map ping, I team ids, S who you
  // watch after you die, D your death,
  // E match end, s names (weapons, gear, obstacle types) as numbers, G the game's id (part 4, signed-in players only).
  const r2 = v => (typeof v === 'number' ? Math.round(v * 100) / 100 : 0), r4 = v => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : 0);
  const dir8 = d => (isVec(d) ? Math.round((Math.atan2(d.y, d.x) + Math.PI) / (2 * Math.PI) * 255) : 0);
  const sess = Math.random().toString(36).slice(2, 12);
  let nU = 0, buf = [], match = 0, inMatch = false, startT = 0, myId = 0, watching = 0, lastUpdate = 0, wasDead = false, game = null;
  const lootSeen = new Map(), projSeen = new Map(), airSeen = new Set(), planeSeen = new Map(), perkSeen = new Map(); let gasSig = '', invSig = '';
  const strings = new Map(), obsSeen = new Map(), bulSeen = new WeakMap(), smokeSeen = new Map(); let infoSig = '';
  // rp: the current match's notes for the death replay. Everything that describes the match (map, names of things, obstacles, kills,
  // smoke) is kept; moment-to-moment notes (updates, bullets, explosions, emotes, pings) only for the last minute
  // rpSnap: rp as it was 2 s after you died. The button hands that over, so the replay is whole however long you go on watching others
  let rp = [], rpPruned = 0, rpSnap = null, wireSnap = null, diedAt = 0; const names = {}; const RP_KEEP = new Set(['M', 's', 'm', 'o', 'K', 'I', 'S', 'D', 'F', 'f', 'E']);
  function prune(t) { if (t - rpPruned < 5000) return; rpPruned = t; rp = rp.filter(r => RP_KEEP.has(r[0]) || r[1] >= t - REPLAY_MS); }
  const push = rec => { buf.push([match, rec]); if (buf.length > KEEP) buf.splice(0, buf.length - KEEP); rp.push(rec); }; // buf: [match number, note], so a batch never mixes two matches
  const now = () => Math.round(performance.now());
  function str(s) { if (typeof s !== 'string' || !s) return 0; let i = strings.get(s); if (i === undefined) { i = strings.size + 1; strings.set(s, i); push(['s', i, s]); } return i; }

  function matchStart(g, me) {
    inMatch = true; match++; startT = now(); myId = me.__id; watching = 0; lastUpdate = 0; wasDead = false; infoSig = ''; rp = []; rpPruned = 0; rpSnap = null; wireSnap = null; diedAt = 0; died = false; for (const k in names) delete names[k]; replayBtn();
    strings.clear(); obsSeen.clear(); smokeSeen.clear(); for (const k of ['barn', 'me', 'map', 'obst', 'bul', 'smoke', 'net', 'loc', 'loot', 'proj', 'air', 'plane', 'gas']) K[k] = null; lootSeen.clear(); projSeen.clear(); airSeen.clear(); planeSeen.clear(); perkSeen.clear(); gasSig = ''; invSig = '';
    const m = theMap(g);
    push(['M', now(), { map: m && m.mapName || null, seed: m && m.seed || 0, w: m && m.width || 0, h: m && m.height || 0, host: location.hostname, myId, cfg: { who: 'contrib', v: VERSION } }]);
    const md = m && m.mapData;
    // the map's shape: coastline, grass edge, rivers (the game works them out from the seed), as flat x,y lists
    const tr = m && m.terrain, flat = a => (Array.isArray(a) ? a.flatMap(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]) : []);
    const terrain = tr ? { shore: flat(tr.shore), grass: flat(tr.grass), rivers: (tr.rivers || []).map(r => ({ looped: r.looped ? 1 : 0, water: flat(r.waterPoly), bank: flat(r.shorePoly) })) } : null;
    if (md && Array.isArray(md.objects)) push(['m', now(), md.objects.map(o => [str(o.type), r2(o.pos && o.pos.x), r2(o.pos && o.pos.y), o.ori | 0, r2(o.scale)]), (md.places || []).map(p => [str(p.name), r2(p.pos && p.pos.x), r2(p.pos && p.pos.y)]), terrain]);
    hookKills(g);
  }
  function matchEnd(why) { if (!inMatch) return; inMatch = false; const t = now(); push(['E', t, why, 0, 0, null]); gameNote(t); flush(); }

  // the kill feed: the server sends every kill to every client; the game reads it and only draws it. We read the same fields
  // first and put the reading position back, so the game reads them exactly as before.
  const hooked = new WeakSet(); let onMsgKey = null, onMsgOn = false, updSeq = 0, doneSeq = 0; // updSeq: world updates the game applied (counted, not timed: a burst brings several in one millisecond)
  function hookKills(g) {
    if (hooked.has(g)) return; hooked.add(g);
    try {
      if (!onMsgKey) { const pr = Object.getPrototypeOf(g); let best = 7;
        for (const k of Object.getOwnPropertyNames(pr)) { const d = Object.getOwnPropertyDescriptor(pr, k), f = d && d.value; if (typeof f !== 'function' || f.length !== 2) continue; const n = (String(f).match(/\.deserialize\(/g) || []).length; if (n > best) { best = n; onMsgKey = k; } } }
      const orig = onMsgKey && g[onMsgKey]; if (typeof orig !== 'function') return;
      onMsgOn = true; g[onMsgKey] = function (type, s) {
        if (type === MSG_KILL && inMatch && s && typeof s.readBits === 'function') { const at = s.index;
          try { const dt = s.readUint8(), item = s.readBits(10), mp = s.readBits(12), tg = s.readUint16(), kl = s.readUint16(), cr = s.readUint16(); s.readUint8(); const dn = s.readBoolean(), kd = s.readBoolean();
            push(['K', now(), tg, kl, cr, dt, dn ? 1 : 0, kd ? 1 : 0, item, mp]); } catch (e) {}
          s.index = at; }
        const out = orig.call(this, type, s);
        // each world update is noted as soon as the game has applied it, not at the next drawn frame: a slow machine draws fewer frames
        // than the server sends updates, and a hidden tab draws none, while the game still applies every one
        if (type === MSG_UPDATE) { updSeq++; try { tick(); } catch (e) {} }
        return out;
      };
    } catch (e) {}
  }

  // explosions, emotes and map pings: the game's explosion and emote objects keep their method names; each call is noted, then passed
  // on unchanged (the game draws them exactly as before)
  const fxHooked = new WeakSet();
  function hookFx(g) {
    for (const k of keys(g)) { const v = get(g, k); if (!v || typeof v !== 'object' || fxHooked.has(v)) continue;
      if (Array.isArray(v.explosions) && typeof v.addExplosion === 'function') { fxHooked.add(v); const o = v.addExplosion;
        v.addExplosion = function (type, pos, layer) { try { if (inMatch && pos) push(['X', now(), str(type), r2(pos.x), r2(pos.y), layer | 0]); } catch (e) {} return o.apply(this, arguments); }; }
      else if (Array.isArray(v.emotes) && typeof v.addEmote === 'function') { fxHooked.add(v); const oe = v.addEmote, op = v.addPing;
        v.addEmote = function (em) { try { if (inMatch && em) push(['e', now(), em.playerId | 0, str(em.type)]); } catch (e) {} return oe.apply(this, arguments); };
        if (typeof op === 'function') v.addPing = function (pg) { try { if (inMatch && pg && pg.pos) push(['n', now(), str(pg.type), r2(pg.pos.x), r2(pg.pos.y), pg.playerId | 0]); } catch (e) {} return op.apply(this, arguments); }; } }
  }

  function tick() {
    const g = app && app.game; if (g) hookKills(g);
    if (!g || !g.initialized) { if (inMatch) matchEnd(wasDead ? 'dead' : 'left'); game = g; return; }
    const me = activePlayer(g), b = barn(g); if (!me || !b || !me.active) return; if (!playerKeys(me) && !isVec(net(me).pos)) return; // the drawn positions stay 0 until a frame is drawn; the server's are there at once
    if (paused) return; // paused: nothing is noted and nothing is sent
    if (!inMatch || g !== game) { if (inMatch) matchEnd('left'); game = g; matchStart(g, me); }
    const lu = g.lastUpdateTime; if (typeof lu !== 'number' || (onMsgOn ? updSeq === doneSeq : lu === lastUpdate)) return; doneSeq = updSeq;
    const gap = lastUpdate ? lu - lastUpdate : 0; lastUpdate = lu; const t = now(); hookFx(g);
    if (me.__id !== watching && (me.__id !== myId || watching)) { watching = me.__id === myId ? 0 : me.__id; push(['S', t, watching]); }
    if (watching && !wasDead) { wasDead = true; push(['D', t, 0, 0]); died = true; diedAt = t; replayBtn(); } // the game shows someone else once you are dead
    // you (or the player you watch after you die), then everyone else in view
    const n = net(me), pos = isVec(n.pos) ? n.pos : me[K.pos] || { x: 0, y: 0 }, flags = (n.dead ? 1 : 0) | (n.downed ? 2 : 0) | (n.pan ? 8 : 0) | (n.heal ? 16 : 0) | (n.boost ? 32 : 0);
    if (me.__id === myId && n.dead && !wasDead) { wasDead = true; push(['D', t, 0, 0]); died = true; diedAt = t; replayBtn(); }
    const ld = local(me), W = Array.isArray(ld.weaps) ? ld.weaps : [], ws = i => str(W[i] && W[i].type), wa = i => (W[i] && W[i].ammo) | 0, haveW = W.length >= 4 && typeof ld.cur === 'number';
    const meRec = [r2(pos.x), r2(pos.y), dir8(isVec(n.dir) ? n.dir : K.dir && me[K.dir]), me.layer | 0, r2(ld.hp), r2(ld.boost), haveW ? ld.cur | 0 : 0, haveW ? ws(0) : str(n.weap), wa(0), ws(1), wa(1), ws(2), ws(3), wa(3), str(n.helmet), str(n.chest), str(n.pack), str(ld.scope), r2(ld.zoom), n.anim | 0, n.action | 0, str(n.actItem), flags, 0, 0, r2(typeof n.scale === 'number' ? n.scale : 1), str(n.outfit)]; // 25 size, 26 outfit (a Tank is bigger and wears its own skin)
    const info = b.playerInfo || {}, mine = info[myId] || {}, players = [];
    for (const p of pool(b.playerPool)) {
      if (!p || !p.active || p.__id === me.__id) continue; const q = net(p), pp = isVec(q.pos) ? q.pos : p[K.pos]; if (!isVec(pp)) continue; const pi = info[p.__id] || {};
      const mate = (mine.groupId > 0 && pi.groupId === mine.groupId) || (mine.teamId > 0 && pi.teamId === mine.teamId);
      players.push([p.__id, r2(pp.x), r2(pp.y), dir8(isVec(q.dir) ? q.dir : K.dir && p[K.dir]), p.layer | 0, str(q.weap), str(q.helmet), str(q.chest), str(q.pack),
        (q.dead ? 1 : 0) | (q.downed ? 2 : 0) | (mate ? 4 : 0) | (q.pan ? 8 : 0) | (q.heal ? 16 : 0) | (q.boost ? 32 : 0), q.anim | 0, q.action | 0, str(q.actItem), r2(typeof q.scale === 'number' ? q.scale : 1), str(q.outfit)]);
    }
    const gas = gasOf(g); push(['u', t, Math.round(lu), 0, 0, Math.round(gap), meRec, players, gas ? r2(gas.circleT) : null]); nU++;
    // the zone (on change), the shown player's inventory (on change), everyone's role and perks (on change)
    if (gas && gas.circleOld.pos && gas.circleNew.pos) { const sig = [gas.mode, gas.duration, gas.circleOld.pos.x, gas.circleOld.pos.y, gas.circleOld.rad, gas.circleNew.pos.x, gas.circleNew.pos.y, gas.circleNew.rad].join(',');
      if (sig !== gasSig) { gasSig = sig; push(['g', t, gas.mode | 0, r2(gas.duration), r2(gas.circleT), r2(gas.circleOld.pos.x), r2(gas.circleOld.pos.y), r2(gas.circleOld.rad), r2(gas.circleNew.pos.x), r2(gas.circleNew.pos.y), r2(gas.circleNew.rad)]); } }
    if (ld.inv && typeof ld.inv === 'object') { const sig = JSON.stringify(ld.inv); if (sig !== invSig) { invSig = sig; push(['v', t, JSON.parse(sig)]); } }
    for (const p of pool(b.playerPool)) { if (!p || !p.active) continue; const q = net(p); if (!Array.isArray(q.perks)) continue; const sig = (q.role || '') + '|' + q.perks.map(x => x && x.type).join(',');
      if (perkSeen.get(p.__id) !== sig) { perkSeen.set(p.__id, sig); push(['P', t, p.__id, str(q.role), q.perks.map(x => str(x && x.type))]); } }
    // loot: seen, moved (half a stud) or changed, gone; grenades in flight: first seen and where last seen; airdrops: first seen with how far
    // they had fallen; planes: first seen and when they drop
    const lootNow = new Set();
    for (const o of lootPool(g)) { if (!o || !o.active || !isVec(o.pos) || typeof o.type !== 'string') continue; lootNow.add(o.__id); const key = o.type + '|' + (o.count | 0), was = lootSeen.get(o.__id);
      if (!was || was.k !== key || Math.hypot(o.pos.x - was.x, o.pos.y - was.y) > 0.5) { lootSeen.set(o.__id, { k: key, x: o.pos.x, y: o.pos.y }); push(['L', t, o.__id, str(o.type), o.count | 0, r2(o.pos.x), r2(o.pos.y), o.layer | 0]); } }
    for (const id of [...lootSeen.keys()]) if (!lootNow.has(id)) { lootSeen.delete(id); push(['l', t, id]); }
    const projNow = new Set();
    for (const o of projPool(g)) { if (!o || !o.active || !isVec(o.pos)) continue; projNow.add(o.__id); if (!projSeen.has(o.__id)) push(['p', t, o.__id, str(o.type), r2(o.pos.x), r2(o.pos.y), o.layer | 0]); projSeen.set(o.__id, [r2(o.pos.x), r2(o.pos.y)]); }
    for (const [id, p] of [...projSeen]) if (!projNow.has(id)) { projSeen.delete(id); push(['q', t, id, p[0], p[1]]); }
    const airNow = new Set();
    for (const o of airPool(g)) { if (!o || !o.active || !isVec(o.pos)) continue; airNow.add(o.__id); if (!airSeen.has(o.__id)) { airSeen.add(o.__id); push(['a', t, o.__id, r2(o.pos.x), r2(o.pos.y), r2(Math.min(1, (+o.fallTicker || 0) / 8)), o.landed ? 1 : 0]); } }
    for (const id of [...airSeen]) if (!airNow.has(id)) airSeen.delete(id);
    for (const pl of planeList(g)) { if (!pl || !pl.active || !isVec(pl.pos) || !isVec(pl.planeDir)) continue; const key = pl.id + '|' + (pl.actionComplete ? 1 : 0);
      if (planeSeen.get(pl.id) !== key) { planeSeen.set(pl.id, key); push(['Z', t, pl.id | 0, r2(pl.pos.x), r2(pl.pos.y), r4(pl.planeDir.x), r4(pl.planeDir.y), pl.type | 0, pl.actionComplete ? 1 : 0]); } }
    for (const k of Object.keys(info)) { const nm = (info[k] || {}).name; if (typeof nm === 'string' && nm) names[k] = nm.slice(0, 24); } // for the replay tab only, never uploaded
    prune(t); if (died && !rpSnap && t - diedAt >= 2000) { rpSnap = rp.slice(); wireSnap = wireCut(); }
    const ids = Object.keys(info), sig = ids.join(','); if (sig !== infoSig) { infoSig = sig; push(['I', t, ids.map(k => [+k, (info[k] || {}).teamId | 0, (info[k] || {}).groupId | 0])]); }
    // obstacles: once when first seen (with their shape), then only when they change (broken, door opened, damaged)
    for (const o of obstacles(g)) {
      if (!o || !o.active || !isVec(o.pos)) continue; const door = o.isDoor && o.door, hp = typeof o.healthT === 'number' ? Math.round(o.healthT * 20) : 20;
      const fl = (o.dead ? 1 : 0) | (door && door.open ? 2 : 0) | (door && door.locked ? 4 : 0) | (!o.dead && o.collidable !== false && !(typeof o.height === 'number' && o.height < 0.25) ? 16 : 0);
      const first = !obsSeen.has(o.__id), c = o.collider;
      const col = !(first || o.isDoor) || !c ? null : c.type === 0 && c.pos ? [0, r2(c.pos.x), r2(c.pos.y), r2(c.rad)] : c.type === 1 && c.min && c.max ? [1, r2(c.min.x), r2(c.min.y), r2(c.max.x), r2(c.max.y)] : null;
      const s2 = fl * 32 + hp + (o.isDoor ? '|' + col : '');
      if (obsSeen.get(o.__id) !== s2) { obsSeen.set(o.__id, s2); const rec = ['o', t, o.__id, str(o.type), r2(o.pos.x), r2(o.pos.y), o.layer | 0, fl, hp]; if (col || first) rec.push(col); if (first) rec.push(typeof o.rot === 'number' ? ((Math.round(o.rot / (Math.PI / 2)) % 4) + 4) % 4 : 0); push(rec); } // 10: its quarter turn, once (1.4.2)
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
  const send = z => fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Observer-Token': token, 'X-Observer-Encoding': z.enc, 'X-Observer-Version': VERSION }, body: z.body });
  async function flush() {
    if (sending || !buf.length || paused) return; sending = true;
    // one batch: notes of one match only (its number goes in the header; a late tail of the last match sent under the next match's
    // number cost that match its start), and BATCH lines at most; the rest waits for the next send
    const m0 = buf[0][0]; let k = 0; while (k < buf.length && k < BATCH && buf[k][0] === m0) k++;
    const part = buf.splice(0, k);
    const text = JSON.stringify(['B', sess, VERSION, m0, Math.round(Date.now() - performance.now())]) + '\n' + part.map(r => JSON.stringify(r[1])).join('\n') + '\n';
    try {
      const z = await zip(text);
      const res = await send(z);
      if (res.ok) { sentBytes += z.body.length; lastError = ''; } else { lastError = 'server said ' + res.status; if (res.status >= 500 || res.status === 429) buf = part.concat(buf).slice(-KEEP); }
    } catch (e) { lastError = 'offline'; buf = part.concat(buf).slice(-KEEP); }
    sending = false; badge();
    if (!lastError && buf.length && (buf.length >= BATCH || buf[0][0] !== match || !inMatch)) setTimeout(flush, 5500); // a backlog: the next part soon (the server takes 12 a minute)
  }

  // ---------- 4. the game's id (signed-in players only) ----------
  // A moderator of the game can only act on a report that names the game, and the game never tells its client that id. The game's
  // own stats API does: your match history (what your stats page shows) lists your games with their ids, once a game is over.
  // So, only when the game says you are signed in: when a match ends a small note is kept in this browser (which match it was, when it
  // started, how long you lived, your in-game number; no names), and from the menu survev.io is asked for your match history (one
  // request, at most six tries a match, spaced from 30 seconds to 40 minutes: a game can go on long after you die). The row whose
  // time alive is yours names the game, and one line is sent: G, the match's start, the game id, your in-game number.
  // The history is on the game's API host, where the game's own stats page asks for it: survev.io/api/match_history itself answers
  // 404 (checked 2026-11-22), and the API host allows the request from a survev.io page (its CORS answer names https://survev.io).
  // Your account's name goes to survev.io only, as on your own stats page; it is not kept and never sent to us.
  const GAMES = 'observer.games', HISTORY = 'https://api.survev.io/api/match_history', GAME_WAIT = [30e3, 120e3, 300e3, 600e3, 1200e3, 2400e3], GAME_MAX = 12;
  let games = []; try { games = JSON.parse(localStorage.getItem(GAMES) || '[]'); if (!Array.isArray(games)) games = []; } catch (e) { games = []; }
  let gameBusy = false;
  const gameSave = () => { try { localStorage.setItem(GAMES, JSON.stringify(games)); } catch (e) {} };
  const slug = () => { try { const a = app && app.account, s = a && a.loggedIn && a.profile && a.profile.slug; return typeof s === 'string' ? s : ''; } catch (e) { return ''; } };
  // a match just ended: s session, m match number, o this page's clock against the wall clock, t its start, a how long you lived (to
  // your death, or to the end), e how long it was recorded, id your in-game number, w when it ended, n tries so far, v 1 when you
  // were never seen dead (a win, or you left alive); later g the game id once found, u failed uploads of it, x no upload before then
  function gameNote(t) {
    if (!slug() || !myId) return; const a = (diedAt || t) - startT; if (!(a > 0)) return;
    games.push({ s: sess, m: match, o: Math.round(Date.now() - performance.now()), t: startT, a, e: t - startT, id: myId, w: Date.now(), n: 0, v: diedAt ? 0 : 1 });
    if (games.length > GAME_MAX) games.splice(0, games.length - GAME_MAX); gameSave();
  }
  // Which row of the history is that match. The server counts a player's time alive from their own join to their death, so it equals
  // the note's a whatever the two clocks say (within 2 s); the row's end_time, when the game ended, cannot be before the last moment
  // recorded (2 minutes allowed for a clock that is off). Two games fit: the one that ended as the recording did, else the closer
  // time alive by a full second, else none. Rows that do not reach back to the match's start (10 a page) may miss its game: then only a
  // game that ended as the recording did.
  // Alive at the end (v): the recording runs on over the results screen, while the server stops counting at game over (player.ts:1469
  // is not reached once the game is over; rounded in gameProcess.ts:178), so the time alive is only a ceiling. Then a row fits when
  // its rank is 1 (alive at game over is the winning side), its time alive is not above ours, and its game ended when that time alive
  // says it did, counted from our start (2 minutes for the clocks).
  function gamePick(p, rows) {
    if (!Array.isArray(rows)) return null; const start = p.o + p.t, c = new Map();
    for (const r of rows) {
      if (!r || typeof r.guid !== 'string' || !/^[\w-]{8,64}$/.test(r.guid) || typeof r.time_alive !== 'number') continue; const end = Date.parse(r.end_time); let d = Math.abs(r.time_alive - p.a / 1000);
      if (!(end > start + p.e - 120e3 && end < start + 2400e3) || !(d <= 2)) { if (!p.v || r.rank !== 1 || !(r.time_alive <= p.a / 1000 + 2)) continue; d = Math.abs(end - start - r.time_alive * 1000) / 1000; if (!(d <= 120)) continue; }
      const e = Math.abs(end - (start + p.e)), q = c.get(r.guid); if (!q || d < q.d) c.set(r.guid, { g: r.guid, d, e: q ? Math.min(q.e, e) : e }); else if (e < q.e) q.e = e;
    }
    const a = [...c.values()].sort((x, y) => x.d - y.d), near = a.filter(x => x.e <= 30e3); if (!a.length) return null;
    if (near.length === 1) return near[0].g;
    const whole = rows.length < 10 || rows.some(r => r && Date.parse(r.end_time) < start);
    return whole && (a.length === 1 || a[1].d - a[0].d >= 1) ? a[0].g : null;
  }
  const gameDue = (p, wall) => !p.g && wall - p.w >= GAME_WAIT[Math.min(p.n, GAME_WAIT.length - 1)];
  // from the menu: one history request for every note that is due, then one small batch per game found (header of the match it
  // belongs to, so the line lands on that match). A note is dropped once sent, after six tries, or after a day. An upload that fails
  // waits like the history does (30 seconds to 40 minutes, six times at most) and ends the round: the match batches share the
  // server's 12 a minute, and a G line must never take a recording's place there.
  async function gameIds() {
    if (gameBusy || paused || inMatch || !games.length) return; const wall = Date.now(), n0 = games.length;
    games = games.filter(p => p && (p.g ? !(p.u >= GAME_WAIT.length) : p.n < GAME_WAIT.length) && wall - p.w < 86400e3); if (games.length !== n0) gameSave();
    const me = slug(), due = games.filter(p => gameDue(p, wall)), up = p => p.g && !(wall < p.x); if (!games.some(up) && (!me || !due.length)) return;
    gameBusy = true;
    try {
      if (me && due.length) {
        for (const p of due) p.n++; gameSave(); // counted before the request: a failing one is not asked again at once
        const res = await fetch(HISTORY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: me, offset: 0, count: 10, teamModeFilter: 7 }) });
        const rows = res.ok ? await res.json() : null;
        for (const p of due) { const g = gamePick(p, rows); if (g) p.g = g; } gameSave();
      }
      for (const p of games.filter(up)) {
        const z = await zip(JSON.stringify(['B', p.s, VERSION, p.m, p.o]) + '\n' + JSON.stringify(['G', p.t, p.g, p.id]) + '\n'); let res = null; try { res = await send(z); } catch (e) {}
        if (res && (res.ok || (res.status < 500 && res.status !== 429))) { games.splice(games.indexOf(p), 1); gameSave(); if (res.ok) sentBytes += z.body.length; continue; }
        p.u = (p.u | 0) + 1; p.x = wall + GAME_WAIT[Math.min(p.u, GAME_WAIT.length) - 1]; gameSave(); break;
      }
    } catch (e) {}
    gameBusy = false;
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

  // ---------- the death replay button ----------
  // Opens the replay page, waits for it to say it is ready, then hands it this match's notes and the names. The page only takes
  // them from survev.io, and this only sends them to the clip jury's address.
  let died = false, rbtn = null;
  // The button sits where the player looks after dying (owner, 2026-11-22: the corner one was "barely noticeable"): a big one under
  // the game's own Play Again / Spectate buttons on the results panel (#ui-stats-options, which the game empties and rebuilds each
  // time it shows), and one at the top of the spectate menu (#ui-spectate-buttons). The small corner one stays only while neither is
  // on screen. Added next to the game's buttons, styled with the game's own button classes; nothing of the game's is changed.
  const BIG = 'display:block;position:absolute;left:50%;transform:translateX(-50%);top:64px;width:330px;height:54px;line-height:54px;padding:0;' +
    'font-size:22px;font-weight:700;letter-spacing:.3px;background:#d9512c;border-bottom:2px solid #9e3a1f;box-shadow:inset 0 -2px #9e3a1f,0 0 0 3px rgba(255,255,255,.85);' +
    'pointer-events:auto;cursor:pointer;z-index:5;text-align:center;white-space:nowrap';
  const shown = el => !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
  function place(host, id, css, label) { // our button inside one of the game's button rows, made again if the game rebuilt the row
    let b = document.getElementById(id); if (!host) return null;
    if (!b || b.parentNode !== host) { if (b) b.remove(); b = document.createElement('a'); b.id = id; b.className = 'btn-darken menu-option'; b.textContent = label;
      b.title = 'watch your death again, drawn by the game itself'; b.style.cssText = css; b.onclick = e => { e.preventDefault(); e.stopPropagation(); openKillcam(); };
      host.appendChild(b); }
    return b;
  }
  function replayBtn() { try { replayBtnDo(); } catch (e) {} } // it runs inside the recording step: a page that is not the game's must never cost a line
  function replayBtnDo() {
    if (!document.body) return;
    const on = died && rp.length > 0, byId = typeof document.getElementById === 'function'; // no getElementById: only the corner button
    const stats = on && byId ? place(document.getElementById('ui-stats-options'), 'observer-replay-stats', BIG, '\u25B6  WATCH YOUR DEATH REPLAY') : null;
    const spect = on && byId ? place(document.getElementById('ui-spectate-buttons'), 'observer-replay-spect', 'display:block;background:#d9512c;color:#fff;font-weight:700;pointer-events:auto;margin-bottom:6px', '\u25B6 Death replay') : null;
    if (!on && byId) for (const id of ['observer-replay-stats', 'observer-replay-spect']) { const b = document.getElementById(id); if (b) b.remove(); }
    if (spect && spect.parentNode.firstChild !== spect) spect.parentNode.insertBefore(spect, spect.parentNode.firstChild); // first in the spectate menu
    if (!rbtn) { rbtn = document.createElement('div'); rbtn.textContent = '\u25B6 Death replay'; rbtn.title = 'watch your death again, drawn by the game itself';
      rbtn.style.cssText = 'position:fixed;left:8px;bottom:34px;z-index:2147483647;font:700 16px system-ui,sans-serif;color:#fff;background:#d9512c;padding:9px 15px;border-radius:5px;cursor:pointer;user-select:none;box-shadow:0 1px 6px rgba(0,0,0,.5)';
      rbtn.onclick = openKillcam; document.body.appendChild(rbtn); }
    rbtn.style.display = on && !shown(stats) && !shown(spect) ? '' : 'none';
  }
  function openReplay() {
    const lines = (rpSnap || rp).slice(), nm = Object.assign({}, names), w = window.open(REPLAY + '/replay', '_blank'); if (!w) return;
    const onMsg = ev => { if (ev.origin !== REPLAY || ev.source !== w || !ev.data || ev.data.observerReplayReady !== 1) return; window.removeEventListener('message', onMsg);
      w.postMessage({ observerReplay: 1, lines, names: nm, player: myId }, REPLAY); };
    window.addEventListener('message', onMsg); setTimeout(() => window.removeEventListener('message', onMsg), 30000);
  }

  // The killcam (part 0): the copy of this match's socket as it was 2 s after your death goes to a new survev.io tab, which asks for
  // it once it has loaded (and again after its Restart). Copies of the messages are handed over, never the ones the game holds.
  const kcSnap = new Map();
  const wireCut = () => { const w = wire; if (!w || !w.frames.length) return null; return { url: w.url, openEpoch: w.openEpoch, t0: w.t0, frames: w.frames.slice(), death: diedAt, me: myId }; };
  window.addEventListener('message', ev => { const d = ev.data, s = kcSnap.get(ev.source); if (ev.origin !== location.origin || !s || !d || d.vbKillcamReady !== 1) return;
    const frames = s.frames.map(f => [f[0] - s.t0, f[1].slice(0)]), death = s.death - s.t0;
    ev.source.postMessage({ vbKillcam: 1, url: s.url, openEpoch: s.openEpoch, frames, death, from: death - KC_BEFORE, to: death + KC_AFTER, me: s.me }, location.origin, frames.map(f => f[1])); });
  function openKillcam() {
    const s = wireSnap || (died ? wireCut() : null);
    if (!s || !s.frames.length || !s.death) { openReplay(); return; } // no copy of this match's socket (the observer started after it opened): the map replay
    const w = window.open(location.origin + '/?u=' + encodeURIComponent(btoa(KC_URL)) + '&jt=vb', '_blank'); if (!w) return;
    kcSnap.set(w, s); while (kcSnap.size > 3) kcSnap.delete(kcSnap.keys().next().value);
  }
  window.__observerNotes = () => buf.map(r => r[1]); // tools/test-observer-wire.js: what was noted (nothing leaves the page in that test)
  window.__observerWire = () => (wire ? { n: wire.frames.length, bytes: wire.bytes, url: wire.url, u: nU, upd: updSeq } : null); // the same test: how much of the socket is copied
  window.__observerKillcam = () => { const s = wireCut(); if (s) { s.death = Math.round(performance.now()); wireSnap = s; died = true; } openKillcam(); }; // tools/test-observer-killcam.js: the killcam without dying

  function loop() { try { tick(); } catch (e) {} requestAnimationFrame(loop); }
  requestAnimationFrame(loop);
  setInterval(() => { flush(); badge(); gameIds(); }, FLUSH_MS);
  setInterval(badge, 2000);
  setInterval(() => { try { replayBtn(); } catch (e) {} }, 400); // the game rebuilds its results panel each time it shows it
})();
