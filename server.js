// MikeMeetings — meetings.osmike.com
// Real-time video meetings for MikeOS: WebRTC mesh (peer-to-peer, good for 2-6),
// same-origin WebSocket signaling, and calendar integration with the MikeOS-native
// calendar (mikeos-events). "Sign in with MikeOS Account" (OAuth 2.0 Authorization
// Code + PKCE / S256 against account.osmike.com) — the flow is copied verbatim from
// mikeos-office-web. The signed-in user's access_token is the credential forwarded to
// the calendar backend, so meetings become calendar events owned by the user.
// STUN/TURN is self-hosted (coturn) — zero Google, zero paid services, zero CDNs.
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer } from 'ws';

const {
  PORT = 8095,
  ISSUER = 'https://account.osmike.com',
  CLIENT_ID = 'meetings-web',
  // Prefer the internal docker address on deploy_default; the public host works too.
  CALENDAR_URL = 'http://mikeos-events:8000',
  // Public host the browser can reach for ICE. coturn runs as its own container on 242.
  TURN_HOST = 'meetings.osmike.com',
  TURN_PORT = '3478',
  TURN_SECRET = '',          // if set -> TURN with time-limited REST credentials (RFC 5766 / coturn `use-auth-secret`)
  TURN_REALM = 'meetings.osmike.com',
  COOKIE_SECRET = crypto.randomBytes(24).toString('hex'),
} = process.env;

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser(COOKIE_SECRET));

// ---- tiny in-memory session store (single instance; users re-auth on restart — fine for v1) ----
const sessions = new Map(); // sid -> { access_token, id_token, refresh_token, expires_at, user }
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodeJwt = (jwt) => { try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8')); } catch { return {}; } };
const cookieOpts = { httpOnly: true, secure: true, sameSite: 'lax', signed: true };
const sessionOf = (req) => sessions.get(req.signedCookies.sid);
const redirectUriFor = (req) => `https://${req.hostname}/auth/callback`;

// ============================================================================
// OAuth: Sign in with MikeOS Account (Authorization Code + PKCE / S256)
// Copied verbatim from mikeos-office-web/server.js (login/callback/PKCE/session/me/logout).
// ============================================================================
app.get('/auth/login', (req, res) => {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  res.cookie('pkce', verifier, { ...cookieOpts, maxAge: 10 * 60_000 });
  res.cookie('ostate', state, { ...cookieOpts, maxAge: 10 * 60_000 });
  const u = new URL(`${ISSUER}/oauth/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUriFor(req));
  u.searchParams.set('scope', 'openid profile email');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  res.redirect(u.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  const verifier = req.signedCookies.pkce;
  if (!code || !state || state !== req.signedCookies.ostate || !verifier) {
    return res.status(400).send('Auth state mismatch — <a href="/">back</a>');
  }
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      client_id: CLIENT_ID, redirect_uri: redirectUriFor(req),
    });
    const r = await fetch(`${ISSUER}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!r.ok) { console.warn('token exchange failed', r.status, await r.text()); return res.status(502).send('Sign-in failed — <a href="/">back</a>'); }
    const tok = await r.json();
    const claims = decodeJwt(tok.id_token || tok.access_token || '');
    const user = { sub: claims.sub, email: claims.email, name: claims.name || claims.preferred_username };
    if ((!user.email || !user.name) && tok.access_token) {
      try {
        const ui = await fetch(`${ISSUER}/oauth/userinfo`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
        if (ui.ok) {
          const info = await ui.json();
          user.sub = user.sub || info.sub;
          user.email = user.email || info.email;
          user.name = user.name || info.name || info.preferred_username || info.email;
        }
      } catch { /* best-effort */ }
    }
    if (!user.name) user.name = user.email || 'MikeOS user';
    const sid = b64url(crypto.randomBytes(24));
    sessions.set(sid, {
      access_token: tok.access_token, id_token: tok.id_token, refresh_token: tok.refresh_token,
      expires_at: Date.now() + (tok.expires_in || 3600) * 1000, user,
    });
    res.clearCookie('pkce', cookieOpts); res.clearCookie('ostate', cookieOpts);
    res.cookie('sid', sid, { ...cookieOpts, maxAge: 30 * 24 * 60 * 60_000 });
    res.redirect('/');
  } catch (e) { console.warn('callback error', e); res.status(502).send('Sign-in error — <a href="/">back</a>'); }
});

app.post('/auth/logout', (req, res) => {
  const sid = req.signedCookies.sid; if (sid) sessions.delete(sid);
  res.clearCookie('sid', cookieOpts); res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const s = sessionOf(req);
  res.json(s ? { authenticated: true, user: s.user } : { authenticated: false });
});

// The user's access_token (refreshed on demand) — the credential for mikeos-events.
async function accessTokenFor(req) {
  const s = sessionOf(req);
  if (!s) return null;
  if (Date.now() < s.expires_at - 60_000) return s.access_token;
  if (!s.refresh_token) return s.access_token;
  try {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: CLIENT_ID });
    const r = await fetch(`${ISSUER}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (r.ok) {
      const t = await r.json();
      s.access_token = t.access_token || s.access_token;
      if (t.refresh_token) s.refresh_token = t.refresh_token;
      s.expires_at = Date.now() + (t.expires_in || 3600) * 1000;
    }
  } catch (e) { console.warn('refresh failed', e.message); }
  return s.access_token;
}
const requireAuth = (req, res) => { const s = sessionOf(req); if (!s) { res.status(401).json({ error: 'not_authenticated' }); return null; } return s; };
const bearer = (tok) => ({ Authorization: `Bearer ${tok}` });

// ============================================================================
// ICE server list — self-hosted STUN (+TURN if a secret is configured). No Google.
// ============================================================================
function iceServers() {
  const stunUrl = `stun:${TURN_HOST}:${TURN_PORT}`;
  const list = [{ urls: stunUrl }];
  if (TURN_SECRET) {
    // coturn `use-auth-secret`: username = <unix-ts>:<name>, credential = base64(HMAC-SHA1(secret, username))
    const ttl = 3600;
    const username = `${Math.floor(Date.now() / 1000) + ttl}:meetings`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    list.push({ urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, username, credential });
    list.push({ urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`, username, credential });
  }
  return list;
}
app.get('/api/ice', (req, res) => res.json({ iceServers: iceServers() }));

// ============================================================================
// Calendar integration — meetings as mikeos-events "calendar" events.
// Forward the USER's Bearer so events are user-scoped. NEVER-TRUST-200.
// ============================================================================
const nowIso = () => new Date().toISOString();

// A random, URL-safe room id.
function newRoomId() {
  return b64url(crypto.randomBytes(9)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || crypto.randomBytes(5).toString('hex');
}
const joinUrlFor = (req, roomId) => `https://${req.hostname}/r/${roomId}`;

// Create an instant room (no calendar write — it just exists once someone joins).
app.post('/api/rooms', (req, res) => {
  if (!requireAuth(req, res)) return;
  const roomId = newRoomId();
  res.json({ room_id: roomId, join_url: joinUrlFor(req, roomId) });
});

// Schedule a meeting -> writes a "calendar" event to mikeos-events for the signed-in user.
app.post('/api/meetings', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const tok = await accessTokenFor(req);
  const title = String(req.body?.title || '').trim() || 'MikeOS meeting';
  const start = String(req.body?.start || '').trim();
  const end = String(req.body?.end || '').trim();
  const description = String(req.body?.description || '').slice(0, 2000);
  // Timestamps MUST be ISO-8601. Accept a datetime-local ('YYYY-MM-DDTHH:mm') and normalize.
  const startIso = toIso(start);
  const endIso = end ? toIso(end) : null;
  if (!startIso) return res.status(400).json({ error: 'bad_start', detail: 'start must be a valid date-time' });
  const roomId = newRoomId();
  const joinUrl = joinUrlFor(req, roomId);
  const payload = {
    title, start: startIso, room_id: roomId, join_url: joinUrl, description,
    ...(endIso ? { end: endIso } : {}),
  };
  const event = { app: 'meetings', type: 'calendar', ts: startIso, agent: 'meetings-web', payload };
  try {
    const r = await fetch(`${CALENDAR_URL}/api/events`, {
      method: 'POST', headers: { ...bearer(tok), 'Content-Type': 'application/json' }, body: JSON.stringify(event),
    });
    if (!r.ok) return res.status(502).json({ error: 'calendar_write_failed', status: r.status, detail: (await r.text()).slice(0, 300) });
    // NEVER-TRUST-200: confirm the event is actually listed before reporting success.
    const listed = await listMeetings(tok, { includePast: true });
    const found = listed.find((m) => m.room_id === roomId);
    if (!found) return res.status(502).json({ error: 'calendar_not_persisted' });
    res.json({ saved: true, meeting: found });
  } catch (e) { console.warn('schedule', e.message); res.status(502).json({ error: 'calendar_unreachable', detail: e.message }); }
});

// List the user's upcoming meetings (calendar events with a room_id + future start).
app.get('/api/meetings', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const tok = await accessTokenFor(req);
  try {
    const meetings = await listMeetings(tok, { includePast: false });
    res.json({ meetings });
  } catch (e) { console.warn('list', e.message); res.status(502).json({ error: 'calendar_unreachable', detail: e.message }); }
});

async function listMeetings(tok, { includePast }) {
  const r = await fetch(`${CALENDAR_URL}/api/events`, { headers: bearer(tok) });
  if (!r.ok) throw new Error(`events list ${r.status}`);
  const data = await r.json();
  const events = Array.isArray(data) ? data : (data.events || data.items || []);
  const now = Date.now();
  const out = [];
  for (const ev of events) {
    if (ev?.type !== 'calendar') continue;
    const p = ev.payload || {};
    if (!p.room_id) continue;
    const startMs = Date.parse(p.start || ev.ts || '');
    if (!includePast && Number.isFinite(startMs) && startMs < now - 60 * 60_000) continue; // hide meetings > 1h past
    out.push({
      id: ev.id, title: p.title || 'Meeting', start: p.start || ev.ts,
      end: p.end || null, room_id: p.room_id, join_url: p.join_url, description: p.description || '',
    });
  }
  out.sort((a, b) => (Date.parse(a.start) || 0) - (Date.parse(b.start) || 0));
  return out;
}

// Best-effort ISO-8601 normalizer (accepts full ISO or a datetime-local value).
function toIso(s) {
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

app.get('/healthz', (req, res) => res.json({ ok: true, ice: iceServers().map((s) => s.urls), calendar: CALENDAR_URL }));

// ---- static + SPA fallback (rooms are client-routed at /r/<id>) ----
app.use(express.static('public'));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
  res.sendFile('index.html', { root: 'public' });
});

// ============================================================================
// WebSocket signaling — same origin, path /ws. Relays SDP offers/answers + ICE
// candidates between peers in a room. Mesh topology: when B joins a room where A
// is already present, B is told about A and initiates the offer to A.
// ============================================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const rooms = new Map(); // roomId -> Map<peerId, { ws, name }>
const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* peer gone */ } };

wss.on('connection', (ws) => {
  ws.peerId = b64url(crypto.randomBytes(9));
  ws.roomId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString().slice(0, 200_000)); } catch { return; } // cap message size (RAM)
    switch (msg.type) {
      case 'join': {
        const roomId = String(msg.room || '').slice(0, 64);
        if (!roomId) return;
        ws.roomId = roomId;
        ws.name = String(msg.name || 'Guest').slice(0, 60);
        if (!rooms.has(roomId)) rooms.set(roomId, new Map());
        const room = rooms.get(roomId);
        // Tell the newcomer who is already here (the newcomer initiates offers to them).
        const peers = [...room.entries()].map(([id, p]) => ({ id, name: p.name }));
        send(ws, { type: 'welcome', self: ws.peerId, peers });
        // Announce the newcomer to everyone already present.
        for (const [, p] of room) send(p.ws, { type: 'peer-joined', id: ws.peerId, name: ws.name });
        room.set(ws.peerId, { ws, name: ws.name });
        break;
      }
      case 'signal': {
        // Relay an SDP/ICE payload to a specific peer in the same room.
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const target = room.get(String(msg.to || ''));
        if (!target) return;
        send(target.ws, { type: 'signal', from: ws.peerId, name: ws.name, data: msg.data });
        break;
      }
      case 'leave':
        cleanup(ws);
        break;
      default:
        break;
    }
  });

  ws.on('close', () => cleanup(ws));
  ws.on('error', () => cleanup(ws));
});

function cleanup(ws) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  if (room.has(ws.peerId)) {
    room.delete(ws.peerId);
    for (const [, p] of room) send(p.ws, { type: 'peer-left', id: ws.peerId });
  }
  if (room.size === 0) rooms.delete(ws.roomId);
  ws.roomId = null;
}

// Heartbeat: drop dead sockets so rosters stay clean.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { cleanup(ws); ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30_000);

server.listen(PORT, () => console.log(`mikeos-meetings on :${PORT} (issuer ${ISSUER}, client ${CLIENT_ID}, calendar ${CALENDAR_URL}, turn ${TURN_SECRET ? 'on' : 'stun-only'})`));
