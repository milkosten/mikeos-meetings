// Recording robustness + the meeting page states before the transcript is done.
// - rec-start is confirmed with the segment id; after a dropped socket the browser resumes the SAME segment (rec-resume)
//   and sends the audio it kept meanwhile; an unknown segment is answered with rec-restart.
// - server watchdog: someone in the meeting whose audio stops arriving is asked to restart (rec-restart), at most once
//   per NO_AUDIO_MS; a browser that cannot record says rec-none and is not asked again.
// - /api/past/:id and /api/past: 'live' + live_state running|ending (never "done with no lines" before it is done),
//   then queued/processing (progress) and done with lines.
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

const ISSUER = 'https://account.test';
const U = { codeA: { tok: 'tokA', sub: 'sub-a', email: 'a@osmike.com', name: 'Anna Andersson' } };
const realFetch = fetch;
async function fakeFetch(url, opts = {}) {
  url = String(url);
  if (url === `${ISSUER}/oauth/token`) {
    const u = U[new URLSearchParams(String(opts.body)).get('code')]; if (!u) return new Response('{}', { status: 400 });
    return Response.json({ access_token: u.tok, refresh_token: 'r', expires_in: 3600 });
  }
  if (url === `${ISSUER}/oauth/userinfo`) return Response.json({ sub: 'sub-a', email: 'a@osmike.com', name: 'Anna Andersson' });
  if (url.startsWith('http://cal.test/')) return Response.json({ events: [] });
  return realFetch(url, opts);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-rec-'));
const tone = path.join(dir, 'tone.webm');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-af', 'volume=-6dB', '-c:a', 'libopus', '-b:a', '32k', tone]);
let release = null;                                   // holds speech-to-text so the test can look at 'processing'
const stt = async () => { if (release) await release; return { language: 'sv', segments: [{ start: 0.5, end: 2, text: 'Vi lanserar på fredag och skriver pressmeddelandet på torsdag, alla hinner läsa det innan dess.' }] }; };
const llm = async () => ({ overview: 'Lansering.', key_points: [], decisions: [], action_items: [] });
const logs = [];
const env = { ISSUER, DATA_DIR: dir, INSECURE_COOKIES: '1', END_GRACE_MS: '400', RESUME_MS: '3000', NO_AUDIO_MS: '300', REC_CHECK_MS: '50', CALENDAR_URL: 'http://cal.test', PUBLIC_HOST: 'meet.test' };
const M = createApp(env, { fetch: fakeFetch, stt, llm, log: (...a) => logs.push(a.join(' ')), retryMs: 10 });
const server = http.createServer(M.app); M.attach(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50); });

const jar = (h) => (h.getSetCookie?.() || []).map((c) => c.split(';')[0]);
async function login(code) {
  let r = await realFetch(`${base}/auth/login?next=/past`, { redirect: 'manual' });
  const pre = jar(r.headers).find((c) => c.startsWith('meetings-pre='));
  const state = new URL(r.headers.get('location')).searchParams.get('state');
  r = await realFetch(`${base}/auth/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: { cookie: pre } });
  return { cookie: jar(r.headers).find((c) => c.startsWith('meetings-sid=')) };
}
const wsOpen = (c) => new Promise((res) => { const w = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: c ? { cookie: c.cookie } : {} });
  w.msgs = []; w.on('message', (d, bin) => { if (!bin) w.msgs.push(JSON.parse(d)); }); w.on('open', () => res(w)); });
const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (u, c) => (await realFetch(base + u, { headers: { cookie: c.cookie } })).json();

let A;
test('rec-start is confirmed; a dropped socket resumes the same recording file; unknown segment -> rec-restart', async () => {
  A = await login('codeA');
  const audio = fs.readFileSync(tone), half = Math.floor(audio.length / 2);
  const a = await wsOpen(A); a.send(JSON.stringify({ type: 'join', room: 'recRoom' }));
  const wel = await waitFor(() => a.msgs.find((m) => m.type === 'welcome'));
  a.send(JSON.stringify({ type: 'rec-start', mime: 'audio/webm', why: 'join' }));
  const ok = await waitFor(() => a.msgs.find((m) => m.type === 'rec-ok'));
  assert.ok(ok.seg);
  a.send(audio.subarray(0, half));
  await sleep(60);
  a.terminate();                                      // the network drops; the browser keeps recording meanwhile
  await sleep(80);
  const b = await wsOpen(A); b.send(JSON.stringify({ type: 'join', room: 'recRoom', resume: wel.resume, pid: wel.self }));
  await waitFor(() => b.msgs.find((m) => m.type === 'welcome' && m.resumed));
  b.send(JSON.stringify({ type: 'rec-resume', seg: ok.seg }));
  b.send(audio.subarray(half));                       // what was kept while the socket was away
  const ok2 = await waitFor(() => b.msgs.find((m) => m.type === 'rec-ok'));
  assert.equal(ok2.seg, ok.seg); assert.equal(ok2.resumed, true);
  await sleep(80);
  const m = M.store.meeting(wel.meeting);
  assert.equal(m.segments.length, 1, 'one recording, not a new segment per reconnect');
  assert.equal(m.segments[0].bytes, audio.length);
  assert.equal(fs.statSync(path.join(M.store.audioDir(m.id), ok.seg + '.webm')).size, audio.length, 'one continuous file');
  b.send(JSON.stringify({ type: 'rec-resume', seg: 'notMine123' }));
  assert.equal((await waitFor(() => b.msgs.find((x) => x.type === 'rec-restart'))).why, 'unknown segment');
  // the page while people are still in it: running, not "no speech"
  let d = await api(`/api/past/${wel.meeting}`, A);
  assert.equal(d.status, 'live'); assert.equal(d.live_state, 'running');
  assert.ok((await api('/api/past', A)).meetings.some((x) => x.id === wel.meeting && x.live_state === 'running'), 'listed as in progress');
  // everyone left: 'ending' during the grace, then queued/processing with progress, then done with lines
  let r; release = new Promise((res) => { r = res; });
  b.send(JSON.stringify({ type: 'rec-start', mime: 'audio/webm' })); await waitFor(() => b.msgs.filter((x) => x.type === 'rec-ok').length >= 2);
  b.send(audio); await sleep(60);
  b.send(JSON.stringify({ type: 'leave' }));
  d = await api(`/api/past/${wel.meeting}`, A);
  assert.equal(d.status, 'live'); assert.equal(d.live_state, 'ending', 'everyone left: ending, the page says Transcribing');
  d = await waitFor(async () => { const x = await api(`/api/past/${wel.meeting}`, A); return x.status === 'processing' && x.progress ? x : null; });
  assert.deepEqual(d.progress, { done: 0, total: 2 }, 'progress: parts of the recording');
  const lst = (await api('/api/past', A)).meetings.find((x) => x.id === wel.meeting);
  assert.equal(lst.status, 'processing');
  r();
  d = await waitFor(async () => { const x = await api(`/api/past/${wel.meeting}`, A); return x.status === 'done' ? x : null; });
  release = null;
  assert.equal(d.progress, null); assert.ok(d.transcript.length >= 1); assert.equal(d.live_state, null);
  assert.ok((await api('/api/past', A)).meetings.find((x) => x.id === wel.meeting).lines >= 1);
  a.close(); b.close();
});

test('server watchdog: no audio from someone in the meeting -> rec-restart (rate-limited, logged); rec-none stops it', async () => {
  const g = await wsOpen(A); g.send(JSON.stringify({ type: 'join', room: 'quietRoom' }));
  await waitFor(() => g.msgs.find((m) => m.type === 'welcome'));
  g.send(JSON.stringify({ type: 'rec-start', mime: 'audio/webm' })); await waitFor(() => g.msgs.find((m) => m.type === 'rec-ok'));
  const audio = fs.readFileSync(tone);
  // audio keeps arriving: never asked
  for (let i = 0; i < 8; i++) { g.send(audio.subarray(i * 500, i * 500 + 500)); await sleep(60); }
  assert.ok(!g.msgs.some((m) => m.type === 'rec-restart'), 'a recording that delivers is left alone');
  // the recorder dies silently: asked to restart, once per NO_AUDIO_MS
  const t0 = Date.now();
  const ask = await waitFor(() => g.msgs.find((m) => m.type === 'rec-restart'));
  assert.equal(ask.why, 'no audio'); assert.ok(Date.now() - t0 >= 150);
  await sleep(120);
  assert.equal(g.msgs.filter((m) => m.type === 'rec-restart').length, 1, 'rate-limited');
  assert.ok(logs.some((l) => /no audio for \d+ s from/.test(l)), 'logged');
  await waitFor(() => g.msgs.filter((m) => m.type === 'rec-restart').length >= 2, 2000);
  // this browser cannot record at all: it says so and is not asked again
  g.send(JSON.stringify({ type: 'rec-none', why: 'no microphone' }));
  await sleep(50); const n = g.msgs.filter((m) => m.type === 'rec-restart').length;
  await sleep(800);
  assert.equal(g.msgs.filter((m) => m.type === 'rec-restart').length, n, 'not asked after rec-none');
  // joined but never started a recording: asked too
  const h = await wsOpen(null); h.send(JSON.stringify({ type: 'join', room: 'quietRoom', name: 'Gäst' }));
  await waitFor(() => h.msgs.find((m) => m.type === 'welcome'));
  assert.equal((await waitFor(() => h.msgs.find((m) => m.type === 'rec-restart'))).why, 'no audio');
  assert.ok(logs.some((l) => /joined .* guest/.test(l)) && logs.some((l) => /no recording open/.test(l)));
  // someone outside the meeting cannot open a recording
  const x = await wsOpen(null); x.send(JSON.stringify({ type: 'rec-start' })); await sleep(80);
  assert.ok(!x.msgs.some((m) => m.type === 'rec-ok')); x.close();
  g.send(JSON.stringify({ type: 'leave' })); h.send(JSON.stringify({ type: 'leave' }));
  await waitFor(() => !M.liveRooms.has('quietRoom'));
  g.close(); h.close();
});
