/**
 * Authentication: agent bearer tokens, HMAC-signed session cookies, persistent
 * login throttling, and CSRF origin checks. Mirrors server.py.
 */
import type { Env } from './types.ts';
import { HttpError, constantTimeEqual, hmacHex, parseCookies, uuidHex } from './util.ts';
import { q1, run } from './db.ts';

export const LOGIN_WINDOW_SECONDS = 900;
export const LOGIN_MAX_FAILURES = 8;
const SESSION_TTL_SECONDS = 7 * 86400;

export function credentialsReady(env: Env): boolean {
  const p = env.APP_PASSWORD || '';
  const s = env.SESSION_SECRET || '';
  const a = env.AGENT_API_KEY || '';
  return (
    p.length >= 12 &&
    s.length >= 20 &&
    a.length >= 20 &&
    ![p, s, a].some((v) => v.startsWith('SET_')) &&
    new Set([p, s, a]).size === 3
  );
}

export function isValidAgent(request: Request, env: Env): boolean {
  const header = request.headers.get('authorization') || '';
  return (
    !!env.AGENT_API_KEY &&
    header.startsWith('Bearer ') &&
    constantTimeEqual(header.slice(7), env.AGENT_API_KEY)
  );
}

export async function sessionMake(env: Env): Promise<string> {
  const payload = `${Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS}.${uuidHex()}`;
  const sig = await hmacHex(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}

export async function sessionValid(env: Env, cookie: string | undefined): Promise<boolean> {
  if (!env.SESSION_SECRET || !cookie) return false;
  const parts = cookie.split('.');
  if (parts.length !== 3) return false;
  const [expiry, rnd, sig] = parts;
  const expected = await hmacHex(env.SESSION_SECRET, `${expiry}.${rnd}`);
  const exp = Number(expiry);
  return Number.isFinite(exp) && exp > Date.now() / 1000 && constantTimeEqual(sig, expected);
}

export type Actor = 'agent' | 'owner';

/**
 * Resolve the request actor. Agent bearer wins; otherwise a valid session
 * cookie authenticates the owner. Cookie-authenticated unsafe methods require
 * a same-origin Origin header (CSRF protection), mirroring server.py.
 */
export async function authenticate(request: Request, env: Env): Promise<Actor> {
  if (isValidAgent(request, env)) return 'agent';
  const cookies = parseCookies(request.headers.get('cookie'));
  if (await sessionValid(env, cookies['lifeos_session'])) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.get('origin');
      if (origin) {
        const host = new URL(request.url).host;
        let parsed: URL;
        try {
          parsed = new URL(origin);
        } catch {
          throw new HttpError(403, 'Invalid origin');
        }
        if (parsed.host !== host || !['http:', 'https:'].includes(parsed.protocol)) {
          throw new HttpError(403, 'Invalid origin');
        }
      }
    }
    return 'owner';
  }
  throw new HttpError(401, 'Authentication required');
}

/**
 * Keyed hash of the observed peer address. In Workers the honest equivalent of
 * the server-observed socket peer is `cf-connecting-ip` (set by Cloudflare's
 * edge, not the client). We deliberately ignore spoofable X-Forwarded-For.
 * Only the HMAC digest is stored — never passwords or plaintext addresses.
 */
export async function loginClientKey(request: Request, env: Env): Promise<string> {
  const peer = request.headers.get('cf-connecting-ip') || 'unknown';
  return hmacHex(env.SESSION_SECRET, peer);
}

export async function pruneLoginFailures(db: Env['DB'], cutoffEpoch: number): Promise<void> {
  await run(db, 'DELETE FROM login_failures WHERE attempted_at<?', cutoffEpoch);
}

export async function countLoginFailures(db: Env['DB'], key: string): Promise<number> {
  const row = await q1<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM login_failures WHERE client_key=?', key);
  return row?.n ?? 0;
}

export async function recordLoginFailure(db: Env['DB'], key: string): Promise<void> {
  await run(db, 'INSERT INTO login_failures(client_key,attempted_at) VALUES (?,?)', key, Math.floor(Date.now() / 1000));
}

export async function clearLoginFailures(db: Env['DB'], key: string): Promise<void> {
  await run(db, 'DELETE FROM login_failures WHERE client_key=?', key);
}

export function sessionCookieHeader(env: Env, token: string): string {
  const secure = (env.PUBLIC_BASE_URL || '').startsWith('https://');
  return `lifeos_session=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function clearSessionCookieHeader(): string {
  return 'lifeos_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict';
}
