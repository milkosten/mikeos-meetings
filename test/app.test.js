// The OsMike apps (2026-11-27): a one-time hand-off turns the app's sign-in (the person's own account token) into the
// meeting page's session; codes are single use and short-lived; an agent's token (with `act`) is refused; only the
// host deletes a previous meeting from the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server.js';

const ISSUER = 'https://account.test';
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const exp = Math.floor(Date.now() / 1000) + 3600;
const TOK_A = jwt({ sub: 'sub-a', exp }), TOK_B = jwt({ sub: 'sub-b', exp }), TOK_AGENT = jwt({ sub: 'sub-a', exp, act: { sub: 'agent-x' } });
const USERS = { [TOK_A]: { sub: 'sub-a', email: 'a@osmike.com', name: 'Anna Andersson' }, [TOK_B]: { sub: 'sub-b', email: 'b@osmike.com', name: 'Bo Berg' },
  [TOK_AGENT]: { sub: 'sub-a', email: 'a@osmike.com', name: 'Anna Andersson' } };
async function fakeFetch(url, opts = {}) {
  url = String(url);
  if (url === `${ISSUER}/oauth/userinfo`) {
    const u = USERS[(opts.headers?.Authorization || '').replace('Bearer ', '')];
    return u ? Response.json(u) : new Response('{}', { status: 401 });
  }
  if (url.startsWith('http://cal.test/')) return Response.json({ events: [] });
  return new Response('{}', { status: 404 });
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-app-'));
const M = createApp({ ISSUER, DATA_DIR: dir, INSECURE_COOKIES: '1', CALENDAR_URL: 'http://cal.test', PUBLIC_HOST: 'meet.test', MEETINGS_MEDIA: 'mesh' },
  { fetch: fakeFetch, stt: async () => ({ language: 'sv', segments: [] }), llm: async () => ({ overview: '' }), log: () => {}, retryMs: 10 });
const server = http.createServer(M.app); M.attach(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50); });

const session = (tok) => fetch(`${base}/api/app/session`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` } });

test('app session: the person joins the meeting socket signed in', async () => {
  const r = await session(TOK_A);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.cookie, 'meetings-sid');
  assert.equal(j.ws, 'wss://meet.test/ws');
  const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: `${j.cookie}=${j.session}` } })).json();
  assert.deepEqual([me.authenticated, me.user.email, me.user.name], [true, 'a@osmike.com', 'Anna Andersson']);
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { Cookie: `${j.cookie}=${j.session}` } });
  await new Promise((ok) => ws.on('open', ok));
  const welcome = new Promise((ok) => ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'welcome') ok(m); }));
  ws.send(JSON.stringify({ type: 'join', room: 'nativeroom1' }));
  const w = await welcome;
  assert.equal(w.name, 'Anna Andersson', 'signed in, not a guest');
  assert.equal(w.is_host, true);
  ws.send(JSON.stringify({ type: 'leave' })); ws.close();
});

test('app session refuses agents and bad tokens; at most 5 live sessions per person', async () => {
  assert.equal((await session(TOK_AGENT)).status, 401);
  assert.equal((await session('nope')).status, 401);
  assert.equal((await fetch(`${base}/api/app/session`, { method: 'POST' })).status, 401);
  const sids = [];
  for (let i = 0; i < 6; i++) sids.push((await (await session(TOK_B)).json()).session);
  const me0 = await (await fetch(`${base}/api/me`, { headers: { Cookie: `meetings-sid=${sids[0]}` } })).json();
  const me5 = await (await fetch(`${base}/api/me`, { headers: { Cookie: `meetings-sid=${sids[5]}` } })).json();
  assert.deepEqual([me0.authenticated, me5.authenticated], [false, true]);
});

test('delete from the app: host only, person token only', async () => {
  const m = { id: 'mtgapp01', room: 'room1', title: 'Planning', host_sub: 'sub-a', host_name: 'Anna', status: 'done', started_at: Date.now() - 60_000, ended_at: Date.now(),
    participants: [{ sub: 'sub-a', name: 'Anna' }, { sub: 'sub-b', name: 'Bo' }], transcript: [], summary: null };
  M.store.putMeeting ? M.store.putMeeting(m) : M.store.saveMeeting(m);
  const del = (tok) => fetch(`${base}/api/app/meetings/mtgapp01`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } });
  assert.equal((await del(TOK_AGENT)).status, 401);
  assert.equal((await del(TOK_B)).status, 403, 'a participant cannot delete');
  assert.equal((await del(TOK_A)).status, 200);
  assert.equal((await del(TOK_A)).status, 404);
});

test('meeting links open the OsMike Meetings app: apple-app-site-association + assetlinks.json', async () => {
  const a = await fetch(`${base}/.well-known/apple-app-site-association`, { redirect: 'manual' });
  assert.equal(a.status, 200);
  assert.match(a.headers.get('content-type'), /application\/json/);
  const aj = await a.json();
  assert.deepEqual(aj.applinks.details[0].appIDs, ['U8B998R2YD.com.osmike.meetings']);
  assert.equal(aj.applinks.details[0].components[0]['/'], '/r/*');
  const l = await fetch(`${base}/.well-known/assetlinks.json`, { redirect: 'manual' });
  assert.equal(l.status, 200);
  const lj = await l.json();
  assert.equal(lj[0].target.package_name, 'com.osmike.meetings');
  assert.equal(lj[0].target.sha256_cert_fingerprints.length, 2);
});
