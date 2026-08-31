# Mako Apps Platform — Build Mako-Compatible Apps via MCP, Claude Code, and GitHub

**Status:** Proposal / plan — **vertical slice of Phase 1 + 1.5 implemented on this branch** (see §0)

## 0. Implemented vertical slice (this branch)

The full headless iteration loop on scoped `revops_` keys. **MCP data access
is read-only by design** — there is no write scope; keys carry `mcp` +
`query:read` (the default for newly created keys). Legacy unscoped keys retain
REST compatibility but cannot access MCP and must be rotated. Scoped MCP keys
are rejected outside `POST /api/mcp`, preventing REST endpoints from bypassing
MCP query policy. Key expiry, audit logging, and rate limiting are tracked as
API-key platform hardening, separate from MCP:

- **`POST /api/mcp`** — Mako as a stateless MCP server (Streamable HTTP, JSON mode). Bearer workspace API key with `mcp` scope required. Bridges the existing server-side agent tools: all app tools (`create_app`, `app_write_file`, bindings, versions, …), read-only SQL query execution, and MongoDB discovery/inspection. Arbitrary MongoDB JavaScript (`mongo_execute_query`) is not bridged at all; app bindings/materializations are always read-only. System skills exposed as `mako://skills/*` resources. Files: `api/src/mcp/`, `api/src/routes/mcp-server.routes.ts`.
- **Read-only execution boundary** — PostgreSQL/Cloud SQL/Redshift use read-only transactions, MySQL uses `START TRANSACTION READ ONLY`, and ClickHouse uses its `readonly=2` query setting. Engines the SQL analyzer cannot validate (MongoDB shell code, Cloudflare KV) fail closed; SQL engines without a session-level read-only mode (BigQuery, MSSQL, D1) are enforced lexically via the single-statement `SELECT`/`WITH` rule.
- **Signed draft previews** — `create_preview_token` MCP tool mints `mpt_*` HMAC tokens (60s–30min TTL, single app); `/api/preview/:token` serves the draft definition and `/api/preview/:token/binding/:id/execute` runs draft bindings through the same read-only/row-cap/timeout/rate-limit envelope as public shares. Frontend `/preview/:token` renders the draft and publishes machine-observable state (`window.__MAKO_PREVIEW_STATE__`, `[mako-preview-ready|error]` console markers).
- **`render_app` MCP tool** — pooled server-side headless Chromium (env-gated via `RENDER_APP_BROWSER_PATH`, graceful degradation) renders the draft and returns status + errors + console + JPEG screenshot as MCP image content.

Quickstart — **Claude Code**:

```bash
claude mcp add --transport http mako https://<host>/api/mcp \
  --header "Authorization: Bearer revops_..."
# or team-shared, checked into the repo (.mcp.json — Mako seeds this one):
#   { "mcpServers": { "mako": { "type": "http",
#     "url": "${MAKO_API_URL:-https://app.mako.ai}/api/mcp" } } }
#   (no header: the client signs in via OAuth; add the Bearer header for CI)
# then: "Build me an app showing revenue by month" — the agent creates the
# app, iterates with render_app (or create_preview_token + local browser),
# and any open Mako tab live-reloads on every edit.
```

**Codex CLI** (`~/.codex/config.toml`) — native streamable-HTTP client:

```toml
[mcp_servers.mako]
url = "https://<host>/api/mcp"
bearer_token_env_var = "MAKO_API_KEY"   # sends Authorization: Bearer $MAKO_API_KEY
# on older Codex versions enable: experimental_use_rmcp_client = true
# fallback for stdio-only versions:
# command = "npx"
# args = ["-y", "mcp-remote", "https://<host>/api/mcp",
#         "--header", "Authorization: Bearer ${MAKO_API_KEY}"]
```

Claude Desktop / claude.ai custom connectors need OAuth (no custom headers) — covered by open decision #1; interim workaround is the same `mcp-remote` proxy.
**Goal:** Let anyone build Mako apps from *outside* the Mako UI — with an MCP client (Claude Desktop, Claude Code, any agent), or directly in a GitHub repo with Claude Code — and let published apps run **standalone**, needing only a simple API key that grants access to their data resources.

---

## 1. Where we already are

Almost everything needed already exists inside the product; what's missing is the outward-facing surface. Inventory of reusable building blocks:

| Building block | Where | State |
| --- | --- | --- |
| **App definition contract** | `packages/schemas/src/app.schema.ts` (`AppDefinitionSchema`: `title`, `template`, `runtime`, `entrypoint`, `files[]`, `dependencies{}`, `dataBindings[]`) | ✅ Canonical, shared API↔frontend |
| **Headless app authoring tools** | `api/src/agent-lib/tools/server-app-tools.ts` (`create_app`, `app_write_file`, `app_edit_file`, `app_add_dependency`, `app_create_data_binding`, `app_save_version`, …) | ✅ All server-side, work without a browser |
| **Draft → publish snapshots + version history** | `api/src/services/app-version.service.ts`, `EntityVersion` | ✅ |
| **Workspace API keys** | `IWorkspaceApiKey` on `Workspace`, `revops_` Bearer tokens, SHA-256 hashed, `unifiedAuthMiddleware` | 🟡 MCP scopes (`mcp`, `query:read` — read-only by design, no write scope) implemented; expiry, audit logging, and rate limiting tracked as separate API-key platform work |
| **Git → Mako sync precedent** | dbt: `IDbtRepoBinding` + GitHub App webhooks (`api/src/routes/github.routes.ts` → `dbt-ci.service.ts`) | ✅ Proven pattern, dbt-only |
| **Public data serving for published apps** | `api/src/services/public-live-query.service.ts` (serves `app.published` snapshot bindings via share token) | ✅ Token-gated, read-only |
| **MCP infrastructure** | `api/src/services/mcp-client.service.ts`, risk tiers (`read`/`write_safe`/`write_destructive`), tool restriction model | ✅ **Client only** — Mako does not expose an MCP *server* |
| **App runtime** | `app/src/app-runtime/preview.ts` (esm.sh import map, sandboxed iframe, injected `@makoai/app-sdk`: `useQuery`, `useDuckDB`, `useTheme`, `useLocation`, `navigate`) | ✅ But embedded in the frontend; `@makoai/app-sdk` is a synthetic module, **not a real npm package** |
| **Machine-readable API** | `GET /api/openapi.json`, Consoles API, `/api/workspaces/:id/execute` | ✅ |

**Gaps** (the actual work): Mako-as-MCP-server, an on-disk repo format + CLI, a published `@makoai/app-sdk` package, GitHub repo binding for apps, API-key scopes, and a standalone runtime + app-scoped data endpoint.

---

## 2. Proposed architecture

Three ways in, one contract (`AppDefinition`), one way out:

```
┌─ Authoring paths ──────────────────────────────────────────┐
│                                                            │
│  A. MCP client (Claude Desktop / Claude Code / any agent)  │
│       └── Mako MCP Server  (/api/mcp, Streamable HTTP)     │
│                                                            │
│  B. GitHub repo + Claude Code                              │
│       ├── mako CLI  (init / dev / push / publish)          │
│       └── GitHub App repo binding (push-to-sync, like dbt) │
│                                                            │
│  C. In-product agent (exists today, unchanged)             │
│                                                            │
└───────────────┬────────────────────────────────────────────┘
                ▼
        AppDefinition (@mako/schemas)  →  MakoApp draft → publish
                ▼
┌─ Runtime paths ────────────────────────────────────────────┐
│  1. In Mako:      /a/:appId            (exists)            │
│  2. Public share: /share/:token        (exists)            │
│  3. Standalone:   @mako/app-runtime + app-scoped API key   │
│                   (self-hosted static bundle or embed)     │
└────────────────────────────────────────────────────────────┘
```

Everything is keyed by **workspace-scoped API keys with scopes** — one credential story for MCP, CLI, git sync, and standalone data access.

---

## 3. Workstreams

### WS0 — API key scopes & hardening (foundation, prerequisite for everything)

Extend the existing `IWorkspaceApiKey` (embedded on `Workspace`) rather than inventing a new credential:

- Add `scopes: string[]` and `expiresAt?: Date`. Proposed scope vocabulary (coarse, resource-oriented):
  - `apps:read`, `apps:write`, `apps:publish`
  - `bindings:execute` (run an app's *stored* bindings — never arbitrary SQL)
  - `query:execute` (arbitrary query via `/execute` — the dangerous one, off by default)
  - `consoles:read`, `dashboards:read`, `schema:read`, `mcp` (may use the MCP server)
  - `resourceFilter?: { appIds?: ObjectId[] }` — optional pin of a key to specific apps.
- Enforce in `unifiedAuthMiddleware` (`api/src/auth/unified-auth.middleware.ts`): attach `scopes` to context; add a `requireScope("...")` helper used per-route. **Legacy keys (no scopes field) keep full access** for back-compat; UI nudges rotation.
- Introduce a second key class for standalone frontends: **publishable app keys** (`mako_pk_...`) — restricted to `bindings:execute` on a single app's *published* snapshot, optional HTTP `Origin` allowlist, safe to embed in client code. Secret keys (`revops_`, rename alias `mako_sk_` later) remain server-side only.
- Add real **rate limiting** for key-authenticated routes (currently only in-memory limiting on auth endpoints). Per-key + per-workspace buckets; Redis-backed when `REDIS_URL` is set, in-memory fallback.
- CORS: add `x-workspace-id` to `allowHeaders` (read by `workspace.middleware.ts` but not currently allowed cross-origin).

### WS1 — Mako MCP Server (fastest path to "build apps with Claude")

Expose Mako itself as a remote MCP server so any MCP client — Claude Code, Claude Desktop, Cursor, custom agents — can build and manage apps conversationally. **No new format needed; this ships value first.**

- **Transport & mount:** `@modelcontextprotocol/sdk` server + Streamable HTTP transport at `POST /api/mcp` (registered in `register-routes.ts`). Stateless per-request server instances (fits Hono + horizontal scaling).
- **Auth:** `Authorization: Bearer revops_...` through `unifiedAuthMiddleware` + `requireScope("mcp")`. Key already resolves workspace + acting user — the MCP session inherits exactly that context. (MCP spec's OAuth flow can come later; API key is the "simple" story the platform goal asks for.)
- **Tools (v1):** thin wrappers over existing server-side implementations — factor `server-app-tools.ts` so each tool's core is callable from both the in-product agent and the MCP server (single implementation, two registrations):
  - App suite: `create_app`, `get_app_state`, `app_read_file`, `app_write_file`, `app_edit_file`, `app_delete_file`, `app_add_dependency`, `app_create_data_binding`, `app_update_data_binding`, `app_save_version`, `publish_app`, `list_apps`
  - Data context: `list_connections`, `get_schema` (introspection), `run_query` (gated behind `query:execute`), `run_binding`
  - Docs: `read_skill` exposing the git-versioned system skills (`api/src/agent-skills/apps/SKILL.md` is already the authoritative "how to build a Mako app" playbook — serve it to external agents too, via MCP resources)
- **Safety model:** reuse the existing risk-tier vocabulary (`read` / `write_safe` / `write_destructive`) as MCP tool annotations; destructive tools (delete file/binding/app) marked accordingly so clients prompt.
- **Client setup story:** `claude mcp add --transport http mako https://app.mako.ai/api/mcp --header "Authorization: Bearer revops_..."` — one line in the docs.

### WS2 — App repo format, published SDK, and `mako` CLI ("a Mako app is a repo")

Define the on-disk serialization of `AppDefinition` so an app can live in git and be authored with any editor/agent:

```
my-app/
├── mako.app.json        # manifest: name, entrypoint, runtime, dependencies,
│                        #   binding metadata (connection by ALIAS, not id)
├── bindings/
│   ├── revenue.sql      # binding code as real files (sql/js/mongodb)
│   └── revenue.json     # per-binding config: language, materialization, schedule
├── src/
│   └── App.tsx          # the virtual FS, checked out for real
├── CLAUDE.md            # generated: Mako app constraints + SDK reference
└── .mako/               # local state: workspace/app id mapping (gitignored)
```

Key design points:

- **Connection aliasing:** `dataBindings[].connectionId` is workspace-specific and must never be hardcoded in a repo. The manifest references connections by **alias** (e.g. `"warehouse"`); `mako push` / repo-binding sync resolves aliases → connection ids per workspace (interactive on first push, stored in `.mako/`). Same trick as the existing `{{ dbt_schema }}` token.
- **Publish `@makoai/app-sdk` as a real npm package:** types + a dev implementation of `useQuery`/`useDuckDB`/`useTheme`/`useLocation` that calls the Mako API with an API key. In-product, the injected synthetic module keeps winning (import-map override), so runtime behavior is unchanged; the package exists so repos type-check and run locally.
- **`mako` CLI** (`packages/cli`, `npx @makoai/cli`), auth via `MAKO_API_KEY` env or `mako login`:
  - `mako init` — scaffold from `createAppScaffold` + CLAUDE.md + SDK types
  - `mako pull` / `mako push` — bidirectional sync between repo ⇄ app draft (REST, `apps:write`)
  - `mako dev` — local Vite dev server with the dev SDK hitting real bindings (`bindings:execute`)
  - `mako publish` — snapshot + publish (`apps:publish`)
  - `mako export` — build a standalone static bundle (see WS4)
- **Claude Code compatibility is free** once the repo format + CLAUDE.md exist: the generated CLAUDE.md embeds the app constraints (cdn runtime: ESM via esm.sh, no build step, no Tailwind; SDK surface; binding rules) distilled from `agent-skills/apps/SKILL.md`. Optionally ship it as a Claude Code plugin/skill later.
- **Runtime constraint honesty:** v1 targets the existing `cdn` runtime — source files are the artifact, no bundler. The schema's dormant `webcontainer` runtime is the future path for repos that need a real build; explicitly out of scope for v1.

### WS3 — GitHub repo binding for apps (continuous sync, like dbt)

For teams that want git as the source of truth without running a CLI:

- New `IAppRepoBinding` on `MakoApp`, modeled on `IDbtRepoBinding` (`{ provider: "github", installationId, owner, repo, branch, subdirectory?, lastSyncedSha }`).
- Reuse the **existing GitHub App** install flow and webhook route (`github.routes.ts`): on push to the bound branch, parse the repo format from WS2, validate against `AppDefinitionSchema`, apply as the app draft, record sync status. One-way git → Mako in v1 (matching dbt); a bound app's files become read-only in the Mako editor with a "synced from GitHub" banner.
- v1.5: **PR previews** — on `pull_request`, validate + create an ephemeral version snapshot and report a commit status (reuse the dbt CI service pattern).
- Later: two-way (Mako edits open a PR), and "install from repo" — point at any public repo in the format and get an app (the template-gallery / marketplace seed).

### WS4 — Standalone apps (API-key-only runtime)

Make a *published* app runnable outside Mako entirely:

- **Server:** app-scoped data endpoint `POST /api/apps/:appId/bindings/:bindingId/run`, authenticated by a **publishable app key** (WS0). It executes only the **stored binding from the published snapshot** — the client never sends SQL, so a leaked publishable key can only read what the app already shows. Generalize `public-live-query.service.ts` (which already does exactly this for share tokens) to accept app keys; serve parquet artifacts for materialized bindings.
- **Runtime package:** extract the preview engine from `app/src/app-runtime/preview.ts` into `@mako/app-runtime` — import-map/esm.sh loader + SDK provider wired to the endpoint above instead of the parent-window `postMessage` bridge. The in-product preview becomes a consumer of the same package (one engine, two hosts).
- **Distribution options** (in order of shipping):
  1. `mako export` → static bundle (`index.html` + published files + runtime + baked-in publishable key + API base URL) — host on any static host.
  2. `<script>` embed / iframe embed of the share URL with an app key (custom-domain-friendly).
  3. Mako-hosted custom domains (later).
- **Security posture:** publishable keys are single-app, published-snapshot-only, `bindings:execute`-only, origin-allowlisted, revocable, rate-limited (WS0). Row caps + the existing 500k truncation flag apply. Document loudly that secret keys must never ship in a bundle; `mako export` refuses a `revops_`/secret key.

---

## 4. Phased plan

### Phase 0 — Credential & platform foundations (~1–2 wks)

Prerequisite for every other phase; nothing external ships until this lands.

**Deliverables**
- `scopes[]` + `expiresAt` + optional `resourceFilter.appIds[]` on `IWorkspaceApiKey`; `requireScope()` helper enforced in `unifiedAuthMiddleware`; legacy (scope-less) keys keep full access but are flagged for rotation in the UI.
- Per-key **rate limiting** (Redis-backed when `REDIS_URL` set, in-memory fallback) and a per-key **usage log** (endpoint, timestamp, rows returned) replacing bare `lastUsedAt`.
- Key lifecycle rules: revoke-on-member-removal job; admin view of all keys; role changes of the creator re-evaluated at request time (see loophole L2).
- CORS `allowHeaders` + `x-workspace-id`; register key prefixes with GitHub secret scanning.

**Exit criteria:** a key scoped `apps:write` gets 403 on `/execute`; a demoted creator's key loses admin routes immediately; rate-limit headers observable; existing integrations unbroken.

### Phase 1 — Mako MCP server (~2–3 wks)

**Deliverables**
- Factor `server-app-tools.ts` cores into transport-agnostic functions; register them twice (in-product agent + MCP).
- MCP server at `POST /api/mcp` (Streamable HTTP, stateless per request), Bearer API key + `requireScope("mcp")`, using `requireWorkspace` (not an inline check).
- Tool suite: app CRUD/file/binding/version/publish tools; `list_connections`, `get_schema`, `run_binding`; `run_query` gated behind `query:execute`; system skills (`agent-skills/apps/SKILL.md` etc.) exposed as MCP **resources**.
- Feedback loop plumbing: preview-error report endpoint + `get_preview_errors` tool; `create_preview_token` (short-TTL signed draft-preview URL for headless screenshots).
- Docs + quickstart ("build a Mako app from Claude Code in 5 minutes").

**Exit criteria:** from a clean machine with only an API key, Claude Code creates, iterates (reading real preview errors), and publishes an app end-to-end; a human watching `/a/:appId` sees every edit live-reload; destructive tools carry MCP annotations.

### Phase 2 — Repo format, published SDK, `mako` CLI (~3–4 wks)

**Deliverables**
- Repo format spec (`mako.app.json`, `src/`, `bindings/*`) + zod validation shared with the server; connection **aliases** resolved at push.
- `@makoai/app-sdk` on npm — types + dev implementation, **generated from the same source** as the synthetic module in `preview.ts` (single source of truth, see L19).
- `@makoai/cli`: `init`, `pull`, `push`, `dev`, `publish`, `check` (headless validation against the real cdn/import-map runtime), generated `CLAUDE.md`.

**Exit criteria:** `pull → edit → push` round-trips losslessly; `mako dev` renders with real workspace data; `mako check` catches an esm.sh-incompatible import before push.

### Phase 3 — GitHub repo binding for apps (~2 wks)

**Deliverables**
- `IAppRepoBinding` (pin **numeric repo id + installationId**, not just owner/name — see L12); signature-verified webhook path reusing `github.routes.ts`; push-to-sync updates the **draft only**; publish stays a human action in Mako.
- Bound apps read-only in the Mako editor with sync-status banner; PR validation check (schema + `mako check`) via the dbt CI pattern.
- New-binding/alias confirmation gate for synced changes (see L13).

**Exit criteria:** push to bound branch updates the draft in <30s; a forged webhook is rejected; adding a new binding via git requires one-time human mapping approval.

### Phase 4 — Standalone apps (~3–4 wks)

**Deliverables**
- Publishable app keys (`mako_pk_...`): single app, **published snapshot only**, `bindings:execute` only, origin allowlist, revocable.
- `POST /api/apps/:appId/bindings/:bindingId/run` generalizing `public-live-query.service.ts`; parquet artifact serving under the same key scoping.
- `@mako/app-runtime` extracted from `preview.ts`; the in-product preview becomes a consumer of it.
- `mako export` (static bundle; refuses secret keys and scans output for `revops_`/`mako_sk_`); `<script>`/iframe embed.
- Per-app **network allowlist / CSP** for app iframes and exported bundles (see L10).
- Dependency pinning at publish: exact versions locked into the snapshot; esm.sh proxy/pinning strategy (see L11).

**Exit criteria:** an exported bundle on a third-party static host renders with only a `mako_pk_` key; that key cannot read drafts, other apps, or run ad-hoc queries; leaked-key blast radius = exactly what the app already displays.

Phase 1 alone delivers the headline: *anyone with a workspace API key can point Claude Code/Desktop at Mako's MCP server and build, iterate on, and publish an app* — because the server-side tool suite already does all the work headlessly today.

## 5. The Claude Code iteration workflow (preview & feedback loop)

Two loops, depending on phase. Both hinge on closing the feedback triangle: **edit → see it render → read the errors**.

### Loop A — Phase 1, MCP only (no local checkout): "pair mode"

The developer keeps a Mako browser tab open next to the Claude Code terminal; Mako *is* the preview.

1. **Setup (once):** `claude mcp add --transport http mako <base>/api/mcp --header "Authorization: Bearer <key>"`.
2. **Create:** Claude Code calls `create_app` → gets `appId` + the preview URL (`/a/:appId`); the human opens it.
3. **Live reload is already built:** every server-side app mutation broadcasts an `app.updated` realtime event; open tabs refetch the draft and rebuild the preview iframe automatically (`app/src/store/realtimeStore.ts` `handleAppUpdated`). The MCP tools reuse the same server implementations, so external edits hot-reload the human's tab with **zero new plumbing**.
4. **Feedback back into Claude Code** — three channels:
   - **`run_binding` (exists):** validates SQL/data shape server-side before any UI work.
   - **`get_preview_errors` (new, small):** compile/runtime errors are currently collected only in the browser (`previewErrors` in `appStore`, read by the in-product `run_app` client tool). Add a report endpoint (`POST /api/workspaces/:id/apps/:appId/preview-errors`) that the open tab posts to after each rebuild, and an MCP tool that reads the latest batch. This gives headless agents the same signal the in-product agent gets from `run_app`.
   - **Screenshots (optional, for visual iteration):** an MCP tool `create_preview_token` mints a short-lived signed URL for the draft preview; Claude Code drives its own headless Chromium (Playwright) against it and screenshots. (Never put API keys in URLs — hence the ephemeral token.) Fallback: the human pastes a screenshot into the chat.
5. **Checkpoint & ship:** `app_save_version` at good states; `publish_app` when done.

### Loop B — Phase 2, repo + `mako dev`: "local mode" (the fast loop)

Everything Claude Code already does well — local files, local server, local browser — with real workspace data behind it.

1. `mako init` (or `mako pull`) → repo with `CLAUDE.md`, typed `@makoai/app-sdk`, binding files.
2. `mako dev` → local Vite server on `localhost` with HMR. The dev SDK implements `useQuery` by executing the **local** binding code through the workspace API (requires `query:execute` scope on the dev key — bindings in the repo aren't on the server yet). Published/standalone apps never do this; only dev mode runs ad-hoc binding code.
3. Claude Code edits `src/` and `bindings/` directly — errors appear in the Vite terminal output (which Claude Code reads natively), HMR refreshes instantly, and Claude Code can screenshot `localhost` with Playwright. No Mako-side round-trip per edit.
4. `mako push` → syncs to the Mako draft to verify in the real (sandboxed, esm.sh) renderer — the fidelity check, since local Vite is a simulation of the cdn runtime.
5. `mako publish` (or merge to the bound branch once WS3 lands, and CI sync does the rest).

**Rule of thumb:** Loop A needs no local setup and keeps a human visually in the loop; Loop B is the fastest agent-autonomous cycle. New plumbing needed for A is just the preview-error report endpoint + tool and the signed preview token; B needs none beyond WS2 itself.

### Full iteration autonomy without git (Phases 1–2 only)

Git (Phase 3) is a *sync* mechanism, not what powers iteration. The loop is **edit → render → read errors → checkpoint**, and each leg closes without git:

| Leg | Mechanism (no git needed) | Phase |
| --- | --- | --- |
| Edit | MCP app tools (files, deps, bindings) — full mutation surface, server-side | 1 |
| Data correctness | `run_binding`, `get_schema` — validate SQL/shape before UI work | 1 |
| Render + errors | see render ladder below | 1 / 1.5 |
| Checkpoint / rollback | `app_save_version` / `app_restore_version` + `EntityVersion` history — this *is* the "commit" substitute; origin-stamped (L19) it doubles as an audit trail | exists |

**The render ladder** — three rungs, increasing autonomy:

1. **Human tab open (pair mode):** live-reload via `app.updated` (exists) + `get_preview_errors`. Human eyes are the renderer. Zero autonomy cost, but blocked when nobody's watching.
2. **Agent-driven browser:** `create_preview_token` → Claude Code drives its own local Playwright/Chromium against the signed draft-preview URL, reads console errors directly, screenshots itself. Fully autonomous, but only for MCP clients that *have* a local browser (Claude Code yes; Claude Desktop/claude.ai no).
3. **`render_app` MCP tool (server-side headless render) — the missing piece for full autonomy.** Mako runs a pooled headless Chromium that loads the draft preview, waits for first paint / error settle, and returns `{ previewErrors[], screenshot, consoleLogs[] }` in one tool call. Works from *any* MCP client with nothing but the API key — no human tab, no local browser, no git. This makes rung 1's report endpoint mostly redundant (keep it as the cheap path when a tab happens to be open).

`render_app` costs: a Chromium pool (Playwright is already a dev dependency pattern in the stack), per-key rate limits + render timeouts (extends L8), screenshots stored as ephemeral artifacts with short TTLs, and the render context must use the same signed-token auth as rung 2 (never a raw key in the page). Recommend shipping rungs 1–2 in Phase 1 and `render_app` as **Phase 1.5** — it's the single highest-leverage addition for headless/hosted agents.

In Phase 2, `mako dev` gives the same full loop locally (terminal errors + localhost screenshots) with the repo as scratch space — still no git host involved; `mako push`/`pull` sync straight to the Mako draft, and Mako's version history remains the rollback mechanism.

## 6. Key decisions to confirm

1. **API key auth for MCP (v1) vs MCP OAuth** — propose API key first (matches the "simple API key" goal), OAuth later for marketplace-grade clients.
2. **Scope vocabulary granularity** — proposal above is coarse resource-level; fine per-connection scoping deferred.
3. **`cdn` runtime only for repo apps in v1** — no bundler/Tailwind; revisit with `webcontainer`.
4. **Git sync direction** — one-way git → Mako in v1 (dbt precedent), Mako-side editing locked for bound apps.
5. **Key prefix naming** — keep `revops_` for back-compat, introduce `mako_sk_`/`mako_pk_` aliases now or later.

## 7. Loopholes — adversarial review

Numbered so phases and reviews can reference them. **Bold** = changes the design, not just adds a control.

### Credentials & auth

- **L1 — Dev keys with `query:execute` are full database credentials.** The `mako dev` loop needs ad-hoc query execution, so a "dev key" committed to a repo (or leaked from `.mako/`, `.env`, CI logs) grants arbitrary SQL against every workspace connection — including connector-synced CRM/billing data. *Mitigations:* `query:execute` off by default and admin-grant only; short default expiry (e.g. 7 days) on keys carrying it; optional per-connection restriction; `.mako/` and `.env` in generated `.gitignore`; GitHub secret-scanning registration (Phase 0); CLI warning when a `query:execute` key is used non-interactively.
- **L2 — Stale privilege via acts-as-creator.** Keys impersonate their creator. Membership is re-checked per request, but a creator demoted from admin→viewer must not leave behind an admin-powered key, and a departing admin's keys should be revoked, not silently broken. *Mitigation:* resolve the creator's *current* role at request time (Phase 0); revoke-on-removal job; later, org-owned service principals that don't impersonate anyone.
- **L3 — Origin allowlists on publishable keys only constrain browsers.** `curl` sets any `Origin` header, so a `mako_pk_` key scraped from a bundle lets anyone script reads of everything the app displays. This is **inherent** — a standalone frontend cannot hold a secret. *Posture:* treat data behind a publishable key as public-to-the-key-holder; make that loud in docs and in the key-creation UI; rate-limit per key; keep the blast radius to published-snapshot bindings only. For genuinely private standalone apps, the answer is a customer backend exchanging a secret key for short-lived viewer tokens (post-v1).
- **L4 — Binding parameters as an injection/authorization hole.** If bindings ever accept client-supplied parameters (filters, ids), string interpolation = SQL injection, and even correct parameterization lets a caller page through rows the UI never showed. *Mitigations:* published bindings execute with **bound parameters only**, typed and declared in the binding config; no client-supplied SQL fragments ever; document that row-level authorization inside one app is the author's responsibility; audit the `{{ dbt_schema }}`-style token resolution so tokens can't be smuggled in via parameter values.
- **L5 — Draft data leaking through preview tokens.** `create_preview_token` renders *drafts* with live data; a leaked URL is a data leak. *Mitigations:* minutes-scale TTL, single app, bound to the issuing key, read-only, revoked on key revocation, never logged in full.

### MCP & agent loop

- **L6 — Prompt injection through the feedback channels.** Everything the MCP loop feeds back to Claude Code is attacker-influenceable: query results, schema/table names, README/skill text from synced repos, and especially `get_preview_errors` (app code can `throw` arbitrary strings; any workspace member can post to the error-report endpoint). A hostile string can steer an agent holding write/destructive tools. *Mitigations:* error-report endpoint requires workspace auth + is scoped per app and size-capped; MCP tool results wrap external strings in clearly-delimited data blocks; destructive tools carry MCP annotations so clients confirm; default MCP toolset is read-mostly with writes opt-in per key scope.
- **L7 — Exfiltration via tool composition.** An injected or careless agent with `query:execute` plus any write-capable tool (or web access on the client side) can move data between connections or out of the tenant. *Mitigations:* per-key connection restriction; usage log with row counts (Phase 0) feeding anomaly alerts; no cross-connection write tool in the MCP suite.
- **L8 — Resource exhaustion.** `run_query`/`run_binding` against huge tables burns the *customer's* database and Mako's memory; MCP makes it trivially scriptable. *Mitigations:* enforce server-side row caps + statement timeouts on the MCP execution path (same caps as the in-product 500k/truncation behavior), per-key concurrency limits, per-workspace quotas surfaced in usage/billing.
- **L9 — Workspace confusion / drift in auth wiring.** `mcp.routes.ts` today uses an inline workspace check instead of `requireWorkspace`; the new MCP server must not repeat that — every drift point between "key's workspace" and "requested workspace" (path param vs `x-workspace-id`) is a confused-deputy candidate. *Mitigation:* the MCP route uses the standard `unifiedAuthMiddleware + requireWorkspace + requireScope` stack; add a test that a key for workspace A calling with `x-workspace-id: B` fails.

### Supply chain (repo, npm, esm.sh)

- **L10 — Published app code can exfiltrate query results.** The sandboxed iframe still has network access (esm.sh imports require it), so any published app — whether authored by the in-product agent, a repo, or a marketplace template — can `fetch` binding results to an attacker domain. This exists **today** but repo-sync and "install from repo" widen who can author code. *Mitigations (design change):* per-app **network allowlist** enforced via iframe CSP (default: Mako API + esm.sh only; authors explicitly add external APIs, surfaced at publish/review time); publish remains a human action distinct from sync (Phase 3 keeps git → draft only).
- **L11 — npm dependency supply chain via esm.sh.** `dependencies{}` resolve at *view time*; a hijacked or typosquatted package executes in every viewer's browser with access to bound data, and a `^` range means the code you reviewed isn't the code that runs. *Mitigations:* pin exact versions into the published snapshot (lockfile semantics); diff-and-confirm dependency changes at publish; optional org-level package allowlist; medium-term, proxy/pin esm.sh (also fixes availability).
- **L12 — Repo-binding takeover.** Bindings keyed by `owner/name` can be hijacked via repo deletion/transfer + re-registration (repo resurrection), and webhook handlers without signature verification accept forged pushes. *Mitigations:* pin numeric GitHub repo id + installation id; verify webhook signatures (confirm the dbt path does; the app path must); re-verify installation access on every sync; sync halts + alert if repo identity changes.
- **L13 — Alias auto-resolution as privilege escalation.** If synced pushes can add new bindings whose aliases auto-resolve to previously-mapped connections, anyone with repo push access can point new SQL at the production warehouse silently. *Mitigation:* first use of any alias *and* any new binding on a bound app requires one-time human approval in Mako; approvals recorded on the binding.
- **L14 — Secrets baked into bundles.** `mako export` refusing `revops_` keys by prefix is necessary but insufficient — users paste secrets into app code and env files. *Mitigations:* scan exported bundles for known credential patterns (Mako prefixes + common formats); docs pattern for "bring your own backend" when an app needs a third-party secret.

### Product/process gaps (not security, still holes)

- **L15 — Concurrent-edit clobbering.** An MCP agent and a human editing the same app race; today's server tools are effectively last-write-wins on the draft. *Mitigation:* optimistic concurrency — write tools take the expected `version` and fail with a fresh snapshot on mismatch (the `app.updated` version counter already exists to build on).
- **L16 — Local dev ≠ cdn runtime.** Vite dev with node-resolved deps will happily run code the esm.sh import-map runtime rejects (or resolves differently). *Mitigation:* `mako check` validates against the real import-map resolution headlessly; `mako push` runs it automatically; treat the Mako draft preview as CI, not as the first time the real runtime sees the code.
- **L17 — SDK/docs drift.** Three copies of truth threaten to diverge: the synthetic `@makoai/app-sdk` module in `preview.ts`, the npm package, and the generated `CLAUDE.md` (distilled from `agent-skills/apps/SKILL.md`). *Mitigation:* generate the synthetic module and the npm package from one source; serve authoring guidance to external agents dynamically as an MCP resource instead of freezing it into scaffolds.
- **L18 — Metering & billing.** Key-authenticated traffic (MCP tool calls, binding executions from standalone apps) bypasses today's in-product usage accounting; a popular standalone app is unmetered load. *Mitigation:* per-key usage log (Phase 0) feeds the existing `usage`/`billing` routes; publishable-key executions counted against the owning workspace with configurable caps.
- **L19 — Version/publish semantics across three authoring paths.** In-product agent, MCP, and git sync all mutate the same draft; without a convention, `app_save_version` checkpoints and git history tell conflicting stories. *Mitigation:* record `origin` (`agent` / `mcp:<keyId>` / `git:<sha>`) on every version snapshot — cheap now, painful to retrofit.

## 8. Local-first — status and open todos (2026-08-31)

What the local-first tier (apps.md §11, §15; PR #842) delivers today, and the
items that need a human or an account we do not have from a coding session.
Keep this list current: it is the hand-off.

### Done

- Workspace repos carry a Mako-managed template: `AGENTS.md` (+ `CLAUDE.md`
  → `@AGENTS.md`), OAuth-first `.mcp.json`, `.envrc`, `.mako/workspace.json`,
  vendored `@makoai/app-sdk`. Refreshed monotonically, never touches `apps/`.
- `@makoai/app-sdk` is a real package (`packages/app-sdk`): hooks, `./vite`
  (`makoData()` — local `vite dev` gets real parquet from the API), and
  `./credentials` (`~/.mako/credentials.json`). SDK 2.2 decodes DATE →
  `YYYY-MM-DD`, TIMESTAMP → ISO, BigInt → Number.
- `@makoai/cli` (`packages/cli`): `mako login` (OAuth PKCE loopback against the
  MCP auth server), `mako dev [app]`, `whoami`, `logout`.
- Auth: OAuth tokens and `query:read` keys may call the three read-only
  binding routes besides `/api/mcp` (`auth/scoped-key-routes.ts`).
- Deploy-on-push runs as Inngest work (`apps-deploy`, bounded concurrency)
  with an hourly reconcile (`apps-deploy-reconcile`) that redeploys any
  published app whose folder changed since its `publishedSha`.
- `server.json` (`ai.mako/mako`) validates against the MCP Registry.
- Python SDK renamed `mako-ai` (module `mako_ai`) — `mako` on PyPI is the
  templating engine.
- `apps` skill: `references/charting.md` (recharts, theme tokens, states).

### Todo — needs an account, a secret, or a decision

- [x] **npm scope** — `@mako` and `@mako-ai` are squatted by inactive users;
      org **`makoai`** created 2026-08-31 (owner: spingwun). A name dispute
      for `mako`/`mako-ai` can be filed with support@npmjs.com (draft in the
      session notes); if it succeeds, republish under the new scope and keep
      `@makoai/*` as aliases.
- [x] **Published** `@makoai/app-sdk@2.2.0` and `@makoai/cli@0.1.0`
      (2026-08-31, by hand with web 2FA). Future releases: bump the version,
      push a tag `app-sdk-vX.Y.Z` / `cli-vX.Y.Z` → `.github/workflows/publish-npm.yml`
      publishes with **trusted publishing** (OIDC, provenance). Trusted-publisher
      connections are set on BOTH package pages (GitHub Actions · mako-ai/mako ·
      publish-npm.yml · npm publish) as of 2026-08-31 — releases need no
      npm token or human 2FA.
      Existing workspace apps keep importing `@mako/app-sdk` (npm links the
      vendored folder under the dependency key); new apps get `@makoai/app-sdk`.
- [x] **PyPI** — `mako-ai` 0.1.0 published 2026-08-31 from GitHub Actions
      via trusted publishing (pending publisher registered on the PyPI
      account: project mako-ai · mako-ai/mako · publish-pypi.yml). Release =
      bump `version` in `packages/mako-sdk-py/pyproject.toml`, merge, then
      `git tag py-vX.Y.Z && git push origin py-vX.Y.Z`. The suite's four
      failures were the fake transport still answering `/databases`; fixed.
- [x] **MCP Registry**: published as `io.github.mako-ai/mako` v1.0.0
      (2026-08-31). Mechanics worth remembering: the registry grants an org
      namespace only to org **Owners**, read via `GET /user/memberships/orgs`;
      mako-ai restricts third-party apps and the registry's GitHub App is
      private (cannot be installed), so the interactive device login only
      sees the personal namespace. Use a token that can read the org role:
      `mcp-publisher login github -token "$(gh auth token)"` (gh's token has
      `admin:org`), then `mcp-publisher publish` from the repo root. New
      versions: bump `version` in `server.json`, same two commands.
- [ ] **Directories**: submit the hosted URL to Anthropic's connector
      directory and Cursor's MCP directory (both are forms/PRs, not code).
- [x] **Merge PR #842** — merged 2026-08-31 11:50Z (`26f481f2`); the
      12:17Z reconcile run republished the stale RealAdvisor apps as designed.
- [ ] **Migrated apps and dates**: SDK 2.2 sends DATE/TIMESTAMP as strings.
      Grep the 58 migrated apps for `formatDate`/`new Date(` on binding
      fields and fix any that assumed numbers (they were broken before too).
- [x] **LICENSE** — MIT (PR #867; mako.ai's footer had promised MIT). Also
      SECURITY.md, CONTRIBUTING.md; every package `license` field agrees.
      Published packages show it from their next release.
- [ ] **Directory listings — what is still missing** (Anthropic Software
      Directory policy, also useful for Cursor/OpenAI):
      - [ ] Website legal pages: mako-marketing PR #47 adds /privacy, /terms,
            /about, /security, /support, /.well-known/security.txt. Fill
            `website/lib/company.ts` (registered entity, address, venue),
            have counsel read Terms, merge.
      - [ ] Mailboxes `support@`, `privacy@`, `security@`, `legal@mako.ai`
            (Google Workspace aliases) — "verified contact information".
      - [ ] A **test account with sample data** for reviewers: a demo
            workspace (DEMO_DATABASE_URL exists) with a read-only API key
            or a reviewer login.
      - [ ] Three working examples — the MCP docs page has them; link them
            in the submission.
      - [x] Tool annotations: `title` added next to readOnlyHint /
            destructiveHint (PR #868); names ≤ 26 chars.
      - [ ] Submit: Anthropic (partner form via the Software Directory
            policy page), Cursor directory PR, OpenAI connector review.
- [ ] **Decide**: hide/rename the sandbox-shaped `app_*` file tools for MCP
      clients that identify as a local checkout; `skills/<name>/SKILL.md`
      in workspace repos (§10 Block D1); fetch-before-write for every
      Mako-authored commit on shared connected repos (apps.md §15.3).
