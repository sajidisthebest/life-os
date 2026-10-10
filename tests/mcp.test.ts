/** MCP endpoint tests — mirrors tests/test_remote_mcp.py from the v0.4 source. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../src/types.ts';
import { makeEnv, call, mcpHeaders } from './helpers.ts';

let env: Env;

before(() => {
  env = makeEnv();
});

async function mcp(method: string, id: number | null = 1, params: unknown = {}, headers: Record<string, string> = {}) {
  const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
  if (id !== null) body.id = id;
  return call(env, '/mcp', { method: 'POST', headers: mcpHeaders(headers), body: JSON.stringify(body) });
}

async function tool(name: string, args: unknown = {}) {
  const r = await mcp('tools/call', 1, { name, arguments: args });
  assert.equal(r.status, 200);
  return (await r.json()).result;
}

test('mcp auth', async () => {
  assert.equal(
    (await call(env, '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status,
    401,
  );
  assert.equal((await call(env, '/mcp', { method: 'GET', headers: mcpHeaders() })).status, 405);
  assert.equal(
    (await mcp('initialize', 1, {}, { origin: 'https://evil.example' })).status,
    403,
  );
});

test('initialize and tool discovery', async () => {
  const r = await mcp('initialize', 1, {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'tests', version: '1' },
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result.protocolVersion, '2025-06-18');

  const list = await mcp('tools/list');
  assert.equal(list.status, 200);
  const tools = (await list.json()).result.tools;
  assert.ok(tools.length >= 12);
  assert.equal(tools.length, 13);
  assert.ok(tools.some((t: any) => t.name === 'sync_connected_data'));
});

test('ping and unknown method', async () => {
  const r = await mcp('ping');
  assert.deepEqual((await r.json()).result, {});
  assert.equal((await mcp('unknown')).status, 404);
});

test('theme and tagline', async () => {
  const r = await tool('update_workspace_setting', { key: 'theme', value: 'forest' });
  assert.equal(r.isError, false);
  const t = await tool('set_dashboard_tagline', { text: 'Build deliberately.' });
  assert.equal(t.isError, false);
  const overview = (await tool('get_life_os_overview')).structuredContent;
  assert.equal(overview.preferences.theme, 'forest');
  assert.equal(overview.preferences.hero_tagline, 'Build deliberately.');
  assert.equal((await tool('update_workspace_setting', { key: 'theme', value: 'not-a-theme' })).isError, true);
});

test('widget controls', async () => {
  const order = ['tasks', 'schedule', 'briefing', 'focus', 'outreach', 'habits', 'capture', 'projects', 'analytics'];
  const response = await tool('configure_home_widgets', { visibility: { analytics: false }, order });
  assert.equal(response.isError, false);
  const prefs = (await tool('get_life_os_overview')).structuredContent.preferences;
  assert.deepEqual(prefs.widget_order, order);
  assert.equal(prefs.widgets.analytics, false);
  assert.equal((await tool('configure_home_widgets', { order: ['tasks'] })).isError, true);
});

test('sync and local edit', async () => {
  const r = await tool('sync_connected_data', {
    source: 'notion',
    items: { projects: [{ id: 'project-1', name: 'Sample project' }] },
  });
  assert.equal(r.isError, false);
  const rows = (await tool('list_life_os_records', { kind: 'projects' })).structuredContent.items;
  assert.ok(rows.some((x: any) => x.data.id === 'project-1'));
  const local = await tool('save_local_record', { kind: 'notes', data: { title: 'Created by Muse' } });
  assert.equal(local.isError, false);
  assert.equal((await tool('list_life_os_records', { kind: 'notes' })).structuredContent.items.length, 1);
});

test('actions and change requests', async () => {
  const r = await tool('queue_external_action', {
    source: 'ticktick',
    action: 'task.create',
    payload: { title: 'Follow up' },
  });
  assert.equal(r.isError, false);
  const aid = r.structuredContent.action_id;
  const pending = (await tool('get_pending_actions')).structuredContent.items;
  assert.ok(pending.some((x: any) => x.id === aid));
  assert.equal((await tool('acknowledge_action', { action_id: aid, status: 'completed' })).isError, false);

  const prop = await tool('propose_app_code_change', {
    summary: 'Add timeline view',
    specification: 'Implement a timeline of active tasks using stored real data.',
    affected_pages: ['home', 'tasks'],
  });
  assert.equal(prop.structuredContent.status, 'review_required');
  const proposals = (await tool('list_app_change_requests')).structuredContent.items;
  assert.ok(proposals.length > 0);
  assert.ok(!JSON.stringify(proposals).toLowerCase().includes('deployed'));
});

test('protocol version and notifications', async () => {
  assert.equal((await mcp('tools/list', 1, {}, { 'mcp-protocol-version': '2099-01-01' })).status, 400);
  const n = await call(env, '/mcp', {
    method: 'POST',
    headers: mcpHeaders(),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(n.status, 202);
});
