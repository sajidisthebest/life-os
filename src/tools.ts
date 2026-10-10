/**
 * MCP tool specifications and execution. Mirrors mcp_remote.py:
 * the same 13 tools, input schemas, validation rules and error shapes.
 */
import type { D1Database, Env } from './types.ts';
import { now, uuidHex } from './util.ts';
import { q, q1, run, audit, saveRecord, listRecords } from './db.ts';
import { KINDS, SOURCES, THEMES, WIDGETS } from './constants.ts';
import { dashboardData, saveSetting, handleSync, handleQueueAction, handleAckAction, handleHeartbeat } from './routes.ts';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
}

function spec(
  name: string,
  description: string,
  properties?: Record<string, unknown>,
  required?: string[],
): ToolSpec {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: properties || {},
      required: required || [],
      additionalProperties: false,
    },
  };
}

const S = 'string';

export const TOOLS: ToolSpec[] = [
  spec(
    'get_life_os_overview',
    'Read current Life OS statistics, integration freshness, appearance settings and pending action count.',
  ),
  spec(
    'list_life_os_records',
    'Read stored task, event, outreach, email, Notion, finance or other records.',
    {
      kind: { type: S },
      source: { type: S },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    ['kind'],
  ),
  spec(
    'sync_connected_data',
    'Upsert verified records from connected services. Use replace only for complete source/kind snapshots; never infer missing records.',
    {
      source: { type: S },
      items: { type: 'object', description: 'Map of records kind to arrays with stable external_id or id.' },
      mode: { type: S, enum: ['upsert', 'replace'] },
      complete: { type: 'boolean' },
      idempotency_key: { type: S },
    },
    ['source', 'items'],
  ),
  spec(
    'update_workspace_setting',
    'Change an approved visible app setting such as theme, name, focus goal or briefing schedule.',
    {
      key: { type: S, enum: ['theme', 'display_name', 'focus_goal', 'morning_time', 'evening_time', 'notifications'] },
      value: {},
    },
    ['key', 'value'],
  ),
  spec(
    'configure_home_widgets',
    'Show, hide, or reorder existing homepage widgets. Takes effect when the dashboard refreshes.',
    {
      visibility: { type: 'object', additionalProperties: { type: 'boolean' } },
      order: { type: 'array', items: { type: S } },
    },
  ),
  spec(
    'set_dashboard_tagline',
    'Edit the visible homepage greeting banner tagline. Plain text, maximum 160 characters.',
    { text: { type: S, maxLength: 160 } },
    ['text'],
  ),
  spec(
    'save_local_record',
    'Create or update a local Life OS record, not an external account record.',
    { kind: { type: S }, data: { type: 'object' } },
    ['kind', 'data'],
  ),
  spec(
    'queue_external_action',
    'Queue an approved external-app action for the authorized Muse agent. Queuing does NOT complete it.',
    { source: { type: S }, action: { type: S }, payload: { type: 'object' } },
    ['source', 'action', 'payload'],
  ),
  spec(
    'get_pending_actions',
    'Retrieve requested changes to the original connected apps.',
    { status: { type: S, enum: ['pending', 'failed', 'rejected', 'completed'] } },
  ),
  spec(
    'acknowledge_action',
    'Record that a connected-app action was actually completed, failed or rejected.',
    {
      action_id: { type: S },
      status: { type: S, enum: ['completed', 'failed', 'rejected'] },
      error: { type: S },
    },
    ['action_id', 'status'],
  ),
  spec(
    'agent_heartbeat',
    'Record agent reachability without changing the last actual source-data synchronization timestamp.',
    { source: { type: S }, status: { type: S }, message: { type: S } },
    ['source'],
  ),
  spec(
    'propose_app_code_change',
    'Submit a source-code/UI feature request to a review queue. This NEVER modifies live code or deploys. Code changes require an authorized GitHub PR + review.',
    {
      summary: { type: S, minLength: 5, maxLength: 200 },
      specification: { type: S, minLength: 10, maxLength: 6000 },
      affected_pages: { type: 'array', items: { type: S }, maxItems: 20 },
    },
    ['summary', 'specification'],
  ),
  spec(
    'list_app_change_requests',
    'Read pending source-code change requests and their review status.',
    { limit: { type: 'integer', minimum: 1, maximum: 100 } },
  ),
];

export function errorObj(code: number, message: string, rid: unknown = null): Record<string, unknown> {
  return { jsonrpc: '2.0', id: rid, error: { code, message: String(message) } };
}

export function contentObj(rid: unknown, value: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: rid,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
      isError: false,
    },
  };
}

export function raiseTool(message: string, rid: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: rid,
    result: { content: [{ type: 'text', text: String(message) }], isError: true },
  };
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Execute one MCP tool. Throws Error on validation failures (surfaced as
 * isError tool results) or HttpError (surfaced via its detail message).
 */
export async function executeTool(
  name: string,
  args: Record<string, any>,
  env: Env,
  _request: Request,
): Promise<unknown> {
  const db: D1Database = env.DB;

  if (name === 'get_life_os_overview') {
    const result = await dashboardData(db);
    const counts: Record<string, number> = {};
    const records = result.records as Array<{ kind: string }>;
    for (const kind of KINDS) counts[kind] = records.filter((r) => r.kind === kind).length;
    return {
      record_counts: counts,
      integrations: result.integrations,
      preferences: result.preferences,
      pending_action_count: result.pending_actions.length,
      server_time: result.server_time,
    };
  }

  if (name === 'list_life_os_records') {
    const kind = args.kind;
    if (!KINDS.includes(kind)) fail('Unknown record kind');
    const source = args.source;
    if (source && ![...SOURCES, 'local'].includes(source)) fail('Unknown source');
    const limit = Number(args.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('limit out of range');
    return { items: await listRecords(db, kind, source, limit) };
  }

  if (name === 'sync_connected_data') {
    const source = args.source;
    if (!SOURCES.includes(source)) fail('Invalid source');
    const items = args.items;
    if (
      typeof items !== 'object' ||
      items === null ||
      Array.isArray(items) ||
      Object.entries(items).some(
        ([k, v]) => !KINDS.includes(k) || !Array.isArray(v) || (v as unknown[]).length > 150,
      )
    ) {
      fail('Sync accepts known kinds with up to 150 records per kind per call');
    }
    const req = new Request('https://internal/api/agent/sync', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.AGENT_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        source,
        items,
        mode: args.mode ?? 'upsert',
        complete: args.complete ?? false,
        idempotency_key: args.idempotency_key ?? null,
      }),
    });
    const res = await handleSync(req, env);
    const out = (await res.json()) as Record<string, any>;
    if (res.status >= 400) fail(out.detail ?? 'Sync failed');
    return out;
  }

  if (name === 'update_workspace_setting') {
    const key = args.key;
    if (!['theme', 'display_name', 'focus_goal', 'morning_time', 'evening_time', 'notifications'].includes(key)) {
      fail('Unsupported setting');
    }
    const val = args.value;
    if (key === 'theme' && !THEMES.includes(val)) fail('Unknown theme');
    if (key === 'morning_time' || key === 'evening_time') {
      if (typeof val !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(val)) fail('Time must be HH:MM');
    }
    if (key === 'focus_goal' && (typeof val !== 'number' || !Number.isFinite(val) || val < 15 || val > 1440)) {
      fail('Focus goal must be 15–1440 minutes');
    }
    if (key === 'notifications' && !(typeof val === 'object' || typeof val === 'boolean')) {
      fail('Notifications must be a boolean or object');
    }
    return saveSetting(db, key, val);
  }

  if (name === 'configure_home_widgets') {
    const visibility = args.visibility;
    const order = args.order;
    if (visibility === undefined && order === undefined) fail('Provide visibility and/or order');
    if (visibility !== undefined) {
      if (
        typeof visibility !== 'object' ||
        visibility === null ||
        Array.isArray(visibility) ||
        Object.keys(visibility).some((k) => !WIDGETS.includes(k)) ||
        Object.values(visibility).some((v) => typeof v !== 'boolean')
      ) {
        fail('Invalid widget visibility map');
      }
      const row = await q1<{ value: string }>(db, "SELECT value FROM settings WHERE key='widgets'");
      const previous = row ? JSON.parse(row.value) : {};
      await saveSetting(db, 'widgets', { ...previous, ...visibility });
    }
    if (order !== undefined) {
      if (!Array.isArray(order) || order.length !== WIDGETS.length || new Set(order).size !== WIDGETS.length || order.some((w) => !WIDGETS.includes(w))) {
        fail('Order must include all nine widgets exactly once');
      }
      await saveSetting(db, 'widget_order', order);
    }
    return { ok: true, visible_changes: visibility || {}, order, effect: 'Dashboard refresh' };
  }

  if (name === 'set_dashboard_tagline') {
    return saveSetting(db, 'hero_tagline', args.text);
  }

  if (name === 'save_local_record') {
    const kind = args.kind;
    if (!KINDS.includes(kind)) fail('Unknown kind');
    const data = { ...(args.data ?? {}) };
    if (!data.id && !data.external_id) data.id = uuidHex();
    const rid = await saveRecord(db, kind, 'local', data, 'agent');
    await audit(db, 'agent', 'record.upsert', { id: rid });
    return { id: rid, data };
  }

  if (name === 'queue_external_action') {
    if (!SOURCES.includes(args.source)) fail('Unknown source');
    const req = new Request('https://internal/api/actions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.AGENT_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: args.source, action: args.action, payload: args.payload }),
    });
    const res = await handleQueueAction(req, env);
    const out = (await res.json()) as Record<string, any>;
    if (res.status >= 400) fail(out.detail ?? 'Queue failed');
    return out;
  }

  if (name === 'get_pending_actions') {
    const status = args.status ?? 'pending';
    const rows = await q<Record<string, any>>(db, 'SELECT * FROM action_queue WHERE status=? ORDER BY created_at LIMIT 100', status);
    return { items: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload as string) })) };
  }

  if (name === 'acknowledge_action') {
    const req = new Request(`https://internal/api/agent/actions/${encodeURIComponent(args.action_id)}/ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.AGENT_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: args.status, error: args.error ?? null }),
    });
    const res = await handleAckAction(req, env, args.action_id);
    const out = (await res.json()) as Record<string, any>;
    if (res.status >= 400) fail(out.detail ?? 'Ack failed');
    return out;
  }

  if (name === 'agent_heartbeat') {
    if (!SOURCES.includes(args.source)) fail('Unknown source');
    const req = new Request('https://internal/api/agent/heartbeat', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.AGENT_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: args.source, status: args.status ?? 'online', message: args.message ?? null }),
    });
    const res = await handleHeartbeat(req, env);
    const out = (await res.json()) as Record<string, any>;
    if (res.status >= 400) fail(out.detail ?? 'Heartbeat failed');
    return out;
  }

  if (name === 'propose_app_code_change') {
    const summary = String(args.summary ?? '').trim();
    const specification = String(args.specification ?? '').trim();
    const pages = args.affected_pages ?? [];
    if (
      summary.length < 5 ||
      summary.length > 200 ||
      specification.length < 10 ||
      specification.length > 6000 ||
      !Array.isArray(pages) ||
      pages.length > 20 ||
      pages.some((p) => typeof p !== 'string' || p.length > 80)
    ) {
      fail('Invalid change request');
    }
    const rid = uuidHex();
    const t = now();
    await run(
      db,
      'INSERT INTO change_requests(id,created_at,updated_at,summary,specification,affected_pages,status) VALUES (?,?,?,?,?,?,?)',
      rid,
      t,
      t,
      summary,
      specification,
      JSON.stringify(pages),
      'review_required',
    );
    await audit(db, 'mcp_agent', 'app_change.proposed', { id: rid, summary });
    return {
      ok: true,
      request_id: rid,
      status: 'review_required',
      note: 'This is NOT a code deployment. Implementation requires an authorized GitHub change + review.',
    };
  }

  if (name === 'list_app_change_requests') {
    const limit = Number(args.limit ?? 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('Invalid limit');
    const rows = await q<Record<string, any>>(
      db,
      'SELECT id,created_at,summary,affected_pages,status FROM change_requests ORDER BY created_at DESC LIMIT ?',
      limit,
    );
    for (const r of rows) r.affected_pages = JSON.parse(r.affected_pages as string);
    return { items: rows };
  }

  throw new Error('Tool not found');
}
