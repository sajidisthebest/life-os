/** Extra edge-case tests not in the Python suite: cookie tampering, CSRF,
 *  MCP transport errors, settings validation, replace scoping. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../src/types.ts';
import { makeEnv, call, postJson, agentHeaders, sessionCookie, mcpHeaders } from './helpers.ts';

let env: Env;
let cookie = '';

before(async () => {
  env = makeEnv();
  const r = await postJson(env, '/api/login', { password: 'unit-test-password' });
  assert.equal(r.status, 200);
  cookie = sessionCookie(r);
});

const owner = () => ({ cookie, 'content-type': 'application/json' });

test('tampered session cookie is rejected', async () => {
  const bad = cookie.slice(0, -4) + 'ffff';
  assert.equal((await call(env, '/api/dashboard', { headers: { cookie: bad } })).status, 401);
  assert.equal((await call(env, '/api/dashboard')).status, 401);
});

test('session logout clears access', async () => {
  const out = await postJson(env, '/api/logout', {}, owner());
  assert.equal(out.status, 200);
  assert.ok((out.headers.get('set-cookie') || '').includes('Max-Age=0'));
  // Relogin for the remaining tests.
  const r = await postJson(env, '/api/login', { password: 'unit-test-password' });
  cookie = sessionCookie(r);
});

test('csrf blocks cross-origin cookie writes', async () => {
  // Same-origin write is allowed.
  const ok = await call(env, '/api/settings/display_name', {
    method: 'PUT',
    headers: { ...owner(), origin: 'http://localhost' },
    body: JSON.stringify({ value: 'Sajid' }),
  });
  assert.equal(ok.status, 200);
  // Cross-origin write is rejected.
  const bad = await call(env, '/api/settings/display_name', {
    method: 'PUT',
    headers: { ...owner(), origin: 'https://evil.example' },
    body: JSON.stringify({ value: 'Evil' }),
  });
  assert.equal(bad.status, 403);
  const dash = await (await call(env, '/api/dashboard', { headers: owner() })).json();
  assert.equal(dash.preferences.display_name, 'Sajid');
});

test('settings validation', async () => {
  const put = (key: string, value: unknown) =>
    call(env, `/api/settings/${key}`, { method: 'PUT', headers: owner(), body: JSON.stringify({ value }) });
  assert.equal((await put('nope', 1)).status, 422);
  assert.equal((await put('hero_tagline', 'x'.repeat(161))).status, 422);
  assert.equal((await put('display_name', 'x'.repeat(81))).status, 422);
  assert.equal((await put('widget_order', ['tasks'])).status, 422);
  assert.equal((await put('widgets', { nope: true })).status, 422);
  assert.equal((await put('widgets', { tasks: 'yes' })).status, 422);
  assert.equal((await put('hero_tagline', 'Ship calmly.')).status, 200);
});

test('replace only touches the supplied kind and source', async () => {
  const sync = (body: unknown) => postJson(env, '/api/agent/sync', body, agentHeaders());
  await sync({ source: 'ticktick', items: { tasks: [{ id: 'k1', title: 'keep' }], notes: [{ id: 'n1', title: 'note' }] } });
  await sync({ source: 'gmail', items: { tasks: [{ id: 'g1', title: 'gmail task' }] } });
  const r = await sync({ source: 'ticktick', mode: 'replace', complete: true, items: { tasks: [{ id: 'k2', title: 'new' }] } });
  assert.equal(r.status, 200);
  const tasks = await (await call(env, '/api/records/tasks', { headers: agentHeaders() })).json();
  const ids = tasks.items.map((x: any) => `${x.source}:${x.external_id}`).sort();
  assert.deepEqual(ids, ['gmail:g1', 'ticktick:k2']);
  const notes = await (await call(env, '/api/records/notes', { headers: agentHeaders() })).json();
  assert.equal(notes.items.length, 1);
});

test('mcp transport errors', async () => {
  // Wrong content type.
  const ct = await call(env, '/mcp', {
    method: 'POST',
    headers: mcpHeaders({ 'content-type': 'text/plain' }),
    body: '{}',
  });
  assert.equal(ct.status, 415);
  // Parse error.
  const pe = await call(env, '/mcp', {
    method: 'POST',
    headers: mcpHeaders(),
    body: '{not json',
  });
  assert.equal(pe.status, 400);
  assert.equal((await pe.json()).error.code, -32700);
  // Invalid JSON-RPC shape.
  const shape = await call(env, '/mcp', {
    method: 'POST',
    headers: mcpHeaders(),
    body: JSON.stringify({ foo: 1 }),
  });
  assert.equal(shape.status, 400);
  // Missing MCP key -> 503.
  const noKey = makeEnv({ MCP_API_KEY: '' });
  const r = await call(noKey, '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(r.status, 503);
});

test('mcp tool argument validation', async () => {
  const tc = async (name: string, args: unknown) => {
    const r = await call(env, '/mcp', {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await r.json()).result;
  };
  // Missing required arg.
  assert.equal((await tc('list_life_os_records', {})).isError, true);
  // Unknown tool -> JSON-RPC error object.
  const unk = await call(env, '/mcp', {
    method: 'POST',
    headers: mcpHeaders(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } }),
  });
  assert.equal((await unk.json()).error.code, -32602);
  // Unknown kind.
  assert.equal((await tc('list_life_os_records', { kind: 'nope' })).isError, true);
  // Bad focus_goal / time formats.
  assert.equal((await tc('update_workspace_setting', { key: 'focus_goal', value: 5 })).isError, true);
  assert.equal((await tc('update_workspace_setting', { key: 'morning_time', value: '25:00' })).isError, true);
  assert.equal((await tc('update_workspace_setting', { key: 'morning_time', value: '08:00' })).isError, false);
  // Action allowlist enforced through MCP too.
  assert.equal(
    (await tc('queue_external_action', { source: 'gmail', action: 'message.send', payload: {} })).isError,
    true,
  );
  // Ack of unknown action id.
  assert.equal((await tc('acknowledge_action', { action_id: 'missing', status: 'completed' })).isError, true);
});
