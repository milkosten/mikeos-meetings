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
