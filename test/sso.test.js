// Silent SSO (OIDC prompt=none): a page view tries the account once, guests land signed out, never a loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-sso-'));
const M = createApp({ ISSUER: 'https://account.test', DATA_DIR: dir, INSECURE_COOKIES: '1', PUBLIC_HOST: 'meet.test' },
  { fetch: async () => new Response('{}', { status: 500 }), stt: async () => ({}), llm: async () => ({}), log: () => {} });
const server = http.createServer(M.app); M.attach?.(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50); });
const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' };
const jar = (h) => (h.getSetCookie?.() || []).map((c) => c.split(';')[0]);
// node:http, not fetch: fetch drops the Sec-Fetch-* headers a real browser sends.
const get = (u, headers = {}) => new Promise((resolve, reject) => {
  http.get(base + u, { headers }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode,
    headers: { get: (k) => res.headers[k.toLowerCase()] ?? null, getSetCookie: () => res.headers['set-cookie'] || [] } })); }).on('error', reject);
});

test('page view without session tries prompt=none once, login_required lands on the page', async () => {
  let r = await get('/r/abc123', NAV);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/auth/login?prompt=none&next=%2Fr%2Fabc123');
  const tried = jar(r.headers).find((c) => c.startsWith('sso_tried='));
  assert.ok(tried);
  r = await get('/auth/login?prompt=none&next=%2Fr%2Fabc123', { cookie: tried });
  const u = new URL(r.headers.get('location'));
  assert.equal(u.searchParams.get('prompt'), 'none');
  const pre = jar(r.headers).find((c) => c.startsWith('meetings-pre='));
  r = await get(`/auth/callback?error=login_required&state=${u.searchParams.get('state')}`, { cookie: `${tried}; ${pre}` });
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/r/abc123');
  r = await get('/r/abc123', { ...NAV, cookie: tried });                    // guest join page, no second hop
  assert.equal(r.status, 200);
});
test('cookie-less browser gets the stop marker; non-navigations are never redirected', async () => {
  let r = await get('/auth/login?prompt=none&next=%2Fpast');
  const state = new URL(r.headers.get('location')).searchParams.get('state');
  r = await get(`/auth/callback?error=login_required&state=${state}`);
  assert.equal(r.headers.get('location'), '/past?sso=0');
  assert.equal((await get('/past?sso=0', NAV)).status, 200);
  assert.equal((await get('/')).status, 200);                                  // curl / preview
  assert.equal((await get('/api/me', NAV)).status, 200);                       // API
  assert.equal((await get('/', { ...NAV, 'sec-fetch-dest': 'iframe' })).status, 200);
  assert.equal((await get('/', { ...NAV, cookie: 'sso_off=1' })).status, 200);  // signed out here
});
