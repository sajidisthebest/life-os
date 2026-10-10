/**
 * REST route handlers. Same paths and data contracts as server.py:
 *
 *   GET    /api/health
 *   POST   /api/login
 *   POST   /api/logout
 *   GET    /api/session
 *   GET    /api/dashboard
 *   GET    /api/records/:kind
 *   POST   /api/records/:kind
 *   DELETE /api/records/:kind/:source/:external_id
 *   POST   /api/actions
 *   POST   /api/agent/sync
 *   POST   /api/agent/heartbeat
 *   GET    /api/agent/actions
 *   POST   /api/agent/actions/:id/ack
 *   PUT    /api/settings/:key
 *   POST   /api/briefings/generate
 *   GET    /api/agent/audit
 */
import type { D1Database, Env } from './types.ts';
import { HttpError, json, now, dhakaToday, enc, uuidHex, constantTimeEqual, parseCookies } from './util.ts';
import { q, q1, run, audit, saveRecord, listRecords, toRecord } from './db.ts';
import {
  authenticate,
  credentialsReady,
  sessionMake,
  sessionValid,
  isValidAgent,
  loginClientKey,
  pruneLoginFailures,
  countLoginFailures,
  recordLoginFailure,
  clearLoginFailures,
  sessionCookieHeader,
  clearSessionCookieHeader,
  LOGIN_WINDOW_SECONDS,
  LOGIN_MAX_FAILURES,
} from './auth.ts';
import {
  KINDS,
  SETTING_KEYS,
  THEMES,
  WIDGETS,
  ACTION_ALLOWLIST,
  SYNC_BODY_MAX_BYTES,
} from './constants.ts';
import { briefText } from './briefing.ts';

async function readJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(422, 'Invalid JSON body');
  }
}

export function health(): Response {
  return json({ ok: true, service: 'life-os', time: now() });
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!credentialsReady(env)) {
    throw new HttpError(503, 'Server credentials are not configured. See README.md');
  }
  const body = await readJson(request);
  if (typeof body?.password !== 'string') throw new HttpError(422, 'password is required');

  const key = await loginClientKey(request, env);
  const cutoff = Math.floor(Date.now() / 1000) - LOGIN_WINDOW_SECONDS;
  await pruneLoginFailures(env.DB, cutoff);
  const attempts = await countLoginFailures(env.DB, key);
  const locked = attempts >= LOGIN_MAX_FAILURES;
  const valid = constantTimeEqual(env.APP_PASSWORD, body.password);
  if (!locked && !valid) await recordLoginFailure(env.DB, key);
  else if (!locked && valid) await clearLoginFailures(env.DB, key);

  if (locked) {
    throw new HttpError(429, 'Too many login attempts; retry later', {
      'Retry-After': String(LOGIN_WINDOW_SECONDS),
    });
  }
  if (!valid) throw new HttpError(401, 'Invalid password');

  const token = await sessionMake(env);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookieHeader(env, token) });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  await authenticate(request, env);
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookieHeader() });
}

export async function handleSession(request: Request, env: Env): Promise<Response> {
  // Mirrors server.py /api/session: report authentication without raising.
  const cookies = parseCookies(request.headers.get('cookie'));
  const authenticated =
    isValidAgent(request, env) || (await sessionValid(env, cookies['lifeos_session']));
  return json({ authenticated, configured: credentialsReady(env) });
}

export async function dashboardData(db: D1Database): Promise<Record<string, any>> {
  const rows = (await q<Record<string, any>>(db, 'SELECT * FROM records ORDER BY updated_at DESC LIMIT 3000')).map(toRecord);
  const statuses = await q<Record<string, any>>(db, 'SELECT * FROM sync_status ORDER BY source');
  const settingsRows = await q<{ key: string; value: string }>(db, 'SELECT * FROM settings');
  const preferences: Record<string, any> = {};
  for (const r of settingsRows) preferences[r.key] = JSON.parse(r.value);
  const queue = await q<Record<string, any>>(
    db,
    "SELECT * FROM action_queue WHERE status IN ('pending','failed') ORDER BY created_at DESC LIMIT 100",
  );
  const briefings = rows.filter((r) => r.kind === 'briefings');
  const changes = await q<Record<string, any>>(
    db,
    'SELECT id,created_at,summary,specification,affected_pages,status FROM change_requests ORDER BY created_at DESC LIMIT 20',
  );
  return {
    records: rows,
    integrations: statuses,
    preferences,
    pending_actions: queue,
    change_requests: changes,
    server_time: now(),
    timezone: 'Asia/Dhaka',
    briefings: briefings.slice(0, 10),
  };
}

export async function handleDashboard(request: Request, env: Env): Promise<Response> {
  await authenticate(request, env);
  return json(await dashboardData(env.DB));
}

function parseLimit(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new HttpError(422, 'Invalid limit');
  return n;
}

export async function handleGetRecords(request: Request, env: Env, kind: string): Promise<Response> {
  await authenticate(request, env);
  if (!KINDS.includes(kind)) throw new HttpError(404, 'Unknown record type');
  const url = new URL(request.url);
  const source = url.searchParams.get('source') || undefined;
  const limit = parseLimit(url.searchParams.get('limit'), 500);
  return json({ items: await listRecords(env.DB, kind, source, limit) });
}

export async function handleCreateRecord(request: Request, env: Env, kind: string): Promise<Response> {
  const actor = await authenticate(request, env);
  if (!KINDS.includes(kind)) throw new HttpError(404, 'Unknown record type');
  const body = await readJson(request);
  const source = body?.source ?? 'local';
  if (source !== 'local' && actor !== 'agent') {
    throw new HttpError(403, 'Only agents may update external source records');
  }
  if (typeof body?.data !== 'object' || body.data === null || Array.isArray(body.data)) {
    throw new HttpError(422, 'data must be an object');
  }
  const data = { ...body.data };
  if (!data.id) data.id = uuidHex();
  const rid = await saveRecord(env.DB, kind, source, data, actor);
  await audit(env.DB, actor, 'record.upsert', { id: rid });
  return json({ id: rid, data });
}

export async function handleDeleteRecord(
  request: Request,
  env: Env,
  kind: string,
  source: string,
  externalId: string,
): Promise<Response> {
  const actor = await authenticate(request, env);
  if (source !== 'local' && actor !== 'agent') {
    throw new HttpError(403, 'Only an agent may delete external records');
  }
  const changes = await run(
    env.DB,
    'DELETE FROM records WHERE kind=? AND source=? AND external_id=?',
    kind,
    source,
    externalId,
  );
  await audit(env.DB, actor, 'record.delete', { kind, source, external_id: externalId });
  return json({ ok: changes > 0 });
}

export async function handleQueueAction(request: Request, env: Env): Promise<Response> {
  const actor = await authenticate(request, env);
  const body = await readJson(request);
  const { source, action, payload } = body ?? {};
  if (!ACTION_ALLOWLIST.includes(action)) {
    // Never support sending email, deleting data, or canceling meetings automatically.
    throw new HttpError(422, 'Action is not on the approved allowlist');
  }
  if (typeof source !== 'string' || typeof payload !== 'object' || payload === null) {
    throw new HttpError(422, 'source and payload are required');
  }
  const aid = uuidHex();
  const t = now();
  await run(
    env.DB,
    'INSERT INTO action_queue(id,created_at,updated_at,source,action,payload,status) VALUES(?,?,?,?,?,?,?)',
    aid,
    t,
    t,
    source,
    action,
    enc(payload),
    'pending',
  );
  await audit(env.DB, actor, 'action.queued', { id: aid, action, source });
  return json({
    ok: true,
    action_id: aid,
    status: 'pending',
    note: 'Action queued for authorized external agent; not yet applied to source',
  });
}

export async function handlePendingActions(request: Request, env: Env): Promise<Response> {
  const actor = await authenticate(request, env);
  if (actor !== 'agent') throw new HttpError(403, 'Agent token required');
  const status = new URL(request.url).searchParams.get('status') ?? 'pending';
  const rows = await q<Record<string, any>>(
    env.DB,
    'SELECT * FROM action_queue WHERE status=? ORDER BY created_at LIMIT 100',
    status,
  );
  return json({
    items: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload as string) })),
  });
}

export async function handleAckAction(request: Request, env: Env, actionId: string): Promise<Response> {
  const actor = await authenticate(request, env);
  if (actor !== 'agent') throw new HttpError(403, 'Agent token required');
  const body = await readJson(request);
  if (!['completed', 'failed', 'rejected'].includes(body?.status)) {
    throw new HttpError(422, 'Invalid status');
  }
  const changes = await run(
    env.DB,
    'UPDATE action_queue SET status=?,error=?,updated_at=? WHERE id=?',
    body.status,
    body.error ?? null,
    now(),
    actionId,
  );
  if (!changes) throw new HttpError(404, 'Unknown action id');
  await audit(env.DB, actor, 'action.ack', { id: actionId, status: body.status });
  return json({ ok: true });
}

export async function handleSync(request: Request, env: Env): Promise<Response> {
  const actor = await authenticate(request, env);
  if (actor !== 'agent') throw new HttpError(403, 'Agent token required');
  const raw = await request.text();
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(422, 'Invalid JSON body');
  }
  const source = body?.source;
  const items = body?.items ?? {};
  const mode = body?.mode ?? 'upsert';
  const complete = body?.complete ?? false;
  const idempotencyKey = body?.idempotency_key ?? null;
  const error = body?.error ?? null;

  if (typeof source !== 'string' || !source) throw new HttpError(422, 'source is required');
  if (mode !== 'upsert' && mode !== 'replace') throw new HttpError(422, 'mode must be upsert or replace');
  if (mode === 'replace' && !complete) throw new HttpError(422, 'replace requires complete=true');
  if (source === 'local') throw new HttpError(422, 'local source is reserved');
  if (typeof items !== 'object' || items === null || Array.isArray(items)) {
    throw new HttpError(422, 'items must be an object');
  }
  for (const [kind, arr] of Object.entries(items)) {
    if (!KINDS.includes(kind)) throw new HttpError(422, `Invalid kind ${kind}`);
    if (!Array.isArray(arr) || (arr as any[]).some((x) => typeof x !== 'object' || x === null)) {
      throw new HttpError(422, `Invalid items for kind ${kind}`);
    }
  }
  if (raw.length > SYNC_BODY_MAX_BYTES) throw new HttpError(413, 'Snapshot too large');

  if (idempotencyKey) {
    const prev = await q1<{ response: string }>(env.DB, 'SELECT response FROM idempotency WHERE key=?', idempotencyKey);
    if (prev) return json(JSON.parse(prev.response));
  }

  const seen: string[] = [];
  for (const [kind, arr] of Object.entries(items)) {
    const ids: string[] = [];
    for (const data of arr as Record<string, any>[]) {
      ids.push(await saveRecord(env.DB, kind, source, data, actor));
    }
    if (mode === 'replace') {
      // Replace exactly the supplied kind(s), never unrelated types or other services.
      const existing = await q<{ id: string }>(env.DB, 'SELECT id FROM records WHERE kind=? AND source=?', kind, source);
      for (const old of existing) {
        if (!ids.includes(old.id)) await run(env.DB, 'DELETE FROM records WHERE id=?', old.id);
      }
    }
    seen.push(...ids);
  }

  const cnt = await q1<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM records WHERE source=?', source);
  const count = cnt?.n ?? 0;
  const t = now();
  await run(
    env.DB,
    `INSERT INTO sync_status(source,updated_at,item_count,status,error,freshness) VALUES(?,?,?,?,?,?)
     ON CONFLICT(source) DO UPDATE SET
       updated_at=excluded.updated_at, item_count=excluded.item_count,
       status=excluded.status, error=excluded.error, freshness=excluded.freshness`,
    source,
    t,
    count,
    error ? 'error' : 'synced',
    error,
    complete ? 'complete' : 'partial',
  );
  await audit(env.DB, 'agent', 'sync', {
    source,
    records_received: seen.length,
    mode,
    complete,
  });
  const result = { ok: true, source, received: seen.length, stored: count, at: now() };
  if (idempotencyKey) {
    await run(env.DB, 'INSERT INTO idempotency(key,created_at,response) VALUES(?,?,?)', idempotencyKey, t, enc(result));
  }
  return json(result);
}

export async function handleHeartbeat(request: Request, env: Env): Promise<Response> {
  const actor = await authenticate(request, env);
  if (actor !== 'agent') throw new HttpError(403, 'Agent token required');
  const body = await readJson(request);
  const source = body?.source;
  const status = body?.status ?? 'online';
  const message = body?.message ?? null;
  if (typeof source !== 'string' || !source) throw new HttpError(422, 'source is required');

  const old = await q1<{ item_count: number }>(env.DB, 'SELECT item_count FROM sync_status WHERE source=?', source);
  // Heartbeat is NOT a data sync. Never overwrite last data updated_at.
  await run(
    env.DB,
    `INSERT INTO sync_status(source,status,item_count,error) VALUES(?,?,?,?)
     ON CONFLICT(source) DO UPDATE SET status=excluded.status, error=excluded.error`,
    source,
    status === 'online' ? 'connected' : status,
    old?.item_count ?? 0,
    message,
  );
  await audit(env.DB, 'agent', 'heartbeat', { source, status, message });
  return json({ ok: true, received_at: now() });
}

/**
 * Validate and persist a workspace setting. Shared by the REST handler and
 * the MCP tools (which surface validation failures as tool errors).
 */
export async function saveSetting(
  db: D1Database,
  key: string,
  value: any,
  actor = 'agent',
): Promise<{ ok: true }> {
  if (!SETTING_KEYS.includes(key)) throw new HttpError(422, 'Unsupported setting');
  if (key === 'theme' && !THEMES.includes(value)) throw new HttpError(422, 'Unsupported theme');
  if (key === 'widget_order') {
    if (
      !Array.isArray(value) ||
      value.length !== WIDGETS.length ||
      new Set(value).size !== WIDGETS.length ||
      (value as any[]).some((v) => !WIDGETS.includes(v))
    ) {
      throw new HttpError(422, 'Widget order must contain each supported widget exactly once');
    }
  }
  if (key === 'widgets') {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).some((k) => !WIDGETS.includes(k)) ||
      Object.values(value).some((v) => typeof v !== 'boolean')
    ) {
      throw new HttpError(422, 'Widget visibility must be a mapping of supported widget names to booleans');
    }
  }
  if (key === 'hero_tagline' && (typeof value !== 'string' || value.length > 160)) {
    throw new HttpError(422, 'Hero tagline must be text of at most 160 characters');
  }
  if (key === 'display_name' && (typeof value !== 'string' || value.length > 80)) {
    throw new HttpError(422, 'Display name must be text of at most 80 characters');
  }
  await run(db, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, enc(value));
  return { ok: true };
}

export async function handleSaveSetting(request: Request, env: Env, key: string): Promise<Response> {
  await authenticate(request, env);
  const body = await readJson(request);
  return json(await saveSetting(env.DB, key, body?.value));
}

export async function handleGenerateBriefing(request: Request, env: Env): Promise<Response> {
  const actor = await authenticate(request, env);
  const body = await readJson(request);
  const type = body?.type ?? 'morning';
  if (!['morning', 'evening', 'weekly'].includes(type)) throw new HttpError(422, 'Invalid type');
  const rows: Record<string, any>[] = [];
  for (const kind of ['tasks', 'events', 'messages', 'habits']) {
    rows.push(...(await listRecords(env.DB, kind, undefined, 2500)));
  }
  const { summary, details } = briefText(type, rows);
  const data = {
    id: uuidHex(),
    type,
    date: dhakaToday(),
    summary,
    details,
    generated_at: now(),
    method: 'rule-based',
    warning: 'Computed from available snapshots; not an LLM-generated narrative.',
  };
  await saveRecord(env.DB, 'briefings', 'local', data, actor);
  await audit(env.DB, actor, 'brief.generate', { type });
  return json(data);
}

export async function handleAgentAudit(request: Request, env: Env): Promise<Response> {
  const actor = await authenticate(request, env);
  if (actor !== 'agent') throw new HttpError(403, 'Agent token required');
  const limit = Math.min(parseLimit(new URL(request.url).searchParams.get('limit'), 50), 250);
  const items = await q<Record<string, any>>(env.DB, 'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit);
  return json({ items });
}
