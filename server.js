// OsMike Meetings — meetings.osmike.com
// Video meetings, two media paths (MEETINGS_MEDIA=sfu|mesh, per room ?media=): the LiveKit SFU on relay 114
// (livekit.osmike.com, no participant ceiling; the server mints a short-lived token per join) or the WebRTC mesh
// (peer-to-peer, good for 2-6). Either way the same-origin /ws socket carries presence, recording and the meeting's
// lifecycle; only the audio/video goes through LiveKit. Self-hosted STUN/TURN (coturn on 114) for strict networks. Sign in with an OsMike Account (OAuth 2.0 code + PKCE against account.osmike.com, server-side session,
// identity from /oauth/userinfo — account issues no id_token). People without an account join a room link by typing
// their name.
//
// Every meeting is recorded and transcribed (everyone sees this before joining and in the room): each browser
// records its own microphone and streams it over the signaling socket; when the meeting ends (everyone left, or the
// host ends it) the audio is transcribed and summarised on OsMike's own GPU (lib/pipeline.js). The transcript and
// summary are visible ONLY to the host and the signed-in people who were in the meeting (others get 404).
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Store, canSee, digest, rid } from './lib/store.js';
import { processMeeting, whisper, qwenJson } from './lib/pipeline.js';

export function createApp(env = process.env, deps = {}) {
  const cfg = {
    PORT: env.PORT || 8095,
    ISSUER: env.ISSUER || 'https://account.osmike.com',
    CLIENT_ID: env.CLIENT_ID || 'meetings-web',
    CALENDAR_URL: env.CALENDAR_URL || 'http://mikeos-events:8000',
    TURN_HOST: env.TURN_HOST || 'meetings.osmike.com',
    TURN_PORT: env.TURN_PORT || '3478',
    TURN_SECRET: env.TURN_SECRET || '',
    DATA_DIR: env.DATA_DIR || '/data',
    STT_URL: (env.STT_URL || 'http://172.18.0.1:21600').replace(/\/$/, ''),
    LLM_URL: (env.LLM_URL || 'https://gpu.osmike.com').replace(/\/$/, ''),
    LLM_MODEL: env.LLM_MODEL || 'huihui_ai/qwen3-abliterated:8b-v2',
    GPU_TOKEN: env.GPU_OSMIKE_TOKEN || '',
    END_GRACE_MS: +(env.END_GRACE_MS || 45_000),
    RESUME_MS: +(env.RESUME_MS ?? 30_000),    // a dropped socket keeps its place this long (network blip, proxy reload)
    PUBLIC_HOST: env.PUBLIC_HOST || 'meetings.osmike.com',
    SECURE: env.INSECURE_COOKIES !== '1',
    LIVEKIT_URL: (env.LIVEKIT_URL || '').replace(/\/$/, ''),
    LIVEKIT_API_KEY: env.LIVEKIT_API_KEY || '',
    LIVEKIT_API_SECRET: env.LIVEKIT_API_SECRET || '',
    MEDIA: env.MEETINGS_MEDIA === 'sfu' ? 'sfu' : 'mesh',   // default for new rooms; the way back is MEETINGS_MEDIA=mesh
    LK_TOKEN_TTL_S: +(env.LK_TOKEN_TTL_S || 600),
  };
  cfg.SFU_READY = !!(cfg.LIVEKIT_URL && cfg.LIVEKIT_API_KEY && cfg.LIVEKIT_API_SECRET);
  cfg.LIVEKIT_HTTP = cfg.LIVEKIT_URL.replace(/^ws/, 'http');
  const store = deps.store || new Store(cfg.DATA_DIR);
  const fetchImpl = deps.fetch || fetch;
  const log = deps.log || ((...a) => console.log(new Date().toISOString(), ...a));
  const SID = cfg.SECURE ? '__Host-meetings-sid' : 'meetings-sid';
  const PRE = cfg.SECURE ? '__Host-meetings-pre' : 'meetings-pre';
  const cookieOpts = { httpOnly: true, secure: cfg.SECURE, sameSite: 'lax', path: '/' };

  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin'); next(); });

  const b64url = (buf) => buf.toString('base64url');
  const sidOf = (req) => req.cookies?.[SID];
  const sessionOf = (req) => store.getSession(sidOf(req));
  const callback = () => `https://${cfg.PUBLIC_HOST}/auth/callback`;
  const safeNext = (v) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') && !v.startsWith('/auth/') && v.length < 1000 && !/[\x00-\x1f]/.test(v)) ? v : '/';

  // ================= silent single sign-on (OIDC prompt=none) =================
  // Signed in at another OsMike site -> signed in here without a click. A real browser page view with no
  // session asks the account once per 10 min (sso_tried); no account session -> error=login_required ->
  // the same page, signed out (guests join as before). sso_off = signed out here, stays out until Sign in.
  const SSO_TRIED = 'sso_tried', SSO_OFF = 'sso_off', SSO_SILENT = ['login_required', 'interaction_required', 'consent_required', 'account_selection_required'];
  const SSO_SKIP = /^\/(auth|api|static|healthz|ws|favicon|robots\.txt|\.well-known)(\/|$|\.)/;
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.get('sec-fetch-mode') !== 'navigate' || (req.get('sec-fetch-dest') || 'document') !== 'document') return next();
    if (/prefetch/i.test((req.get('sec-purpose') || '') + (req.get('purpose') || '')) || !(req.get('accept') || '').includes('text/html')) return next();
    if (req.cookies?.[SSO_TRIED] || req.cookies?.[SSO_OFF] || req.query.sso === '0' || SSO_SKIP.test(req.path) || sessionOf(req)) return next();
    res.cookie(SSO_TRIED, '1', { ...cookieOpts, maxAge: 600_000 });
    res.set('Cache-Control', 'no-store').redirect(302, `/auth/login?prompt=none&next=${encodeURIComponent(req.originalUrl)}`);
  });

  // ================= login (state bound to the browser that started it, single use, 10 min) =================
  const flows = new Map(); // digest(state) -> { pre: digest(pre-cookie), verifier, next, exp }
  app.get('/auth/login', (req, res) => {
    for (const [k, f] of flows) if (f.exp < Date.now()) flows.delete(k);
    if (flows.size > 5000) return res.status(429).send('Too many sign-ins right now. Try again in a few minutes.');
    const pre = req.cookies?.[PRE] || b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(24));
    flows.set(digest(state), { pre: digest(pre), verifier, next: safeNext(req.query.next), exp: Date.now() + 600_000 });
    res.cookie(PRE, pre, { ...cookieOpts, maxAge: 600_000 });
    const u = new URL(`${cfg.ISSUER}/oauth/authorize`);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: cfg.CLIENT_ID, redirect_uri: callback(), scope: 'openid profile email',
      state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' })) u.searchParams.set(k, v);
    if (req.query.prompt === 'none') u.searchParams.set('prompt', 'none');
    res.redirect(u.toString());
  });

  const page = (title, body, code = 200) => (res) => res.status(code).type('html').send(`<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · OsMike Meetings</title>${THEME_JS}<link rel="stylesheet" href="/static/tokens.css"><link rel="stylesheet" href="/static/theme.css"><link rel="stylesheet" href="/static/base.css"><link rel="stylesheet" href="/static/meetings.css"></head><body><header class="top"><a class="brand" href="/"><span class="mark" aria-hidden="true"></span><span class="wordmark">Meetings</span></a></header><main id="main" class="wrap"><div class="card auth"><h1>${title}</h1>${body}</div></main></body></html>`);

  app.get('/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const f = flows.get(digest(String(state || '')));
    const pre = req.cookies?.[PRE];
    if (SSO_SILENT.includes(String(error || ''))) { // prompt=none, no account session: back to the page, signed out
      if (f) flows.delete(digest(String(state)));
      const to = (f && f.next) || '/';
      return res.redirect(303, req.cookies?.[SSO_TRIED] ? to : to + (to.includes('?') ? '&' : '?') + 'sso=0');
    }
    if (!f || f.exp < Date.now() || !pre || !crypto.timingSafeEqual(Buffer.from(f.pre), Buffer.from(digest(pre)))) {
      return page('Sign in again', '<p>This sign-in link has expired or was started in another browser.</p><p><a class="btn primary" href="/auth/login">Sign in</a></p>', 400)(res);
    }
    flows.delete(digest(String(state)));
    if (error || !code) return page('Sign-in cancelled', '<p>You can try again.</p><p><a class="btn primary" href="/auth/login">Sign in</a></p>', 400)(res);
    try {
      const r = await fetchImpl(`${cfg.ISSUER}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code), code_verifier: f.verifier, client_id: cfg.CLIENT_ID, redirect_uri: callback() }) });
      if (!r.ok) throw new Error(`token ${r.status}`);
      const tok = await r.json();
      const ui = await fetchImpl(`${cfg.ISSUER}/oauth/userinfo`, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
      if (!ui.ok) throw new Error(`userinfo ${ui.status}`);
      const info = await ui.json();
      if (!info.sub || !info.email) throw new Error('no sub/email');
      const old = sidOf(req); if (old) store.dropSession(old);
      const sid = b64url(crypto.randomBytes(32));
      const now = Date.now();
      store.putSession(sid, { user: { sub: String(info.sub), email: String(info.email).toLowerCase(), name: String(info.name || info.preferred_username || info.email).slice(0, 120) },
        csrf: b64url(crypto.randomBytes(18)), access_token: tok.access_token, refresh_token: tok.refresh_token || null,
        token_expires: now + (+tok.expires_in || 3600) * 1000, created: now, expires: now + 30 * 86400_000 });
      res.clearCookie(PRE, cookieOpts); res.clearCookie(SSO_OFF, cookieOpts); res.clearCookie(SSO_TRIED, cookieOpts);
      res.cookie(SID, sid, { ...cookieOpts, maxAge: 30 * 86400_000 });
      res.redirect(f.next || '/');
    } catch (e) {
      log('sign-in failed', e.message);
      page('Sign-in failed', '<p>Your OsMike Account did not accept the sign-in. Please try again.</p><p><a class="btn primary" href="/auth/login">Sign in</a></p>', 502)(res);
    }
  });

  const csrfOk = (req, s) => s && typeof req.get('x-csrf') === 'string' && req.get('x-csrf') === s.csrf;
  app.post('/auth/logout', (req, res) => {
    const s = sessionOf(req);
    if (s && !csrfOk(req, s)) return res.status(403).json({ error: 'csrf' });
    store.dropSession(sidOf(req)); res.clearCookie(SID, cookieOpts);
    res.cookie(SSO_OFF, '1', { ...cookieOpts, maxAge: 180 * 86400_000 }); res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    const s = sessionOf(req);
    res.set('Cache-Control', 'no-store');
    res.json(s ? { authenticated: true, user: { name: s.user.name, email: s.user.email }, csrf: s.csrf } : { authenticated: false });
  });

  async function tokenOf(s) {
    if (!s) return null;
    if (s.token_expires > Date.now() + 60_000) return s.access_token;
    if (!s.refresh_token) return null;
    try {
      const r = await fetchImpl(`${cfg.ISSUER}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: cfg.CLIENT_ID }) });
      if (!r.ok) return null;
      const t = await r.json();
      s.access_token = t.access_token || s.access_token;
      if (t.refresh_token) s.refresh_token = t.refresh_token;
      s.token_expires = Date.now() + (+t.expires_in || 3600) * 1000;
      store.saveSessions();
      return s.access_token;
    } catch { return null; }
  }
  // Signed-in API calls; changes need the session's CSRF header (a cross-site page cannot set it).
  const auth = (req, res, next) => {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: 'not_signed_in' });
    if (req.method !== 'GET' && !csrfOk(req, s)) return res.status(403).json({ error: 'csrf' });
    req.s = s; next();
  };

  // ================= ICE =================
  function iceServers() {
    const list = [{ urls: `stun:${cfg.TURN_HOST}:${cfg.TURN_PORT}` }];
    if (cfg.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 3600}:meetings-${rid(8)}`; // one per browser: coturn's user-quota counts per username
      const credential = crypto.createHmac('sha1', cfg.TURN_SECRET).update(username).digest('base64');
      list.push({ urls: `turn:${cfg.TURN_HOST}:${cfg.TURN_PORT}?transport=udp`, username, credential });
      list.push({ urls: `turn:${cfg.TURN_HOST}:${cfg.TURN_PORT}?transport=tcp`, username, credential });
    }
    return list;
  }
  app.get('/api/ice', (req, res) => res.json({ iceServers: iceServers() }));

  // ================= LiveKit (SFU) =================
  // Access token = HS256 JWT signed with the API secret. identity = the socket's peerId (so the server can remove that
  // exact person), name = the name the server already decided (account name or the guest's typed name), room = the
  // meeting id (a token for one meeting never opens the next meeting in the same room).
  const jwt = (claims) => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}`;
    return `${body}.${crypto.createHmac('sha256', cfg.LIVEKIT_API_SECRET).update(body).digest('base64url')}`;
  };
  function lkToken(room, identity, name, ttl = cfg.LK_TOKEN_TTL_S) {
    const now = Math.floor(Date.now() / 1000);
    return jwt({ iss: cfg.LIVEKIT_API_KEY, sub: identity, name, nbf: now - 10, exp: now + ttl, jti: identity + '-' + rid(6),
      video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false } });
  }
  async function lkAdmin(method, body) {     // best effort: the /ws socket stays the authority on who is in the meeting
    if (!cfg.SFU_READY) return null;
    const now = Math.floor(Date.now() / 1000);
    const tok = jwt({ iss: cfg.LIVEKIT_API_KEY, sub: 'meetings-server', nbf: now - 10, exp: now + 60, video: { room: body.room, roomAdmin: true, roomCreate: true } });
    try {
      const r = await fetchImpl(`${cfg.LIVEKIT_HTTP}/twirp/livekit.RoomService/${method}`, { method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      return r.status;
    } catch (e) { log('livekit', method, e.message); return null; }
  }
  const sfuInfo = (live, ws) => ({ url: cfg.LIVEKIT_URL, token: lkToken(live.meetingId, ws.peerId, ws.name) });

  // ================= rooms + calendar =================
  const newRoomId = () => rid(10);
  const joinUrl = (roomId) => `https://${cfg.PUBLIC_HOST}/r/${roomId}`;
  const toIso = (s) => { const ms = Date.parse(s || ''); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };

  app.post('/api/rooms', auth, (req, res) => {
    const roomId = newRoomId();
    store.putRoom(roomId, { host_sub: req.s.user.sub, host_name: req.s.user.name, created: Date.now(), title: String(req.body?.title || '').slice(0, 200) || null });
    res.json({ room_id: roomId, join_url: joinUrl(roomId) });
  });

  async function calendarEvents(tok) {
    const r = await fetchImpl(`${cfg.CALENDAR_URL}/api/events`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) throw new Error(`events list ${r.status}`);
    const data = await r.json();
    return Array.isArray(data) ? data : (data.events || data.items || []);
  }
  async function listUpcoming(tok, includePast) {
    const now = Date.now(), out = [];
    for (const ev of await calendarEvents(tok)) {
      if (ev?.type !== 'calendar') continue;
      const p = ev.payload || {};
      if (!p.room_id) continue;
      const startMs = Date.parse(p.start || ev.ts || '');
      if (!includePast && Number.isFinite(startMs) && startMs < now - 3600_000) continue;
      out.push({ id: ev.id, title: p.title || 'Meeting', start: p.start || ev.ts, end: p.end || null, room_id: p.room_id, join_url: p.join_url });
    }
    return out.sort((a, b) => (Date.parse(a.start) || 0) - (Date.parse(b.start) || 0));
  }

  app.post('/api/meetings', auth, async (req, res) => {
    const tok = await tokenOf(req.s);
    const title = String(req.body?.title || '').trim().slice(0, 200) || 'Meeting';
    const startIso = toIso(String(req.body?.start || ''));
    const endIso = req.body?.end ? toIso(String(req.body.end)) : null;
    if (!startIso) return res.status(400).json({ error: 'bad_start' });
    if (!tok) return res.status(401).json({ error: 'not_signed_in' });
    const roomId = newRoomId();
    store.putRoom(roomId, { host_sub: req.s.user.sub, host_name: req.s.user.name, created: Date.now(), title });
    const payload = { title, start: startIso, room_id: roomId, join_url: joinUrl(roomId), description: '', ...(endIso ? { end: endIso } : {}) };
    try {
      const r = await fetchImpl(`${cfg.CALENDAR_URL}/api/events`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: 'meetings', type: 'calendar', ts: startIso, agent: 'meetings-web', payload }) });
      if (!r.ok) return res.status(502).json({ error: 'calendar_write_failed', status: r.status });
      const found = (await listUpcoming(tok, true)).find((m) => m.room_id === roomId);   // never trust a 200
      if (!found) return res.status(502).json({ error: 'calendar_not_persisted' });
      res.json({ saved: true, meeting: found });
    } catch (e) { log('schedule', e.message); res.status(502).json({ error: 'calendar_unreachable' }); }
  });

  app.get('/api/meetings', auth, async (req, res) => {
    const tok = await tokenOf(req.s);
    try { res.json({ meetings: tok ? await listUpcoming(tok, false) : [] }); }
    catch (e) { log('list', e.message); res.status(502).json({ error: 'calendar_unreachable' }); }
  });

  app.get('/api/room/:id', (req, res) => {
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9]{1,64}$/.test(id)) return res.status(404).json({ error: 'not_found' });
    const live = liveRooms.get(id), r = store.room(id);
    res.json({ recorded: true, title: r?.title || null, host_name: r?.host_name || null, in_call: live ? live.peers.size : 0,
      media: live ? live.media : cfg.SFU_READY ? cfg.MEDIA : 'mesh' });
  });

  // ================= past meetings (host + signed-in participants only; everyone else: 404) =================
  const people = (m) => [...new Map((m.participants || []).map((p) => [p.sub || `g:${p.name}`, { name: p.name, guest: !p.sub }])).values()];
  const brief = (m, sub) => ({
    id: m.id, room: m.room, title: m.title || 'Meeting', started_at: m.started_at, ended_at: m.ended_at || null,
    duration_s: m.ended_at ? Math.round((m.ended_at - m.started_at) / 1000) : null, status: m.status, stage: m.stage || null,
    people: people(m), language: m.language || null, is_host: m.host_sub === sub, has_summary: !!m.summary,
    url: `https://${cfg.PUBLIC_HOST}/m/${m.id}`,
  });
  const full = (m, sub) => ({
    ...brief(m, sub), host_name: m.host_name || null, error: m.status === 'failed' ? (m.error || 'failed') : null,
    participants: (m.participants || []).map((p) => ({ name: p.name, guest: !p.sub, joined_at: p.joined_at, left_at: p.left_at || null })),
    transcript: (m.transcript || []).map((l) => ({ at: l.at, end: l.end, speaker: l.speaker, text: l.text })), summary: m.summary || null,
    calendar: m.calendar ? { title: m.calendar.title, url: `https://calendar.osmike.com/e/${m.calendar.id}`, crm_url: m.calendar.crm_company ? `https://crm.osmike.com/c/${m.calendar.crm_company}` : null } : null,
  });
  const visible = (sub) => store.allMeetings().filter((m) => m.status !== 'live' && m.status !== 'discarded' && canSee(m, sub)).sort((a, b) => b.started_at - a.started_at);
  const search = (list, q) => { q = String(q || '').trim().toLowerCase(); if (!q) return list;
    return list.filter((m) => (m.title || '').toLowerCase().includes(q) || (m.transcript || []).some((l) => l.text.toLowerCase().includes(q)) || people(m).some((p) => p.name.toLowerCase().includes(q))); };

  app.get('/api/past', auth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ meetings: search(visible(req.s.user.sub), req.query.q).slice(0, 200).map((m) => brief(m, req.s.user.sub)) });
  });
  app.get('/api/past/:id', auth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const m = store.meeting(req.params.id);
    if (!m || m.status === 'discarded' || !canSee(m, req.s.user.sub)) return res.status(404).json({ error: 'not_found' });
    res.json(full(m, req.s.user.sub));
  });
  app.delete('/api/past/:id', auth, (req, res) => {
    const m = store.meeting(req.params.id);
    if (!m || !canSee(m, req.s.user.sub)) return res.status(404).json({ error: 'not_found' });
    if (m.host_sub !== req.s.user.sub) return res.status(403).json({ error: 'only_the_host_can_delete' });
    if (m.status === 'live') return res.status(409).json({ error: 'still_running' });
    store.deleteMeeting(m.id); res.json({ deleted: true });
  });

  // Agents: the account token of the agent's own person (osmike-runs gets it for the agent) -> that person's meetings.
  const tokCache = new Map();
  async function personOfBearer(req) {
    const h = req.get('authorization') || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!tok) return null;
    const k = digest(tok), hit = tokCache.get(k);
    if (hit && hit.exp > Date.now()) return hit.sub;
    const r = await fetchImpl(`${cfg.ISSUER}/oauth/userinfo`, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' } }).catch(() => null);
    if (!r || !r.ok) return null;
    const info = await r.json().catch(() => ({}));
    if (!info.sub) return null;
    if (tokCache.size > 2000) tokCache.clear();
    tokCache.set(k, { sub: String(info.sub), exp: Date.now() + 300_000 });
    return String(info.sub);
  }
  app.get('/api/agent/meetings', async (req, res) => {
    const sub = await personOfBearer(req);
    if (!sub) return res.status(401).json({ error: 'bad_token' });
    const lim = Math.max(1, Math.min(100, +req.query.limit || 20));
    res.json({ meetings: search(visible(sub), req.query.q).slice(0, lim).map((m) => brief(m, sub)) });
  });
  app.get('/api/agent/meetings/:id', async (req, res) => {
    const sub = await personOfBearer(req);
    if (!sub) return res.status(401).json({ error: 'bad_token' });
    const m = store.meeting(req.params.id);
    if (!m || m.status === 'discarded' || !canSee(m, sub)) return res.status(404).json({ error: 'not_found' });
    res.json(full(m, sub));
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, queue: queue.length, busy: !!working, live: liveRooms.size,
    media: cfg.SFU_READY ? cfg.MEDIA : 'mesh', sfu: cfg.SFU_READY }));

  // ================= pages =================
  const STATIC = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');
  app.use('/static', express.static(path.join(STATIC, 'static'), { maxAge: '1h' }));
  const index = (res, code = 200) => res.status(code).set('Cache-Control', 'no-store').sendFile('index.html', { root: STATIC });
  app.get('/m/:id', (req, res) => {
    const s = sessionOf(req);
    if (!s) return res.redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
    const m = store.meeting(req.params.id);
    if (!m || m.status === 'discarded' || !canSee(m, s.user.sub)) return index(res, 404);
    index(res);
  });
  app.get(['/', '/r/:id', '/past'], (req, res) => index(res));
  app.use((req, res) => (req.path.startsWith('/api/') ? res.status(404).json({ error: 'not_found' }) : index(res, 404)));

  // ================= live meetings: signaling + recording =================
  const liveRooms = new Map(); // roomId -> { peers: Map<peerId, ws>, meetingId, endTimer, media: 'sfu'|'mesh' }
  const saveTimers = new Map();
  const saveSoon = (m) => { if (saveTimers.has(m.id)) return; saveTimers.set(m.id, setTimeout(() => { saveTimers.delete(m.id); store.saveMeeting(m); }, 5000)); };
  const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* gone */ } };
  const MAX_SEG_BYTES = 300 * 1024 * 1024, MAX_MEETING_MS = 5 * 3600_000;

  function startMeeting(roomId) {
    const r = store.room(roomId);
    const m = { id: rid(16), room: roomId, title: r?.title || null, started_at: Date.now(), ended_at: null, status: 'live', recorded: true,
      host_sub: r?.host_sub || null, host_name: r?.host_name || null, participants: [], segments: [], transcript: [], summary: null };
    store.saveMeeting(m);
    log('meeting start', m.id, 'room', roomId);
    return m;
  }

  function closeRec(ws) {
    if (ws.rec) { try { ws.rec.stream.end(); } catch { /* */ } ws.rec = null; }
  }

  // dropped = the socket closed without a Leave (network blip, proxy reload, dead connection): the person keeps their
  // place for RESUME_MS and can come back with the resume key from their welcome (same peer id, same SFU identity).
  function leave(ws, dropped) {
    const roomId = ws.roomId;           // the Leave button clears ws.roomId right after this: the end timer must not read it later
    const live = liveRooms.get(roomId);
    closeRec(ws);
    if (!live || live.peers.get(ws.peerId) !== ws) return;
    live.peers.delete(ws.peerId);
    if (dropped && cfg.RESUME_MS > 0) {
      const pid = ws.peerId;
      clearTimeout(live.away.get(pid)?.timer);
      live.away.set(pid, { key: ws.resumeKey, name: ws.name, user: ws.user, timer: setTimeout(() => { if (live.away.delete(pid)) gone(live, pid); }, cfg.RESUME_MS) });
    } else gone(live, ws.peerId);
    if (live.peers.size === 0) {
      clearTimeout(live.endTimer);
      live.endTimer = setTimeout(() => endMeeting(roomId, 'everyone left'), cfg.END_GRACE_MS);
    }
  }
  function gone(live, pid) {
    const m = store.meeting(live.meetingId);
    const p = m?.participants.find((x) => x.pid === pid && !x.left_at);
    if (p) { p.left_at = Date.now(); saveSoon(m); }
    for (const [, o] of live.peers) send(o, { type: 'peer-left', id: pid });
    if (live.media === 'sfu') lkAdmin('RemoveParticipant', { room: live.meetingId, identity: pid });   // no ghost left in the SFU
  }

  function endMeeting(roomId, why) {
    const live = liveRooms.get(roomId);
    if (!live) return;
    clearTimeout(live.endTimer);
    for (const [, a] of live.away) clearTimeout(a.timer);
    liveRooms.delete(roomId);
    for (const [, o] of live.peers) { send(o, { type: 'ended', by: why }); closeRec(o); o.roomId = null; try { o.close(); } catch { /* */ } }
    if (live.media === 'sfu') lkAdmin('DeleteRoom', { room: live.meetingId });   // everyone out of the SFU too
    const m = store.meeting(live.meetingId);
    if (!m) return;
    finish(m, why);
  }

  function finish(m, why) {
    clearTimeout(saveTimers.get(m.id)); saveTimers.delete(m.id);
    m.ended_at = m.ended_at || Date.now();
    for (const p of m.participants) if (!p.left_at) p.left_at = m.ended_at;
    m.end_reason = why;
    const anyAccount = m.participants.some((p) => p.sub);
    const audio = m.segments.some((s) => s.bytes > 2000);
    if (!anyAccount) {                 // nobody who could ever see it: keep nothing
      log('meeting', m.id, 'had no signed-in person: discarded');
      store.deleteMeeting(m.id); return;
    }
    if (!m.host_sub) { const first = m.participants.find((p) => p.sub); m.host_sub = first.sub; m.host_name = first.name; }
    m.status = audio ? 'queued' : 'done';
    if (!audio) m.summary = null;
    store.saveMeeting(m);
    log('meeting end', m.id, why, audio ? 'queued' : 'no audio');
    if (audio) enqueue(m.id);
  }

  function attach(server) {
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });
    wss.on('connection', (ws, req) => {
      const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
      const s = store.getSession(cookies[SID]);
      ws.user = s ? s.user : null;
      ws.peerId = rid(12); ws.roomId = null; ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (raw, isBinary) => {
        if (isBinary) return audioIn(ws, raw);
        let msg; try { msg = JSON.parse(raw.toString().slice(0, 200_000)); } catch { return; }
        if (msg.type === 'join') return join(ws, msg);
        if (msg.type === 'signal') {
          const t = liveRooms.get(ws.roomId)?.peers.get(String(msg.to || ''));
          if (t) send(t, { type: 'signal', from: ws.peerId, name: ws.name, data: msg.data });
          return;
        }
        if (msg.type === 'media-token') {        // SFU: a fresh token to reconnect (only for someone in the meeting)
          const live = liveRooms.get(ws.roomId);
          if (live && live.media === 'sfu' && live.peers.get(ws.peerId) === ws) send(ws, { type: 'media-token', ...sfuInfo(live, ws) });
          return;
        }
        if (msg.type === 'rec-start') return recStart(ws, msg);
        if (msg.type === 'rec-stop') return closeRec(ws);
        if (msg.type === 'end-meeting') {
          const live = liveRooms.get(ws.roomId), m = live && store.meeting(live.meetingId);
          if (m && ws.user && m.host_sub === ws.user.sub) endMeeting(ws.roomId, `ended by ${ws.user.name}`);
          else send(ws, { type: 'error', error: 'only_the_host_can_end' });
          return;
        }
        if (msg.type === 'leave') { leave(ws); ws.roomId = null; }
      });
      ws.on('close', () => leave(ws, true));
      ws.on('error', () => leave(ws, true));
    });
    setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) { leave(ws, true); ws.terminate(); continue; }
        ws.isAlive = false; try { ws.ping(); } catch { /* */ }
      }
      for (const [roomId, live] of liveRooms) { const m = store.meeting(live.meetingId); if (m && Date.now() - m.started_at > MAX_MEETING_MS) endMeeting(roomId, 'time limit (5 h)'); }
    }, 30_000).unref();
    return wss;
  }

  function join(ws, msg) {
    const roomId = String(msg.room || '');
    if (!/^[A-Za-z0-9]{1,64}$/.test(roomId) || ws.roomId) return;
    let name;
    if (ws.user) name = ws.user.name;
    else {
      name = String(msg.name || '').replace(/[\x00-\x1f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!name) return send(ws, { type: 'error', error: 'name_required' });
    }
    let live = liveRooms.get(roomId);
    if (msg.resume) {        // coming back after a dropped socket: same place, same peer id; never a new meeting
      if (!live) return send(ws, { type: 'ended', by: '' });
      const pid = String(msg.pid || ''), a = live.away.get(pid);
      const ok = a && typeof msg.resume === 'string' && msg.resume.length === a.key.length && crypto.timingSafeEqual(Buffer.from(msg.resume), Buffer.from(a.key))
        && (a.user?.sub || null) === (ws.user?.sub || null);
      if (!ok) return send(ws, { type: 'resume-failed' });
      clearTimeout(a.timer); live.away.delete(pid);
      clearTimeout(live.endTimer); live.endTimer = null;
      ws.peerId = pid; ws.name = a.name; ws.roomId = roomId; ws.resumeKey = a.key;
      live.peers.set(pid, ws);
      const m = store.meeting(live.meetingId);
      send(ws, { type: 'welcome', resumed: true, self: pid, peers: [...live.peers.entries()].filter(([id]) => id !== pid).map(([id, o]) => ({ id, name: o.name })), name: ws.name,
        meeting: m.id, recorded: true, resume: ws.resumeKey, is_host: !!(ws.user && m.host_sub === ws.user.sub), host_name: m.host_name, media: live.media,
        ...(live.media === 'sfu' ? { sfu: sfuInfo(live, ws) } : {}) });
      return;
    }
    ws.name = name; ws.roomId = roomId; ws.resumeKey = b64url(crypto.randomBytes(18));
    if (!live) {     // the first person decides the media path for the whole meeting: never sfu and mesh in one room
      const want = msg.media === 'mesh' || msg.media === 'sfu' ? msg.media : cfg.MEDIA;
      live = { peers: new Map(), away: new Map(), meetingId: startMeeting(roomId).id, endTimer: null, media: want === 'sfu' && cfg.SFU_READY ? 'sfu' : 'mesh' };
      liveRooms.set(roomId, live);
    }
    clearTimeout(live.endTimer); live.endTimer = null;
    const m = store.meeting(live.meetingId);
    if (ws.user && !m.host_sub && !store.room(roomId)?.host_sub) { /* first signed-in person hosts an unregistered room */ m.host_sub = ws.user.sub; m.host_name = ws.user.name; }
    m.participants.push({ pid: ws.peerId, name, sub: ws.user?.sub || null, email: ws.user?.email || null, joined_at: Date.now(), left_at: null });
    store.saveMeeting(m);
    send(ws, { type: 'welcome', self: ws.peerId, peers: [...live.peers.entries()].map(([id, o]) => ({ id, name: o.name })), name, meeting: m.id, recorded: true, resume: ws.resumeKey,
      is_host: !!(ws.user && m.host_sub === ws.user.sub), host_name: m.host_name, media: live.media, ...(live.media === 'sfu' ? { sfu: sfuInfo(live, ws) } : {}) });
    for (const [, o] of live.peers) send(o, { type: 'peer-joined', id: ws.peerId, name });
    live.peers.set(ws.peerId, ws);
  }

  function recStart(ws, msg) {
    const live = liveRooms.get(ws.roomId); if (!live) return;
    const m = store.meeting(live.meetingId); if (!m) return;
    closeRec(ws);
    const seg = { id: rid(12), pid: ws.peerId, name: ws.name, sub: ws.user?.sub || null, started_at: Date.now(), bytes: 0, mime: String(msg.mime || 'audio/webm').slice(0, 60) };
    m.segments.push(seg);
    fs.mkdirSync(store.audioDir(m.id), { recursive: true, mode: 0o700 });
    ws.rec = { seg, meeting: m, stream: fs.createWriteStream(path.join(store.audioDir(m.id), `${seg.id}.webm`), { flags: 'a', mode: 0o600 }) };
    saveSoon(m);
  }
  function audioIn(ws, buf) {
    const r = ws.rec;
    if (!r || r.meeting.status !== 'live' || r.seg.bytes + buf.length > MAX_SEG_BYTES) return;
    r.stream.write(buf); r.seg.bytes += buf.length; saveSoon(r.meeting);
  }

  // ================= after the meeting: one job at a time =================
  const queue = []; let working = null;
  const stt = deps.stt || ((file, lang) => whisper(file, lang, { url: cfg.STT_URL, token: cfg.GPU_TOKEN, fetchImpl }));
  const llm = deps.llm || ((messages) => qwenJson(messages, { url: cfg.LLM_URL, token: cfg.GPU_TOKEN, model: cfg.LLM_MODEL, fetchImpl }));
  function enqueue(id) { if (!queue.includes(id) && working !== id) queue.push(id); setImmediate(pump); }
  async function linkCalendar(m) {    // best effort: the calendar event (and CRM customer) that carries this room
    if (m.calendar !== undefined) return;
    m.calendar = null;
    const subs = [m.host_sub, ...m.participants.map((p) => p.sub)].filter(Boolean);
    for (const sub of [...new Set(subs)]) {
      const tok = await tokenOf(store.latestSessionFor(sub)).catch(() => null);
      if (!tok) continue;
      try {
        const ev = (await calendarEvents(tok)).find((e) => e?.type === 'calendar' && e.payload?.room_id === m.room);
        if (ev) { m.calendar = { id: ev.id, title: ev.payload.title || null, crm_company: ev.payload.crm_company || null, of: sub }; if (!m.title && ev.payload.title) m.title = ev.payload.title; return; }
      } catch { /* next person */ }
    }
  }
  async function pump() {
    if (working || !queue.length) return;
    const id = queue.shift(); working = id;
    const m = store.meeting(id);
    try {
      if (m) {
        await linkCalendar(m).catch(() => {});
        await processMeeting(store, m, { stt, llm, log });
        log('meeting', id, 'transcribed', m.transcript.length, 'lines', m.language);
      }
    } catch (e) {
      log('meeting', id, 'processing failed:', e.message);
      if (m && store.meeting(id)) {
        m.attempts = (m.attempts || 0) + 1; m.error = String(e.message).slice(0, 300);
        m.status = m.attempts >= 3 ? 'failed' : 'queued'; m.stage = null; store.saveMeeting(m);
        if (m.status === 'queued') setTimeout(() => enqueue(id), (deps.retryMs ?? 5 * 60_000)).unref?.();
      }
    } finally { working = null; setImmediate(pump); }
  }
  function recover() {     // after a restart: meetings that were live are over; unfinished jobs run again
    for (const m of store.allMeetings()) {
      if (m.status === 'live') finish(m, 'server restarted');
      else if (m.status === 'queued' || m.status === 'processing') enqueue(m.id);
    }
  }
  setInterval(() => store.pruneSessions(), 3600_000).unref();

  return { app, attach, store, recover, endMeeting, liveRooms, queue, cfg, idle: () => !working && !queue.length };
}

const THEME_JS = `<script>(function(){var p="system";try{p=localStorage.getItem("osmike-appearance")||"system"}catch(e){}if(["system","light","dark"].indexOf(p)<0)p="system";var m=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)");var r=p==="system"?(m&&m.matches?"dark":"light"):p;var h=document.documentElement;h.setAttribute("data-theme",r);h.style.colorScheme=r;})();</script>`;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { app, attach, recover, cfg, store } = createApp();
  const server = http.createServer(app);
  attach(server);
  recover();
  server.listen(cfg.PORT, () => console.log(`mikeos-meetings on :${cfg.PORT} (data ${cfg.DATA_DIR}, stt ${cfg.STT_URL}, llm ${cfg.LLM_URL}, gpu token ${cfg.GPU_TOKEN ? 'set' : 'MISSING'}, turn ${cfg.TURN_SECRET ? 'on' : 'stun-only'}, media ${cfg.SFU_READY ? cfg.MEDIA : 'mesh (no LiveKit keys)'})`));
  const bye = () => { try { store.flush(); } catch { /* */ } process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}
