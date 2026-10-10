/**
 * D1 data-access helpers. Mirrors the SQLite helpers in server.py.
 */
import type { D1Database } from './types.ts';
import { now, enc, HttpError } from './util.ts';
import { KINDS, RECORD_MAX_BYTES } from './constants.ts';

export async function q<T = Record<string, any>>(
  db: D1Database,
  sql: string,
  ...params: any[]
): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results;
}

export async function q1<T = Record<string, any>>(
  db: D1Database,
  sql: string,
  ...params: any[]
): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}

export async function run(db: D1Database, sql: string, ...params: any[]): Promise<number> {
  const res = await db.prepare(sql).bind(...params).run();
  return res.meta.changes ?? 0;
}

export async function audit(
  db: D1Database,
  actor: string,
  action: string,
  detail: unknown,
): Promise<void> {
  await run(
    db,
    'INSERT INTO audit_log(created_at,actor,action,detail) VALUES(?,?,?,?)',
    now(),
    actor,
    action,
    enc(detail),
  );
}

/** Convert a raw records row into the public shape ({...row, data} without payload). */
export function toRecord(row: Record<string, any>): Record<string, any> {
  const d: Record<string, any> = { ...row };
  d.data = JSON.parse(d.payload as string);
  delete d.payload;
  return d;
}

/**
 * Insert-or-update a single record. Throws HttpError(422/413) on validation
 * failures, exactly like server.py save_record().
 */
export async function saveRecord(
  db: D1Database,
  kind: string,
  source: string,
  data: Record<string, any>,
  actor = 'agent',
): Promise<string> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HttpError(422, 'Each item must be an object');
  }
  if (!KINDS.includes(kind)) throw new HttpError(422, `Unknown kind ${kind}`);
  if (enc(data).length > RECORD_MAX_BYTES) throw new HttpError(413, 'Record too large');
  const eid = String(data.external_id ?? data.id ?? '');
  if (!eid) throw new HttpError(422, 'external_id or id is required for every record');
  const t = now();
  const rowId = `${kind}:${source}:${eid}`;
  await run(
    db,
    `INSERT INTO records(id,kind,source,external_id,payload,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(kind,source,external_id)
     DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`,
    rowId,
    kind,
    source,
    eid,
    enc(data),
    t,
    t,
  );
  return rowId;
}

export async function listRecords(
  db: D1Database,
  kind?: string,
  source?: string,
  limit = 500,
): Promise<Record<string, any>[]> {
  let sql = 'SELECT * FROM records WHERE 1=1';
  const args: any[] = [];
  if (kind) {
    sql += ' AND kind=?';
    args.push(kind);
  }
  if (source) {
    sql += ' AND source=?';
    args.push(source);
  }
  sql += ' ORDER BY updated_at DESC LIMIT ?';
  args.push(Math.min(Number.isFinite(Number(limit)) ? Number(limit) : 500, 2500));
  return (await q<Record<string, any>>(db, sql, ...args)).map(toRecord);
}
