/**
 * In-memory D1Database implementation backed by node:sqlite.
 * Lets the Worker run unmodified under node:test with real SQL semantics
 * (upserts, unique constraints, indexes) instead of a hand-rolled fake.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { D1Database, D1PreparedStatement, D1Result } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));

class MockStatement implements D1PreparedStatement {
  private db: DatabaseSync;
  private sql: string;
  private params: unknown[];

  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new MockStatement(this.db, this.sql, values);
  }

  async first<T = Record<string, any>>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (column !== undefined) return ((row[column] as T) ?? null) as T | null;
    return row as T;
  }

  async all<T = Record<string, any>>(): Promise<D1Result<T>> {
    const results = this.db.prepare(this.sql).all(...this.params) as T[];
    return {
      results,
      success: true,
      meta: { changes: 0, last_row_id: null, rows_read: results.length, rows_written: 0, duration: 0 },
    };
  }

  async run(): Promise<D1Result> {
    const info = this.db.prepare(this.sql).run(...this.params);
    const changes = Number(info.changes);
    return {
      results: [],
      success: true,
      meta: { changes, last_row_id: Number(info.lastInsertRowid), rows_read: 0, rows_written: changes, duration: 0 },
    };
  }
}

export class MockD1 implements D1Database {
  private db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    const sql = readFileSync(join(here, '..', 'migrations', '0001_init.sql'), 'utf8');
    this.db.exec(sql);
  }

  prepare(query: string): D1PreparedStatement {
    return new MockStatement(this.db, query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const out: D1Result[] = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }

  async exec(query: string): Promise<unknown> {
    this.db.exec(query);
    return {};
  }
}
