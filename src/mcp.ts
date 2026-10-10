/**
 * Streamable HTTP MCP endpoint at POST /mcp. Mirrors mcp_remote.py:
 * bearer auth (realm "LifeOS-MCP"), origin check, protocol negotiation,
 * 2MB body cap, JSON-RPC dispatch, 405 on GET/DELETE.
 */
import type { Env } from './types.ts';
import { HttpError, json, constantTimeEqual } from './util.ts';
import { SUPPORTED_PROTOCOLS, MCP_BODY_MAX_BYTES } from './constants.ts';
import { TOOLS, executeTool, errorObj, contentObj, raiseTool } from './tools.ts';

export function authenticateMcp(request: Request, env: Env): void {
  const token = env.MCP_API_KEY;
  if (!token) throw new HttpError(503, 'MCP_API_KEY is not configured');
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ') || !constantTimeEqual(auth.slice(7), token)) {
    throw new HttpError(401, 'MCP bearer token required', {
      'WWW-Authenticate': 'Bearer realm="LifeOS-MCP"',
    });
  }
  const origin = request.headers.get('origin');
  if (origin) {
    // Match the declared public origin, not an untrusted forwarded host.
    let allowed: string;
    try {
      allowed = new URL(env.PUBLIC_BASE_URL || '').host || new URL(request.url).host;
    } catch {
      allowed = new URL(request.url).host;
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new HttpError(403, 'MCP Origin not allowed');
    }
    if (parsed.host !== allowed || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new HttpError(403, 'MCP Origin not allowed');
    }
  }
}

export function handleMcpMethodNotAllowed(request: Request, env: Env): Response {
  authenticateMcp(request, env);
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  authenticateMcp(request, env);

  if (!request.headers.get('content-type')?.includes('application/json')) {
    throw new HttpError(415, 'MCP requires application/json');
  }
  const version = request.headers.get('mcp-protocol-version');
  if (version && !SUPPORTED_PROTOCOLS.includes(version)) {
    return json(
      errorObj(-32600, 'Unsupported MCP-Protocol-Version; supported: ' + SUPPORTED_PROTOCOLS.join(', ')),
      400,
    );
  }
  const text = await request.text();
  if (text.length > MCP_BODY_MAX_BYTES) throw new HttpError(413, 'MCP message exceeds 2MB');

  let message: any;
  try {
    message = JSON.parse(text);
  } catch {
    return json(errorObj(-32700, 'Parse error'), 400);
  }
  if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return json(errorObj(-32600, 'Invalid JSON-RPC request'), 400);
  }
  const method: string = message.method;
  const rid = message.id;
  if (!('id' in message)) {
    // Notification: acknowledge without a response body.
    return new Response(null, { status: 202 });
  }
  const params = message.params ?? {};
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return json(errorObj(-32602, 'Invalid params', rid));
  }

  if (method === 'initialize') {
    const offered = params.protocolVersion ?? '2025-06-18';
    const negotiated = SUPPORTED_PROTOCOLS.includes(offered) ? offered : '2025-06-18';
    return json({
      jsonrpc: '2.0',
      id: rid,
      result: {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'Life OS — Agent Control', version: '0.4.0' },
      },
    });
  }
  if (method === 'ping') return json({ jsonrpc: '2.0', id: rid, result: {} });
  if (method === 'tools/list') return json({ jsonrpc: '2.0', id: rid, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const toolName = params.name;
    const args = params.arguments ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return json(errorObj(-32602, 'arguments must be object', rid));
    }
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) return json(errorObj(-32602, 'Unknown tool', rid));
    const required = tool.inputSchema.required || [];
    const missing = required.filter((k) => !(k in args));
    if (missing.length) return json(raiseTool('Missing required arguments: ' + missing.join(', '), rid));
    const props = tool.inputSchema.properties || {};
    if (Object.keys(args).some((k) => !(k in props))) {
      return json(raiseTool('Unsupported tool arguments', rid));
    }
    try {
      const result = await executeTool(toolName, args, env, request);
      return json(contentObj(rid, result));
    } catch (exc: any) {
      const messageText = exc instanceof HttpError ? exc.detail : String(exc?.message ?? exc);
      return json(raiseTool(messageText, rid));
    }
  }
  return json(errorObj(-32601, 'Method not found', rid), 404);
}
