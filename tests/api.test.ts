/** REST API tests — mirrors tests/test_api.py from the v0.4 source. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../src/types.ts';
import { makeEnv, call, postJson, agentHeaders, sessionCookie } from './helpers.ts';

let env: Env;
let cookie = '';

before(() => {
  env = makeEnv();
});

const owner = () => ({ cookie, 'content-type': 'application/json' });

test('auth and login', async () => {
  assert.equal((await call(env, '/api/dashboard')).status, 401);
  assert.equal((await postJson(env, '/api/login', { password: 'wrong' })).status, 401);
  const r = await postJson(env, '/api/login', { password: 'unit-test-password' });
  assert.equal(r.status, 200);
  cookie = sessionCookie(r);
  assert.ok(cookie.startsWith('lifeos_session='));
  assert.equal((await (await call(env, '/api/session', { headers: { cookie } })).json()).authenticated, true);
  assert.equal((await call(env, '/api/dashboard', { headers: { cookie } })).status, 200);
});

test('sync merge and idempotency', async () => {
  const p = {
    source: 'ticktick',
    mode: 'upsert',
    complete: false,
    idempotency_key: 'test-upsert-one',
    items: { tasks: [{ id: 't-1', title: 'Real synced task', due: '2026-10-11', status: 'open' }] },
  };
  const r = await postJson(env, '/api/agent/sync', p, agentHeaders());
  assert.equal(r.status, 200);
  const first = await r.json();
  assert.equal(first.received, 1);

  const repeat = await postJson(env, '/api/agent/sync', p, agentHeaders());
  assert.deepEqual(await repeat.json(), first);

  const p2 = { source: 'ticktick', items: { tasks: [{ id: 't-2', title: 'Second task' }] } };
  assert.equal((await postJson(env, '/api/agent/sync', p2, agentHeaders())).status, 200);
  const rows = await (await call(env, '/api/records/tasks', { headers: agentHeaders() })).json();
  assert.equal(rows.items.length, 2);

  const p3 = { source: 'ticktick', mode: 'replace', items: { tasks: [{ id: 't-1', title: 'Updated' }] } };
  assert.equal((await postJson(env, '/api/agent/sync', p3, agentHeaders())).status, 422);
  const p3b = { ...p3, complete: true };
  assert.equal((await postJson(env, '/api/agent/sync', p3b, agentHeaders())).status, 200);
  const rows2 = await (await call(env, '/api/records/tasks', { headers: agentHeaders() })).json();
  assert.equal(rows2.items.length, 1);
  assert.equal(rows2.items[0].data.title, 'Updated');
});

test('heartbeat does not change data freshness', async () => {
  const dash = await (await call(env, '/api/dashboard', { headers: agentHeaders() })).json();
  const prev = dash.integrations.find((s: any) => s.source === 'ticktick').updated_at;
  const r = await postJson(env, '/api/agent/heartbeat', { source: 'ticktick', status: 'online' }, agentHeaders());
  assert.equal(r.status, 200);
  const dash2 = await (await call(env, '/api/dashboard', { headers: agentHeaders() })).json();
  const current = dash2.integrations.find((s: any) => s.source === 'ticktick').updated_at;
  assert.equal(prev, current);
});

test('action queue and ack', async () => {
  const r = await postJson(
    env,
    '/api/actions',
    { source: 'ticktick', action: 'task.complete', payload: { external_id: 't-1' } },
    owner(),
  );
  assert.equal(r.status, 200);
  const aid = (await r.json()).action_id;
  const act = await (await call(env, '/api/agent/actions', { headers: agentHeaders() })).json();
  assert.ok(act.items.some((x: any) => x.id === aid));
  assert.equal(
    (await postJson(env, `/api/agent/actions/${aid}/ack`, { status: 'completed' }, agentHeaders())).status,
    200,
  );
  const act2 = await (await call(env, '/api/agent/actions', { headers: agentHeaders() })).json();
  assert.ok(!act2.items.some((x: any) => x.id === aid));
  assert.equal(
    (await postJson(env, '/api/actions', { source: 'gmail', action: 'message.send', payload: {} }, owner())).status,
    422,
  );
});

test('local record and briefing', async () => {
  const r = await postJson(
    env,
    '/api/records/habits',
    { data: { id: 'h-1', title: 'Drink water', completed_dates: [] }, source: 'local' },
    owner(),
  );
  assert.equal(r.status, 200);
  const rows = await (await call(env, '/api/records/habits', { headers: owner() })).json();
  assert.equal(rows.items.length, 1);
  const b = await postJson(env, '/api/briefings/generate', { type: 'morning' }, owner());
  assert.equal(b.status, 200);
  assert.ok('summary' in (await b.json()));
});

test('agent boundary', async () => {
  // Owner session cookie present (as in the Python tests, where the TestClient
  // stays logged in): agent-only endpoints must return 403, not 401.
  assert.equal((await postJson(env, '/api/agent/heartbeat', { source: 'notion' }, owner())).status, 403);
  assert.equal(
    (await postJson(env, '/api/records/tasks', { source: 'ticktick', data: { id: 'bad' } }, owner())).status,
    403,
  );
  assert.equal((await call(env, '/api/agent/actions', { headers: owner() })).status, 403);
});

test('theme presets persist and validate', async () => {
  for (const theme of ['dark', 'light', 'forest', 'mocha']) {
    const r = await call(env, '/api/settings/theme', {
      method: 'PUT',
      headers: owner(),
      body: JSON.stringify({ value: theme }),
    });
    assert.equal(r.status, 200);
    const dashboard = await (await call(env, '/api/dashboard', { headers: owner() })).json();
    assert.equal(dashboard.preferences.theme, theme);
  }
  assert.equal(
    (
      await call(env, '/api/settings/theme', {
        method: 'PUT',
        headers: owner(),
        body: JSON.stringify({ value: 'unknown' }),
      })
    ).status,
    422,
  );
  const dashboard = await (await call(env, '/api/dashboard', { headers: owner() })).json();
  assert.equal(dashboard.preferences.theme, 'mocha');
});

test('response security headers', async () => {
  const r = await call(env, '/api/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok((r.headers.get('content-security-policy') || '').includes("script-src 'self'"));
});

test('login throttled after multiple failures', async () => {
  for (let i = 0; i < 8; i++) {
    assert.equal((await postJson(env, '/api/login', { password: 'wrong' })).status, 401);
  }
  assert.equal((await postJson(env, '/api/login', { password: 'unit-test-password' })).status, 429);
  await env.DB.prepare('DELETE FROM login_failures').run();
  assert.equal((await postJson(env, '/api/login', { password: 'unit-test-password' })).status, 200);
});
