// Screen sharing (SFU rooms): everyone may share and the server logs it; only the host can stop someone else's share.
// A host stop tells the sharer's browser to stop and mutes exactly that person's screen-share tracks in LiveKit
// (GetParticipant -> MutePublishedTrack on SCREEN_SHARE + SCREEN_SHARE_AUDIO, never the camera or microphone).
// Others (signed in or guest) are refused, a mesh room never calls LiveKit, and recording is untouched by sharing.
// Needs ffmpeg (run inside the image: docker run --rm mikeos-meetings:test node --test test/).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { createApp } from '../server.js';

const ISSUER = 'https://account.test';
const USERS = { codeA: { tok: 'tokA', sub: 'sub-a', email: 'a@osmike.com', name: 'Anna Andersson' },
  codeB: { tok: 'tokB', sub: 'sub-b', email: 'b@osmike.com', name: 'Bo Berg' } };
const BY_TOK = Object.fromEntries(Object.values(USERS).map((u) => [u.tok, u]));
const LK = { LIVEKIT_URL: 'wss://lk.test', LIVEKIT_API_KEY: 'APItest', LIVEKIT_API_SECRET: 'secret-for-tests-only-0123456789abcdef' };
const realFetch = fetch;
const lkCalls = [];
async function fakeFetch(url, opts = {}) {
  url = String(url);
  if (url === `${ISSUER}/oauth/token`) {
    const u = USERS[new URLSearchParams(String(opts.body)).get('code')]; if (!u) return new Response('{}', { status: 400 });
    return Response.json({ access_token: u.tok, refresh_token: 'r', expires_in: 3600 });
  }
  if (url === `${ISSUER}/oauth/userinfo`) {
    const u = BY_TOK[(opts.headers?.Authorization || '').replace('Bearer ', '')];
    return u ? Response.json({ sub: u.sub, email: u.email, name: u.name }) : new Response('{}', { status: 401 });
  }
  if (url.startsWith('http://cal.test/')) return Response.json({ events: [] });
  if (url.startsWith('https://lk.test/twirp/livekit.RoomService/')) {
    const method = url.split('/').pop(), body = JSON.parse(opts.body);
    lkCalls.push({ method, auth: opts.headers?.Authorization, body });
    if (method === 'GetParticipant') {
      return Response.json({ identity: body.identity, tracks: [
        { sid: 'TR_mic', type: 'AUDIO', source: 'MICROPHONE' }, { sid: 'TR_cam', type: 'VIDEO', source: 'CAMERA' },
        { sid: 'TR_scr', type: 'VIDEO', source: 'SCREEN_SHARE', name: 'screen:browser' }, { sid: 'TR_sa', type: 'AUDIO', source: 'SCREEN_SHARE_AUDIO' }] });
    }
    return Response.json({});
  }
  return realFetch(url, opts);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-share-'));
const tone = path.join(dir, 'tone.webm');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'libopus', '-b:a', '32k', tone]);
const logs = [];
const env = { ISSUER, DATA_DIR: dir, INSECURE_COOKIES: '1', END_GRACE_MS: '200', CALENDAR_URL: 'http://cal.test', PUBLIC_HOST: 'meet.test', MEETINGS_MEDIA: 'sfu', ...LK };
const M = createApp(env, { fetch: fakeFetch, stt: async () => ({ language: 'sv', segments: [] }), llm: async () => ({ overview: '' }), log: (...a) => logs.push(a.join(' ')), retryMs: 10 });
const server = http.createServer(M.app); M.attach(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50); });

const jar = (h) => (h.getSetCookie?.() || []).map((c) => c.split(';')[0]);
async function login(code) {
  let r = await realFetch(`${base}/auth/login`, { redirect: 'manual' });
  const pre = jar(r.headers).find((c) => c.startsWith('meetings-pre='));
  const state = new URL(r.headers.get('location')).searchParams.get('state');
  r = await realFetch(`${base}/auth/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: { cookie: pre } });
  return { cookie: jar(r.headers).find((c) => c.startsWith('meetings-sid=')) };
}
const wsOpen = (c) => new Promise((res) => { const w = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: c ? { cookie: c.cookie } : {} });
  w.msgs = []; w.on('message', (d, bin) => { if (!bin) w.msgs.push(JSON.parse(d)); }); w.on('open', () => res(w)); });
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const join = async (c, room, name, extra = {}) => { const w = await wsOpen(c); w.send(JSON.stringify({ type: 'join', room, name, ...extra }));
  w.wel = await waitFor(() => w.msgs.find((m) => m.type === 'welcome')); return w; };
const result = (w, target) => waitFor(() => w.msgs.find((m) => m.type === 'stop-share-result' && m.target === target));
const jwtClaims = (tok) => { const [h, p, sig] = tok.split('.');
  assert.equal(sig, crypto.createHmac('sha256', LK.LIVEKIT_API_SECRET).update(`${h}.${p}`).digest('base64url'));
  return JSON.parse(Buffer.from(p, 'base64url')); };

test('everyone may share (the server logs it); only the host stops someone else\'s share, in the SFU and in their browser', async () => {
  const A = await login('codeA'), B = await login('codeB');
  const host = await join(A, 'shareRoom');                     // first signed-in person in an unregistered room hosts
  const bo = await join(B, 'shareRoom');
  const guest = await join(null, 'shareRoom', 'Gustav Gäst');
  assert.equal(host.wel.is_host, true); assert.equal(bo.wel.is_host, false); assert.equal(guest.wel.media, 'sfu');
  // recording keeps going while people share (share messages never touch it)
  host.send(JSON.stringify({ type: 'rec-start', mime: 'audio/webm' }));
  await waitFor(() => host.msgs.find((m) => m.type === 'rec-ok'));
  guest.send(JSON.stringify({ type: 'share', on: true, kind: 'browser', audio: true }));
  host.send(JSON.stringify({ type: 'share', on: true, kind: 'monitor' }));
  const b = fs.readFileSync(tone); for (let i = 0; i < b.length; i += 4000) host.send(b.subarray(i, i + 4000));
  await waitFor(() => logs.some((l) => l.includes('share started (browser + tab audio)') && l.includes('Gustav Gäst')));
  await waitFor(() => logs.some((l) => l.includes('share started (monitor)') && l.includes('Anna Andersson')));

  // a signed-in participant who is not the host: refused, nothing happens in the SFU or to the sharer
  const n0 = lkCalls.length;
  bo.send(JSON.stringify({ type: 'stop-share', target: guest.wel.self }));
  assert.deepEqual(await result(bo, guest.wel.self), { type: 'stop-share-result', target: guest.wel.self, ok: false, error: 'only_the_host_can_stop_shares' });
  // a guest: refused too (a guest is never the host)
  guest.send(JSON.stringify({ type: 'stop-share', target: host.wel.self }));
  assert.equal((await result(guest, host.wel.self)).error, 'only_the_host_can_stop_shares');
  await sleep(100);
  assert.equal(lkCalls.length, n0, 'no LiveKit call for a refused stop');
  assert.ok(!guest.msgs.some((m) => m.type === 'share-stopped') && !host.msgs.some((m) => m.type === 'share-stopped'));

  // the host: the sharer's browser is told, and exactly the screen tracks are muted in the SFU
  host.send(JSON.stringify({ type: 'stop-share', target: guest.wel.self }));
  const r = await result(host, guest.wel.self);
  assert.equal(r.ok, true); assert.equal(r.muted, 2); assert.equal(r.name, 'Gustav Gäst');
  assert.equal(guest.msgs.find((m) => m.type === 'share-stopped').by, 'Anna Andersson');
  assert.ok(!bo.msgs.some((m) => m.type === 'share-stopped'), 'only the sharer is told');
  const calls = lkCalls.slice(n0);
  assert.equal(calls[0].method, 'GetParticipant'); assert.deepEqual(calls[0].body, { room: host.wel.meeting, identity: guest.wel.self });
  const mutes = calls.filter((c) => c.method === 'MutePublishedTrack');
  assert.deepEqual(mutes.map((c) => c.body.track_sid).sort(), ['TR_sa', 'TR_scr'], 'screen video + tab audio, never camera or microphone');
  assert.ok(mutes.every((c) => c.body.muted === true && c.body.identity === guest.wel.self && c.body.room === host.wel.meeting));
  const adm = jwtClaims(mutes[0].auth.slice(7));
  assert.equal(adm.video.roomAdmin, true); assert.equal(adm.video.room, host.wel.meeting);
  assert.ok(logs.some((l) => l.includes('stopped by the host Anna Andersson') && l.includes('(2 tracks muted in the SFU)')));

  // nonsense targets: not in the meeting, or the host's own share (the host stops that with their own Stop)
  host.send(JSON.stringify({ type: 'stop-share', target: 'nobody' }));
  assert.equal((await result(host, 'nobody')).error, 'not_in_meeting');
  host.send(JSON.stringify({ type: 'stop-share', target: host.wel.self }));
  assert.equal((await result(host, host.wel.self)).error, 'not_in_meeting');
  // someone outside any meeting gets nothing at all
  const stranger = await wsOpen(null); stranger.send(JSON.stringify({ type: 'stop-share', target: guest.wel.self }));
  await sleep(100); assert.equal(stranger.msgs.length, 0); stranger.close();

  host.send(JSON.stringify({ type: 'share', on: false, why: 'stopped in the browser' }));   // the browser's own Stop sharing
  await waitFor(() => logs.some((l) => l.includes('share stopped (stopped in the browser)') && l.includes('Anna Andersson')));
  const n1 = logs.length; guest.send(JSON.stringify({ type: 'share', on: false, why: 'stopped by the host' }));
  await sleep(80); assert.equal(logs.length, n1, 'the guest was already marked stopped by the host stop: no second log line');
  host.send(JSON.stringify({ type: 'end-meeting' }));
  const m = await waitFor(() => { const x = M.store.meeting(host.wel.meeting); return x && x.status !== 'live' ? x : null; });
  const seg = m.segments.find((s) => s.name === 'Anna Andersson');
  assert.ok(seg && seg.bytes > 2000, 'the host\'s microphone was recorded while sharing');
  assert.equal(m.segments.length, 1, 'sharing creates no recording of its own');
  for (const w of [host, bo, guest]) w.close();
});

test('mesh room: the host stop is refused with not_sfu and LiveKit is never called', async () => {
  const A = await login('codeA');
  const host = await join(A, 'meshShare', '', { media: 'mesh' });
  const g = await join(null, 'meshShare', 'Gäst');
  assert.equal(host.wel.media, 'mesh');
  const n0 = lkCalls.length;
  host.send(JSON.stringify({ type: 'stop-share', target: g.wel.self }));
  assert.equal((await result(host, g.wel.self)).error, 'not_sfu');
  assert.equal(lkCalls.length, n0);
  assert.ok(!g.msgs.some((m) => m.type === 'share-stopped'));
  host.close(); g.close();
});
