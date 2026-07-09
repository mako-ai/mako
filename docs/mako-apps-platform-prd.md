# Mako Apps Platform — Build Mako-Compatible Apps via MCP, Claude Code, and GitHub

**Status:** Proposal / plan
**Goal:** Let anyone build Mako apps from *outside* the Mako UI — with an MCP client (Claude Desktop, Claude Code, any agent), or directly in a GitHub repo with Claude Code — and let published apps run **standalone**, needing only a simple API key that grants access to their data resources.

---

## 1. Where we already are

Almost everything needed already exists inside the product; what's missing is the outward-facing surface. Inventory of reusable building blocks:

| Building block | Where | State |
| --- | --- | --- |
| **App definition contract** | `packages/schemas/src/app.schema.ts` (`AppDefinitionSchema`: `title`, `template`, `runtime`, `entrypoint`, `files[]`, `dependencies{}`, `dataBindings[]`) | ✅ Canonical, shared API↔frontend |
| **Headless app authoring tools** | `api/src/agent-lib/tools/server-app-tools.ts` (`create_app`, `app_write_file`, `app_edit_file`, `app_add_dependency`, `app_create_data_binding`, `app_save_version`, …) | ✅ All server-side, work without a browser |
| **Draft → publish snapshots + version history** | `api/src/services/app-version.service.ts`, `EntityVersion` | ✅ |
| **Workspace API keys** | `IWorkspaceApiKey` on `Workspace`, `revops_` Bearer tokens, SHA-256 hashed, `unifiedAuthMiddleware` | ✅ Exists — but **no scopes, no expiry**, all-or-nothing |
| **Git → Mako sync precedent** | dbt: `IDbtRepoBinding` + GitHub App webhooks (`api/src/routes/github.routes.ts` → `dbt-ci.service.ts`) | ✅ Proven pattern, dbt-only |
| **Public data serving for published apps** | `api/src/services/public-live-query.service.ts` (serves `app.published` snapshot bindings via share token) | ✅ Token-gated, read-only |
| **MCP infrastructure** | `api/src/services/mcp-client.service.ts`, risk tiers (`read`/`write_safe`/`write_destructive`), tool restriction model | ✅ **Client only** — Mako does not expose an MCP *server* |
| **App runtime** | `app/src/app-runtime/preview.ts` (esm.sh import map, sandboxed iframe, injected `@mako/app-sdk`: `useQuery`, `useDuckDB`, `useTheme`, `useLocation`, `navigate`) | ✅ But embedded in the frontend; `@mako/app-sdk` is a synthetic module, **not a real npm package** |
| **Machine-readable API** | `GET /api/openapi.json`, Consoles API, `/api/workspaces/:id/execute` | ✅ |

**Gaps** (the actual work): Mako-as-MCP-server, an on-disk repo format + CLI, a published `@mako/app-sdk` package, GitHub repo binding for apps, API-key scopes, and a standalone runtime + app-scoped data endpoint.

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
- **Publish `@mako/app-sdk` as a real npm package:** types + a dev implementation of `useQuery`/`useDuckDB`/`useTheme`/`useLocation` that calls the Mako API with an API key. In-product, the injected synthetic module keeps winning (import-map override), so runtime behavior is unchanged; the package exists so repos type-check and run locally.
- **`mako` CLI** (`packages/cli`, `npx @mako/cli`), auth via `MAKO_API_KEY` env or `mako login`:
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

## 4. Phasing & rough sizing

| Phase | Scope | Ships | Est. |
| --- | --- | --- | --- |
| **1** | WS0 + WS1 | Scoped API keys; Mako MCP server with app/query/schema tools; docs ("build a Mako app from Claude Code in 5 minutes") | ~2–3 wks |
| **2** | WS2 | Repo format, published `@mako/app-sdk`, `mako` CLI (init/pull/push/dev/publish), generated CLAUDE.md | ~3–4 wks |
| **3** | WS3 | GitHub App binding for apps, push-to-sync, sync status UI | ~2 wks |
| **4** | WS4 | Publishable app keys, binding-execute endpoint, `@mako/app-runtime`, `mako export` + embed | ~3–4 wks |

Phase 1 alone delivers the headline: *anyone with a workspace API key can point Claude Code/Desktop at Mako's MCP server and build, iterate on, and publish an app* — because the server-side tool suite already does all the work headlessly today.

## 5. Key decisions to confirm

1. **API key auth for MCP (v1) vs MCP OAuth** — propose API key first (matches the "simple API key" goal), OAuth later for marketplace-grade clients.
2. **Scope vocabulary granularity** — proposal above is coarse resource-level; fine per-connection scoping deferred.
3. **`cdn` runtime only for repo apps in v1** — no bundler/Tailwind; revisit with `webcontainer`.
4. **Git sync direction** — one-way git → Mako in v1 (dbt precedent), Mako-side editing locked for bound apps.
5. **Key prefix naming** — keep `revops_` for back-compat, introduce `mako_sk_`/`mako_pk_` aliases now or later.

## 6. Risks / open questions

- **Arbitrary query execution via keys** (`query:execute`) is the sharpest tool — default off, admin-only grant, and audit-log key usage per request (extend `lastUsedAt` into a proper usage log).
- **No global rate limiting exists today** — must land with WS0 before any public/standalone traffic.
- **esm.sh dependency** for the standalone runtime is an external availability/supply-chain exposure; consider a proxy/pin strategy when apps go standalone.
- **SDK drift:** once `@mako/app-sdk` is public, its surface (`useQuery`, `useDuckDB`, `useTheme`, `useLocation`, `useSearchParams`, `navigate`) becomes a semver contract — establish versioning policy before Phase 2.
- **Acts-as-creator semantics:** API keys currently impersonate their creator; fine for v1, but revisit for org-owned "service" keys that survive member removal.
