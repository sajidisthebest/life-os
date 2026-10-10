# Life OS — Cloudflare Workers + D1 Port (v0.4)

TypeScript port of the Life OS v0.4 FastAPI + SQLite app to **Cloudflare Workers + D1**.
The frontend (`public/`) is a byte-identical copy of the source `static/` bundle;
only the backend was rewritten. REST paths, data contracts, auth semantics, MCP
tools, and business logic mirror `server.py` / `mcp_remote.py`.

**Scaffold status:** code-complete and unit-tested locally. **Not deployed.**
No DNS changes, no secrets committed.

## Layout

```
src/
  index.ts      Worker entry: routing, security-headers middleware, static fallback
  routes.ts     All REST handlers (same paths/contracts as server.py)
  mcp.ts        Streamable HTTP MCP transport at POST /mcp (+405 on GET/DELETE)
  tools.ts      The 13 MCP tool specs + execution (same as mcp_remote.py)
  auth.ts       Agent bearer, HMAC session cookies, login throttling, CSRF
  db.ts         D1 helpers (records upsert, audit, list)
  briefing.ts   Rule-based morning/evening/weekly briefing text (Asia/Dhaka)
  types.ts      Env + minimal D1/Assets typings (no @cloudflare/workers-types needed)
  constants.ts  SOURCES, KINDS, WIDGETS, allowlists
migrations/
  0001_init.sql Idempotent schema (IF NOT EXISTS; seeds sync_status rows)
public/         Frontend: index.html + static/{app.js,style.css,themes.css,sunrise.svg}
tests/          node:test suite with a D1 mock over node:sqlite (real SQL)
wrangler.toml   Worker + D1 binding (id = REPLACE_WITH_D1_ID) + [assets]
```

## Endpoints (parity with server.py)

`GET /api/health` · `POST /api/login` · `POST /api/logout` · `GET /api/session` ·
`GET /api/dashboard` · `GET|POST /api/records/:kind` ·
`DELETE /api/records/:kind/:source/:external_id` · `POST /api/actions` ·
`POST /api/agent/sync` · `POST /api/agent/heartbeat` · `GET /api/agent/actions` ·
`POST /api/agent/actions/:id/ack` · `PUT /api/settings/:key` ·
`POST /api/briefings/generate` · `GET /api/agent/audit` · `POST /mcp`

## MCP tools (parity with mcp_remote.py)

`get_life_os_overview` · `list_life_os_records` · `sync_connected_data` ·
`update_workspace_setting` · `configure_home_widgets` · `set_dashboard_tagline` ·
`save_local_record` · `queue_external_action` · `get_pending_actions` ·
`acknowledge_action` · `agent_heartbeat` · `propose_app_code_change` ·
`list_app_change_requests`

Protocol versions `2025-03-26` / `2025-06-18` / `2025-11-25`; bearer realm
`LifeOS-MCP`; 2 MB body cap; notifications (no id) → `202`.

## Key behaviors preserved

- Sync: `upsert` merges; `replace` **requires** `complete=true` and deletes only
  rows of the same `(kind, source)` — never other kinds/sources. Idempotency keys
  return the stored response. 3 MB snapshot cap; 100 KB per record.
- Heartbeat updates `status`/`error` only — never `updated_at` (data freshness).
- Action allowlist: `task.complete|reopen|create|update`, `event.create`,
  `note.create`, `message.draft`. Email send is impossible (422).
- Settings allowlist + validation: theme ∈ {dark,light,forest,mocha};
  `widget_order` must be the 9 widgets exactly once; `widgets` maps names→bool;
  `hero_tagline` ≤ 160 chars; `display_name` ≤ 80 chars.
- Login: 8 failures / 15 min per client (keyed HMAC of `cf-connecting-ip`; no
  passwords or IPs stored), then 429. Sessions: HMAC-SHA256, 7-day, HttpOnly,
  `SameSite=Strict`, `Secure` when `PUBLIC_BASE_URL` is https. CSRF origin check
  on cookie-authenticated writes. Separate `AGENT_API_KEY` / `MCP_API_KEY`
  bearers with constant-time compare.
- Security headers on every response: `nosniff`, `DENY`, `no-referrer`,
  restrictive CSP, `no-store` on `/api/*`, HSTS when https.
  `run_worker_first = true` keeps these on static assets too (as in FastAPI).

## Local development

```bash
npm install
cp .env.example .dev.vars   # fill in test values; never commit real secrets
npx wrangler d1 execute life-os-db --local --file migrations/0001_init.sql
npm run dev                 # wrangler dev: Worker + assets + local D1
npm test                    # 24 tests (node:test, no wrangler needed)
npm run typecheck
```

## Deploy checklist (manual — not done by this scaffold)

1. `npx wrangler d1 create life-os-db` → paste the id into `wrangler.toml`
   (replacing `REPLACE_WITH_D1_ID`).
2. `npx wrangler d1 migrations apply life-os-db --remote`
3. `npx wrangler secret put SESSION_SECRET` (≥20 chars), `APP_PASSWORD` (≥12),
   `AGENT_API_KEY` (≥20), `MCP_API_KEY` (≥20), `PUBLIC_BASE_URL`
   (e.g. `https://lifeos.sajidpsd.com`). Three credentials must be distinct and
   not start with `SET_`, or `/api/login` returns 503.
4. `npx wrangler deploy`, then add the `lifeos` CNAME/DNS record in Cloudflare
   (do **not** touch apex, www, MX, SPF/DKIM/DMARC records).

## Free-tier notes

All queries are single-statement, indexed, and capped (`LIMIT 100–3000`;
sync ≤150 records/kind per MCP call). Well within D1/Workers free limits for a
30-minute sync cadence.

## Not verified in this scaffold

- Real `wrangler dev` / `wrangler deploy` run (wrangler not installed here beyond
  the npm script; no Cloudflare account was touched).
- Live D1 behavior (tests use `node:sqlite`, not the D1 API over the wire).
- Real Muse MCP client handshake against the deployed `/mcp`.
- `run_worker_first` asset serving in production.
