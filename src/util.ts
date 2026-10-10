/**
 * Small utilities: HTTP errors, time, encoding, HMAC, JSON responses.
 */

export class HttpError extends Error {
  status: number;
  detail: string;
  headers: Record<string, string>;
  constructor(status: number, detail: string, headers: Record<string, string> = {}) {
    super(detail);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

/** UTC ISO-8601 with seconds precision, e.g. 2026-10-10T13:33:42+00:00. */
export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** Current calendar date in Asia/Dhaka as YYYY-MM-DD. */
export function dhakaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Compact JSON encoding (mirrors Python json.dumps(..., separators=(',',':'))). */
export function enc(value: unknown): string {
  return JSON.stringify(value);
}

export function uuidHex(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** Constant-time string comparison (prevents timing side-channels on secrets). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}
