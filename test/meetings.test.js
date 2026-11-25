// Offline tests: login flow, guest names, recording over the socket, end of meeting -> transcript + summary,
// owner-only visibility (404 for others), agent API, host delete, guest-only meetings keep nothing.
// Needs ffmpeg (run inside the image: docker run --rm mikeos-meetings:test node --test test/).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { createApp } from '../server.js';
import { buildTranscript, mainLanguage, cleanSegments, summarize, normSummary, transcriptText } from '../lib/pipeline.js';

const ISSUER = 'https://account.test';
const USERS = { codeA: { tok: 'tokA', sub: 'sub-a', email: 'a@osmike.com', name: 'Anna Andersson' },
  codeB: { tok: 'tokB', sub: 'sub-b', email: 'b@osmike.com', name: 'Bo Berg' } };
const BY_TOK = Object.fromEntries(Object.values(USERS).map((u) => [u.tok, u]));
const realFetch = fetch;
async function fakeFetch(url, opts = {}) {
  url = String(url);
  if (url === `${ISSUER}/oauth/token`) {
    const code = new URLSearchParams(String(opts.body)).get('code');
    const u = USERS[code]; if (!u) return new Response('{}', { status: 400 });
    return Response.json({ access_token: u.tok, refresh_token: 'r-' + u.tok, expires_in: 3600 });
  }
  if (url === `${ISSUER}/oauth/userinfo`) {
    const u = BY_TOK[(opts.headers?.Authorization || '').replace('Bearer ', '')];
    return u ? Response.json({ sub: u.sub, email: u.email, name: u.name }) : new Response('{}', { status: 401 });
  }
  if (url.startsWith('http://cal.test/api/events')) {
    return Response.json({ events: [{ id: 'ev1', type: 'calendar', payload: { title: 'Planering', room_id: 'roomOne', join_url: 'x', crm_company: 'c9' } }] });
  }
  return realFetch(url, opts);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-'));
const wav = path.join(dir, 'tone.webm');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-af', 'volume=-6dB', '-c:a', 'libopus', '-b:a', '32k', wav]);
const silent = path.join(dir, 'silent.webm');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '6', '-c:a', 'libopus', silent]);

const sttCalls = [];
const stt = async (file, lang) => { sttCalls.push({ file: path.basename(file), lang });
  return { language: lang || 'sv', segments: [{ start: 0.5, end: 2, text: 'Vi bestämmer att lansera den nya webbplatsen på fredag och Anna skriver pressmeddelandet till torsdag så att alla hinner läsa.' }, { start: 2.2, end: 3, text: 'Tack för att du tittade!' }] }; };
const llmCalls = [];
const llm = async (messages) => { llmCalls.push(messages); return { overview: 'Lansering på fredag.', key_points: ['Lansering'], decisions: ['Lansera fredag'], action_items: [{ owner: 'Anna Andersson', task: 'Skriv pressmeddelande', due: 'torsdag' }] }; };

const env = { ISSUER, DATA_DIR: dir, INSECURE_COOKIES: '1', END_GRACE_MS: '150', CALENDAR_URL: 'http://cal.test', PUBLIC_HOST: 'meet.test' };
const M = createApp(env, { fetch: fakeFetch, stt, llm, log: () => {}, retryMs: 10 });
const server = http.createServer(M.app); M.attach(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50); });

const jar = (h) => (h.getSetCookie?.() || []).map((c) => c.split(';')[0]);
async function login(code) {
  let r = await realFetch(`${base}/auth/login?next=/past`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const pre = jar(r.headers).find((c) => c.startsWith('meetings-pre='));
  const state = new URL(r.headers.get('location')).searchParams.get('state');
  r = await realFetch(`${base}/auth/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: { cookie: pre } });
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/past');
  const sid = jar(r.headers).find((c) => c.startsWith('meetings-sid='));
  const me = await (await realFetch(`${base}/api/me`, { headers: { cookie: sid } })).json();
  return { cookie: sid, csrf: me.csrf, me };
}
const get = (u, c) => realFetch(base + u, { headers: c ? { cookie: c.cookie } : {}, redirect: 'manual' });
const wsOpen = (c) => new Promise((res) => { const w = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: c ? { cookie: c.cookie } : {} });
  w.msgs = []; w.on('message', (d, bin) => { if (!bin) w.msgs.push(JSON.parse(d)); }); w.on('open', () => res(w)); });
const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 40)); } throw new Error('timeout'); };
async function sendFile(w, file) { const b = fs.readFileSync(file); for (let i = 0; i < b.length; i += 4000) w.send(b.subarray(i, i + 4000)); }

let A, B;
test('login: identity from userinfo; a callback from another browser is refused', async () => {
  A = await login('codeA'); B = await login('codeB');
  assert.equal(A.me.user.name, 'Anna Andersson'); assert.ok(A.csrf);
  const r = await realFetch(`${base}/auth/login`, { redirect: 'manual' });
  const state = new URL(r.headers.get('location')).searchParams.get('state');
  const bad = await realFetch(`${base}/auth/callback?code=codeB&state=${state}`, { redirect: 'manual', headers: { cookie: 'meetings-pre=other' } });
  assert.equal(bad.status, 400);
});

let meetingId;
test('guest must give a name; meeting records both, ends when everyone left, then transcript + summary', async () => {
  const room = 'roomOne';
  const host = await wsOpen(A);
  host.send(JSON.stringify({ type: 'join', room, name: 'ignored for signed-in' }));
  const wel = await waitFor(() => host.msgs.find((m) => m.type === 'welcome'));
  assert.equal(wel.name, 'Anna Andersson'); assert.equal(wel.recorded, true); assert.equal(wel.is_host, true);
  meetingId = wel.meeting;
  const g = await wsOpen(null);
  g.send(JSON.stringify({ type: 'join', room, name: '   ' }));
  assert.equal((await waitFor(() => g.msgs.find((m) => m.type === 'error'))).error, 'name_required');
  g.send(JSON.stringify({ type: 'join', room, name: '  Gäst  Gustav <x>' }));
  const gw = await waitFor(() => g.msgs.find((m) => m.type === 'welcome'));
  assert.equal(gw.name, 'Gäst Gustav x'); assert.equal(gw.is_host, false);
  assert.equal(gw.peers[0].name, 'Anna Andersson');
  host.send(JSON.stringify({ type: 'rec-start', mime: 'audio/webm' })); g.send(JSON.stringify({ type: 'rec-start', mime: 'audio/webm' }));
  await new Promise((r) => setTimeout(r, 50));
  await sendFile(host, wav); await sendFile(g, wav);
  // a guest cannot end the meeting for everyone
  g.send(JSON.stringify({ type: 'end-meeting' }));
  assert.equal((await waitFor(() => g.msgs.find((m) => m.error === 'only_the_host_can_end'))).type, 'error');
  await new Promise((r) => setTimeout(r, 150));
  g.close(); host.close();
  const m = await waitFor(() => { const x = M.store.meeting(meetingId); return x && x.status === 'done' ? x : null; });
  assert.equal(m.language, 'sv');
  assert.ok(m.transcript.length >= 2);
  assert.deepEqual(new Set(m.transcript.map((l) => l.speaker)), new Set(['Anna Andersson', 'Gäst Gustav x']));
  assert.ok(!m.transcript.some((l) => /tittade/.test(l.text)), 'whisper silence hallucination dropped');
  assert.equal(m.summary.decisions[0], 'Lansera fredag');
  assert.equal(m.calendar.id, 'ev1'); assert.equal(m.title, 'Planering');
  assert.ok(llmCalls[0][0].content.includes('Swedish'));
});

test('previous meetings: participants see it, others get 404', async () => {
  const list = await (await get('/api/past', A)).json();
  assert.equal(list.meetings[0].id, meetingId);
  assert.deepEqual(list.meetings[0].people.map((p) => p.name), ['Anna Andersson', 'Gäst Gustav x']);
  const d = await (await get(`/api/past/${meetingId}`, A)).json();
  assert.equal(d.summary.action_items[0].owner, 'Anna Andersson');
  assert.equal(d.calendar.crm_url, 'https://crm.osmike.com/c/c9');
  assert.ok(!JSON.stringify(d).includes('sub-a'), 'no account ids leak');
  assert.equal((await get(`/api/past/${meetingId}`, B)).status, 404);
  assert.equal((await (await get('/api/past', B)).json()).meetings.length, 0);
  assert.equal((await get(`/m/${meetingId}`, B)).status, 404);
  assert.equal((await get(`/m/${meetingId}`, A)).status, 200);
  const anon = await get(`/m/${meetingId}`, null);
  assert.equal(anon.status, 302); assert.match(anon.headers.get('location'), /^\/auth\/login\?next=%2Fm%2F/);
  assert.equal((await get(`/api/past/${meetingId}`, null)).status, 401);
  assert.equal((await (await get(`/api/past?q=fredag`, A)).json()).meetings.length, 1);
  assert.equal((await (await get(`/api/past?q=nothing-like-this`, A)).json()).meetings.length, 0);
});

test('agent API: the person behind the token only', async () => {
  const la = await (await realFetch(`${base}/api/agent/meetings`, { headers: { Authorization: 'Bearer tokA' } })).json();
  assert.equal(la.meetings[0].id, meetingId);
  const one = await (await realFetch(`${base}/api/agent/meetings/${meetingId}`, { headers: { Authorization: 'Bearer tokA' } })).json();
  assert.ok(one.transcript.length);
  assert.equal((await realFetch(`${base}/api/agent/meetings/${meetingId}`, { headers: { Authorization: 'Bearer tokB' } })).status, 404);
  assert.equal((await realFetch(`${base}/api/agent/meetings`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
});

test('only the host deletes, and only with the CSRF header', async () => {
  assert.equal((await realFetch(`${base}/api/past/${meetingId}`, { method: 'DELETE', headers: { cookie: A.cookie } })).status, 403);
  assert.equal((await realFetch(`${base}/api/past/${meetingId}`, { method: 'DELETE', headers: { cookie: B.cookie, 'x-csrf': B.csrf } })).status, 404);
  const ok = await realFetch(`${base}/api/past/${meetingId}`, { method: 'DELETE', headers: { cookie: A.cookie, 'x-csrf': A.csrf } });
  assert.equal(ok.status, 200);
  assert.equal(fs.existsSync(path.join(dir, 'meetings', meetingId)), false);
});

test('host ends the meeting for everyone; silence gives no transcript', async () => {
  const host = await wsOpen(A);
  host.send(JSON.stringify({ type: 'join', room: 'roomTwo' }));
  const wel = await waitFor(() => host.msgs.find((m) => m.type === 'welcome'));
  const other = await wsOpen(B); other.send(JSON.stringify({ type: 'join', room: 'roomTwo' }));
  await waitFor(() => other.msgs.find((m) => m.type === 'welcome'));
  other.send(JSON.stringify({ type: 'rec-start' })); await new Promise((r) => setTimeout(r, 30));
  await sendFile(other, silent);
  await new Promise((r) => setTimeout(r, 100));
  const before = sttCalls.length;
  host.send(JSON.stringify({ type: 'end-meeting' }));
  assert.equal((await waitFor(() => other.msgs.find((m) => m.type === 'ended'))).by, 'ended by Anna Andersson');
  const m = await waitFor(() => { const x = M.store.meeting(wel.meeting); return x && x.status === 'done' ? x : null; });
  assert.equal(sttCalls.length, before, 'silent audio is not sent to speech-to-text');
  assert.equal(m.transcript.length, 0);
  assert.ok(m.summary.short);
  assert.equal((await get(`/api/past/${wel.meeting}`, B)).status, 200, 'the other signed-in participant sees it too');
});

test('a meeting with only guests keeps nothing', async () => {
  const g = await wsOpen(null); g.send(JSON.stringify({ type: 'join', room: 'roomThree', name: 'Solo' }));
  const wel = await waitFor(() => g.msgs.find((m) => m.type === 'welcome'));
  g.close();
  await waitFor(() => !M.liveRooms.has('roomThree'));
  assert.equal(M.store.meeting(wel.meeting), null);
  assert.equal(fs.existsSync(path.join(dir, 'meetings', wel.meeting)), false);
});

test('the last person pressing Leave ends the meeting (not only closing the tab)', async () => {
  const g = await wsOpen(null); g.send(JSON.stringify({ type: 'join', room: 'roomFour', name: 'Leaver' }));
  const wel = await waitFor(() => g.msgs.find((m) => m.type === 'welcome'));
  g.send(JSON.stringify({ type: 'leave' }));
  await waitFor(() => !M.liveRooms.has('roomFour'));
  assert.equal(M.store.meeting(wel.meeting), null);
  g.close();
});

test('pipeline helpers', async () => {
  const t = buildTranscript([
    { t0: 1000, offset: 0, speaker: 'A', segments: [{ start: 0, end: 1, text: 'Hej' }, { start: 1.5, end: 2, text: 'alla' }] },
    { t0: 1500, offset: 0, speaker: 'B', segments: [{ start: 2, end: 3, text: 'Hallå' }] }]);
  assert.deepEqual(t.map((l) => [l.speaker, l.text]), [['A', 'Hej alla'], ['B', 'Hallå']]);
  assert.equal(mainLanguage([{ language: 'en', segments: [{ start: 0, end: 2 }] }, { language: 'sv', segments: [{ start: 0, end: 30 }] }]), 'sv');
  assert.equal(cleanSegments([{ text: 'Textning.nu' }, { text: 'Bra' }, { text: '' }]).length, 1);
  assert.deepEqual(normSummary({ key_points: 'x', action_items: ['Do it'] }).action_items, [{ owner: '', task: 'Do it', due: '' }]);
  // long meetings are summarised in parts, then combined
  const lines = Array.from({ length: 900 }, (_, i) => ({ at: i * 1000, end: i * 1000 + 900, speaker: 'A', text: 'ord '.repeat(10) + i }));
  const calls = [];
  const s = await summarize({ started_at: 0, transcript: lines, language: 'en', participants: [{ name: 'A' }] }, async (m) => { calls.push(m); return { overview: 'x' }; });
  assert.ok(calls.length >= 3, 'parts + combine'); assert.equal(s.overview, 'x');
  assert.ok(calls.every((c) => c[1].content.length < 30000));
  assert.match(transcriptText({ started_at: 0, transcript: [{ at: 61000, speaker: 'A', text: 'hi' }] }), /^\[00:01:01\] A: hi$/);
});

// ================= SFU path (LiveKit): token per join, one media path per room, the socket stays the authority =================
const LK = { LIVEKIT_URL: 'wss://lk.test', LIVEKIT_API_KEY: 'APItest', LIVEKIT_API_SECRET: 'secret-for-tests-only-0123456789abcdef' };
const lkCalls = [];
const lkFetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://lk.test/twirp/')) { lkCalls.push({ method: String(url).split('/').pop(), auth: opts.headers?.Authorization, body: JSON.parse(opts.body) }); return Response.json({}); }
  return fakeFetch(url, opts);
};
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-sfu-'));
const M2 = createApp({ ...env, ...LK, DATA_DIR: dir2, MEETINGS_MEDIA: 'sfu' }, { fetch: lkFetch, stt, llm, log: () => {}, retryMs: 10 });
const server2 = http.createServer(M2.app); M2.attach(server2);
await new Promise((r) => server2.listen(0, '127.0.0.1', r));
const base2 = `http://127.0.0.1:${server2.address().port}`;
test.after(() => { server2.close(); fs.rmSync(dir2, { recursive: true, force: true }); });
const ws2 = (c) => new Promise((res) => { const w = new WebSocket(base2.replace('http', 'ws') + '/ws', { headers: c ? { cookie: c.cookie } : {} });
  w.msgs = []; w.on('message', (d, bin) => { if (!bin) w.msgs.push(JSON.parse(d)); }); w.on('open', () => res(w)); });
function verifyJwt(tok, secret) {
  const [h, p, sig] = tok.split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'HS256');
  const want = (crypto => crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url'))(globalThis.__crypto);
  assert.equal(sig, want, 'signed with the API secret');
  return JSON.parse(Buffer.from(p, 'base64url'));
}
globalThis.__crypto = (await import('node:crypto')).default;

test('flag: no LiveKit keys means mesh, even with MEETINGS_MEDIA=sfu', async () => {
  const M3 = createApp({ ...env, DATA_DIR: dir2, MEETINGS_MEDIA: 'sfu' }, { fetch: fakeFetch, stt, llm, log: () => {} });
  assert.equal(M3.cfg.SFU_READY, false);
  assert.equal(M.cfg.MEDIA, 'mesh', 'the default stays mesh');
  assert.equal((await (await realFetch(`${base}/api/room/abc`)).json()).media, 'mesh');
  assert.equal((await (await realFetch(`${base2}/api/room/abc`)).json()).media, 'sfu');
  assert.equal((await (await realFetch(`${base2}/healthz`)).json()).media, 'sfu');
});

test('SFU: a short-lived token per join (identity = peer id, name decided by the server, room = the meeting)', async () => {
  // M2 logins go through M2's own routes
  const login2 = async (code) => {
    let r = await realFetch(`${base2}/auth/login`, { redirect: 'manual' });
    const pre = jar(r.headers).find((c) => c.startsWith('meetings-pre='));
    const state = new URL(r.headers.get('location')).searchParams.get('state');
    r = await realFetch(`${base2}/auth/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: { cookie: pre } });
    return { cookie: jar(r.headers).find((c) => c.startsWith('meetings-sid=')) };
  };
  const A2 = await login2('codeA');
  const host = await ws2(A2); host.send(JSON.stringify({ type: 'join', room: 'sfuRoom', name: 'x' }));
  const wel = await waitFor(() => host.msgs.find((m) => m.type === 'welcome'));
  assert.equal(wel.media, 'sfu'); assert.equal(wel.sfu.url, 'wss://lk.test');
  const c = verifyJwt(wel.sfu.token, LK.LIVEKIT_API_SECRET);
  assert.equal(c.iss, 'APItest'); assert.equal(c.sub, wel.self); assert.equal(c.name, 'Anna Andersson');
  assert.equal(c.video.room, wel.meeting); assert.equal(c.video.roomJoin, true); assert.equal(c.video.canPublish, true);
  assert.ok(!c.video.roomAdmin, 'participants never get admin rights');
  assert.ok(c.exp - Math.floor(Date.now() / 1000) <= 600 && c.exp > c.nbf);
  const g = await ws2(null); g.send(JSON.stringify({ type: 'join', room: 'sfuRoom', name: ' Gäst <b>Gustav ', media: 'mesh' }));
  const gw = await waitFor(() => g.msgs.find((m) => m.type === 'welcome'));
  assert.equal(gw.media, 'sfu', 'a later joiner cannot switch the room to mesh');
  const gc = verifyJwt(gw.sfu.token, LK.LIVEKIT_API_SECRET);
  assert.equal(gc.name, 'Gäst bGustav'); assert.equal(gc.video.room, wel.meeting); assert.notEqual(gc.sub, c.sub);
  // a fresh token for reconnecting, only for someone in the meeting
  g.send(JSON.stringify({ type: 'media-token' }));
  const mt = await waitFor(() => g.msgs.find((m) => m.type === 'media-token'));
  assert.equal(verifyJwt(mt.token, LK.LIVEKIT_API_SECRET).sub, gw.self);
  const stranger = await ws2(null); stranger.send(JSON.stringify({ type: 'media-token' }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(stranger.msgs.length, 0); stranger.close();
  // recording still goes over the socket in an SFU room
  host.send(JSON.stringify({ type: 'rec-start', mime: 'audio/webm' })); await new Promise((r) => setTimeout(r, 30));
  await sendFile(host, wav);
  await new Promise((r) => setTimeout(r, 100));
  g.send(JSON.stringify({ type: 'leave' }));
  await waitFor(() => lkCalls.find((x) => x.method === 'RemoveParticipant' && x.body.identity === gw.self));
  const adm = verifyJwt(lkCalls.find((x) => x.method === 'RemoveParticipant').auth.slice(7), LK.LIVEKIT_API_SECRET);
  assert.equal(adm.video.roomAdmin, true); assert.equal(adm.video.room, wel.meeting);
  host.send(JSON.stringify({ type: 'end-meeting' }));
  await waitFor(() => lkCalls.find((x) => x.method === 'DeleteRoom' && x.body.room === wel.meeting));
  const m = await waitFor(() => { const x = M2.store.meeting(wel.meeting); return x && x.status === 'done' ? x : null; });
  assert.ok(m.transcript.length >= 1); assert.equal(m.transcript[0].speaker, 'Anna Andersson');
  host.close(); g.close();
});

test('SFU server, ?media=mesh for one room: the whole room stays mesh (no tokens)', async () => {
  const a = await ws2(null); a.send(JSON.stringify({ type: 'join', room: 'meshRoom', name: 'Ett', media: 'mesh' }));
  const w1 = await waitFor(() => a.msgs.find((m) => m.type === 'welcome'));
  assert.equal(w1.media, 'mesh'); assert.equal(w1.sfu, undefined);
  const b = await ws2(null); b.send(JSON.stringify({ type: 'join', room: 'meshRoom', name: 'Två', media: 'sfu' }));
  const w2 = await waitFor(() => b.msgs.find((m) => m.type === 'welcome'));
  assert.equal(w2.media, 'mesh'); assert.equal(w2.sfu, undefined);
  assert.equal((await (await realFetch(`${base2}/api/room/meshRoom`)).json()).media, 'mesh');
  const n = lkCalls.length; a.close(); b.close();
  await waitFor(() => !M2.liveRooms.has('meshRoom'));
  assert.equal(lkCalls.length, n, 'a mesh room never calls LiveKit');
});

test('a dropped socket resumes the same place (same peer id, no peer-left, a new recording segment)', async () => {
  const a = await ws2(null); a.send(JSON.stringify({ type: 'join', room: 'resumeRoom', name: 'Ada' }));
  const wa = await waitFor(() => a.msgs.find((m) => m.type === 'welcome'));
  const b = await ws2(null); b.send(JSON.stringify({ type: 'join', room: 'resumeRoom', name: 'Bea' }));
  const wb = await waitFor(() => b.msgs.find((m) => m.type === 'welcome'));
  assert.ok(wb.resume && wb.resume.length >= 20);
  b.terminate();                                         // no Leave: the network dropped
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!a.msgs.some((m) => m.type === 'peer-left'), 'the others are not told while the place is held');
  // a wrong key does not take the place
  const x = await ws2(null); x.send(JSON.stringify({ type: 'join', room: 'resumeRoom', name: 'Bea', resume: 'x'.repeat(wb.resume.length), pid: wb.self }));
  await waitFor(() => x.msgs.find((m) => m.type === 'resume-failed')); x.close();
  const b2 = await ws2(null); b2.send(JSON.stringify({ type: 'join', room: 'resumeRoom', name: 'Bea', resume: wb.resume, pid: wb.self }));
  const w2 = await waitFor(() => b2.msgs.find((m) => m.type === 'welcome'));
  assert.equal(w2.resumed, true); assert.equal(w2.self, wb.self); assert.equal(w2.meeting, wa.meeting); assert.equal(w2.media, 'sfu');
  assert.equal(verifyJwt(w2.sfu.token, LK.LIVEKIT_API_SECRET).sub, wb.self, 'same SFU identity');
  assert.ok(!lkCalls.some((c) => c.method === 'RemoveParticipant' && c.body.identity === wb.self), 'not removed from the SFU');
  const m = M2.store.meeting(wa.meeting);
  assert.equal(m.participants.filter((p) => p.name === 'Bea').length, 1); assert.equal(m.participants.find((p) => p.name === 'Bea').left_at, null);
  // the resumed socket can end, leave and get tokens like before
  b2.send(JSON.stringify({ type: 'media-token' })); await waitFor(() => b2.msgs.find((m) => m.type === 'media-token'));
  b2.send(JSON.stringify({ type: 'leave' }));
  await waitFor(() => a.msgs.find((m) => m.type === 'peer-left' && m.id === wb.self));
  a.close(); b2.close();
  await waitFor(() => !M2.liveRooms.has('resumeRoom'));
});

test('a dropped socket that does not come back is gone after the hold; resuming an ended meeting says ended', async () => {
  const M4dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-res-'));
  const M4 = createApp({ ...env, ...LK, DATA_DIR: M4dir, MEETINGS_MEDIA: 'sfu', RESUME_MS: '120', END_GRACE_MS: '400' }, { fetch: lkFetch, stt, llm, log: () => {} });
  const s4 = http.createServer(M4.app); M4.attach(s4); await new Promise((r) => s4.listen(0, '127.0.0.1', r));
  const u = `ws://127.0.0.1:${s4.address().port}/ws`;
  const o = () => new Promise((res) => { const w = new WebSocket(u); w.msgs = []; w.on('message', (d, bin) => { if (!bin) w.msgs.push(JSON.parse(d)); }); w.on('open', () => res(w)); });
  const a = await o(); a.send(JSON.stringify({ type: 'join', room: 'holdRoom', name: 'Ada' })); await waitFor(() => a.msgs.find((m) => m.type === 'welcome'));
  const b = await o(); b.send(JSON.stringify({ type: 'join', room: 'holdRoom', name: 'Bea' })); const wb = await waitFor(() => b.msgs.find((m) => m.type === 'welcome'));
  b.terminate();
  await waitFor(() => a.msgs.find((m) => m.type === 'peer-left' && m.id === wb.self));
  await waitFor(() => lkCalls.find((c) => c.method === 'RemoveParticipant' && c.body.identity === wb.self));
  const late = await o(); late.send(JSON.stringify({ type: 'join', room: 'holdRoom', name: 'Bea', resume: wb.resume, pid: wb.self }));
  await waitFor(() => late.msgs.find((m) => m.type === 'resume-failed')); late.close();
  a.terminate();
  await waitFor(() => !M4.liveRooms.has('holdRoom'));
  const gone = await o(); gone.send(JSON.stringify({ type: 'join', room: 'holdRoom', name: 'Ada', resume: 'k', pid: 'p' }));
  assert.equal((await waitFor(() => gone.msgs.find((m) => m.type === 'ended'))).type, 'ended');
  assert.ok(!M4.liveRooms.has('holdRoom'), 'a resume never starts a new meeting');
  gone.close(); s4.close(); fs.rmSync(M4dir, { recursive: true, force: true });
});
