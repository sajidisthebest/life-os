/**
 * Life OS — Cloudflare Workers entry point.
 *
 * Routes /api/* and /mcp through the TypeScript handlers (parity with
 * server.py / mcp_remote.py); everything else falls through to the Static
 * Assets binding, which serves the unchanged frontend from public/.
 *
 * wrangler.toml sets `run_worker_first = true` so the defensive security
 * headers below also apply to static responses, matching the FastAPI
 * middleware behavior.
 */
import type { Env } from './types.ts';
import { HttpError, json } from './util.ts';
import {
  health,
  handleLogin,
  handleLogout,
  handleSession,
  handleDashboard,
  handleGetRecords,
  handleCreateRecord,
  handleDeleteRecord,
  handleQueueAction,
  handleSync,
  handleHeartbeat,
  handlePendingActions,
  handleAckAction,
  handleSaveSetting,
  handleGenerateBriefing,
  handleAgentAudit,
} from './routes.ts';
import { handleMcp, handleMcpMethodNotAllowed } from './mcp.ts';
import { INLINED_ASSETS, INDEX_HTML } from './assets.ts';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; connect-src 'self'; font-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function withSecurity(request: Request, response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Content-Security-Policy', CSP);
  if (new URL(request.url).pathname.startsWith('/api/')) {
    headers.set('Cache-Control', 'no-store');
  }
  if ((env.PUBLIC_BASE_URL || '').startsWith('https://')) {
    headers.set('Strict-Transport-Security', 'max-age=31536000');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/health' && method === 'GET') return health();
  if (path === '/api/login' && method === 'POST') return handleLogin(request, env);
  if (path === '/api/logout' && method === 'POST') return handleLogout(request, env);
  if (path === '/api/session' && method === 'GET') return handleSession(request, env);
  if (path === '/api/dashboard' && method === 'GET') return handleDashboard(request, env);
  if (path === '/api/actions' && method === 'POST') return handleQueueAction(request, env);
  if (path === '/api/agent/sync' && method === 'POST') return handleSync(request, env);
  if (path === '/api/agent/heartbeat' && method === 'POST') return handleHeartbeat(request, env);
  if (path === '/api/agent/actions' && method === 'GET') return handlePendingActions(request, env);
  if (path === '/api/briefings/generate' && method === 'POST') return handleGenerateBriefing(request, env);
  if (path === '/api/agent/audit' && method === 'GET') return handleAgentAudit(request, env);

  const segs = path.split('/').filter(Boolean).map(decode);
  if (segs[0] === 'api' && segs[1] === 'records' && segs.length === 3) {
    if (method === 'GET') return handleGetRecords(request, env, segs[2]);
    if (method === 'POST') return handleCreateRecord(request, env, segs[2]);
  }
  if (segs[0] === 'api' && segs[1] === 'records' && segs.length === 5 && method === 'DELETE') {
    return handleDeleteRecord(request, env, segs[2], segs[3], segs[4]);
  }
  if (segs[0] === 'api' && segs[1] === 'agent' && segs[2] === 'actions' && segs.length === 5 && segs[4] === 'ack' && method === 'POST') {
    return handleAckAction(request, env, segs[3]);
  }
  if (segs[0] === 'api' && segs[1] === 'settings' && segs.length === 3 && method === 'PUT') {
    return handleSaveSetting(request, env, segs[2]);
  }

  if (path === '/mcp') {
    if (method === 'POST') return handleMcp(request, env);
    if (method === 'GET' || method === 'DELETE') return handleMcpMethodNotAllowed(request, env);
  }

  // Static frontend: inlined at build time (API deploys), with the [assets]
  // binding as a fallback when present (wrangler deploys).
  if (path === '/' || path === '/index.html') {
    return new Response(INDEX_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  const asset = INLINED_ASSETS[path];
  if (asset && (path.startsWith('/static/') || path === '/favicon.ico')) {
    return new Response(asset.body, { headers: { 'Content-Type': asset.mime } });
  }
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return json({ detail: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (e) {
      if (e instanceof HttpError) {
        response = json({ detail: e.detail }, e.status, e.headers);
      } else {
        console.error('Unhandled worker error:', e);
        response = json({ detail: 'Internal server error' }, 500);
      }
    }
    return withSecurity(request, response, env);
  },
};
