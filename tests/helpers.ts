/** Shared test harness: build an Env and call the Worker's fetch directly. */
import type { Env } from '../src/types.ts';
import worker from '../src/index.ts';
import { MockD1 } from './d1mock.ts';

export const AGENT_KEY = 'agent-test-key-012345678901234567890';
export const MCP_KEY = 'mcp-test-key-012345678901234567890000';

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new MockD1(),
    ASSETS: {
      fetch: async () => new Response('asset-mock', { status: 404 }),
    },
    SESSION_SECRET: 'test-secret-012345678901234567890123456',
    APP_PASSWORD: 'unit-test-password',
    AGENT_API_KEY: AGENT_KEY,
    MCP_API_KEY: MCP_KEY,
    PUBLIC_BASE_URL: 'http://localhost:8787',
    ...overrides,
  };
}

export function agentHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${AGENT_KEY}`, 'content-type': 'application/json', ...extra };
}

export function mcpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${MCP_KEY}`, 'content-type': 'application/json', ...extra };
}

export async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  return worker.fetch(new Request(`http://localhost${path}`, { ...init, headers }), env);
}

export async function postJson(env: Env, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return call(env, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export function sessionCookie(res: Response): string {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
