/**
 * Minimal structural typings for the Cloudflare Workers runtime bindings used
 * by Life OS. Declared locally so `tsc --noEmit` works without installing
 * @cloudflare/workers-types. At deploy time wrangler provides the real ones.
 */

export interface D1Meta {
  changes: number;
  last_row_id: number | null;
  rows_read: number;
  rows_written: number;
  duration: number;
}

export interface D1Result<T = Record<string, any>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  first<T = Record<string, any>>(column?: string): Promise<T | null>;
  all<T = Record<string, any>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(query: string): Promise<unknown>;
}

/** Workers Static Assets binding (env.ASSETS). */
export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DB: D1Database;
  ASSETS: AssetFetcher;
  SESSION_SECRET: string;
  APP_PASSWORD: string;
  AGENT_API_KEY: string;
  MCP_API_KEY: string;
  PUBLIC_BASE_URL: string;
}
