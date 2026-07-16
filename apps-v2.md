# Apps v2 — RFC / PRD

> Git-backed filesystem, real shell, real builds, and open editing for Mako apps.

- **Status:** Merged proposal (synthesis of this RFC and the parallel draft on `cursor/apps-v2-rfc-9359`); foundation under implementation as a parallel v2 module
- **Scope:** Apps module rework (storage, agent runtime, hosting, external editing). Touches: git infrastructure, sandbox execution, agent tools, app runtime/hosting, auth, desktop/local agent, MCP. **Apps v1 is not modified; v2 runs in parallel.**

## 0. Decision log (merged from both drafts)

Two RFCs were written independently against the same brief and then merged. Where they agreed (git as truth, Mako-hosted remote, microVM sandbox behind a provider abstraction, durable server-side WIP state, explorer reads git never the sandbox, Vite + pnpm + lockfile, immutable static deploys, bindings as files, MCP server, CLI, per-app reversible migration), that shared backbone stands. Where they differed:

| Decision | Adopted position | Origin |
|---|---|---|
| Repo topology | **One repo per app** under a workspace namespace (app-level ACLs make a workspace mega-repo unauthorizable); the *session* rematerializes all apps the actor can access into one workspace-shaped directory to preserve agent context | Other draft (topology) + this draft (context recovery) |
| Uncommitted-work durability | **Private WIP refs** (`refs/mako/worktrees/<id>`), hidden from clone/fetch, advanced only by compare-and-swap with a fenced lease epoch; per-actor worktrees, not a shared mutable draft | Other draft; full index/conflict-stage serialization deferred |
| Git credentials in sandboxes | **Never.** A trusted broker materializes the repo into the sandbox and accepts snapshots back; only the broker touches refs | Other draft |
| Hosting domain | **Separate registrable, PSL-registered domain** for deployed apps and previews — never a `mako.ai` subdomain; runtime data access via short-lived capability tokens as the end state | Other draft |
| Sandbox egress | Deny-by-default with a registry allowlist during install as the target posture; pilot may run relaxed with scoped short-TTL tokens bounding blast radius | Other draft (posture) + this draft (pilot pragmatism) |
| Auth for CLI/MCP/local | Staged: workspace API keys (`revops_*`) for the internal pilot → **OAuth 2.1 authorization server ADR before GA** of CLI/MCP (PKCE, device flow, scoped rotating tokens) | Both |
| Terminal + local substrate | **`mako agent`** terminal harness and the **local machine as a first-class executor** (desktop local-first sessions) are kept; local WIP mirroring to Mako is **explicit opt-in** (`--sync`), never silent | This draft (surfaces) + other draft (explicit-sync contract) |
| Scheduled jobs | Kept (Phase 5), same sandbox primitive as builds/materialization | This draft |
| Delivery strategy | **Parallel v2 module** (`api/src/apps-v2/`, new collections, new routes, new tools); v1 code paths untouched until migration | New (this merge) |
| **Durable store (corrected)** | **The customer's linked GitHub repo is the only durable store** (option B). No Mongo mirror, no GCS, no Mako-hosted bare repo — the earlier "Mako-hosted git on a volume/GCS" idea is dropped. The E2B sandbox disk is the sole working copy; **each conversation branches off the default branch, each agent turn is a commit+push, publish is a merge back to the default branch.** Reuses the existing dbt GitHub App integration verbatim (`resolveRepoToken` → short-lived installation token, never persisted; `api/src/integrations/github/github-api.ts` Git Data API). This mirrors how dbt binds to a customer repo, minus dbt's Mongo file mirror. A workspace must link a GitHub repo before using cloud Apps v2. | Corrected by the user (2026-07-12) |
| Feature flag | **Removed.** Apps v2 is always available (no `APPS_V2_ENABLED`); the two app systems coexist and tool-family isolation picks v1 vs v2 per turn. | User |
| Where git runs | **Both the API host and the sandbox have git.** The API keeps a **local clone of the linked GitHub repo as an ephemeral read cache** to render the file explorer before/without a sandbox (re-clonable on cache miss; `git` is now in the production `Dockerfile` — its absence in `node:20-slim` caused `spawn git ENOENT`). The **sandbox** does the agent's git and **pushes to GitHub**. GitHub is the only durable store. | User |
| Explorer freshness during a turn | While the agent works in the sandbox, the API's cache clone is stale. It reconciles at the **end of each conversation turn**: the turn's commit is pushed to GitHub, then the API `git fetch`es its cache to catch up — so the explorer reflects committed state per turn (the commit-per-turn cadence makes this natural; live-during-turn streaming is a later enhancement). | User |
| Adopted post-hoc from the parallel implementation branch | Custom E2B template builder (pnpm pinned, scaffold deps cache-warmed — dead-sandbox `npm install` ≈ 2s); v1/v2 **app tool-family isolation** in `prepareStep` (tab/explorer context prunes the wrong suite); `apps-v2` system skill + app-mode prompt split; explicit **index migrations**; tenant-archive hardening (symlink stripping on sandbox sync-out); `.env.example` + OpenAPI-coverage tests | Other branch (implementation commits) |
| Realtime invalidation | `app-v2.updated` pokes on flush/commit/merge/discard/lifecycle; open windows refetch from git (poke-then-pull, matching v1's pattern) | Both (their event-visibility idea, this branch's implementation) |
| API keys on apps-v2 routes | **Allowed** (external harnesses authenticate with them — R7); the other branch's cookie-only stance was rejected as it contradicts the CLI/MCP path | This branch |
| GitHub App for apps-v2 repo linking | **Not yet built.** Apps-v2 currently reuses dbt's GitHub App verbatim (`mako-transforms` prod / `mako-transforms-dev` dev), which only has `contents`/`pull_requests`/`actions`/`statuses` write — no `administration` permission, so it cannot create repos. The link dialog (`AppsV2LinkRepoDialog.tsx`) only supports linking an **existing** repo (`getRepoInfo` validates it exists; no create-repo call anywhere in `api/src/integrations/github`). Planned direction: a **separate, dedicated GitHub App** (name TBD, not dbt-branded — working name "Mako") with `administration` added, so the link flow can offer **create a new repo** (becomes fully Mako-owned) as well as **link an existing repo** (Mako's content goes under a `mako/` subfolder at the repo root by default — renamed from today's `apps/` default — with the existing "Apps folder" text field as the escape hatch to override it). Requires: registering the new GitHub App in GitHub's UI (App creation isn't API-automatable), a new create-repo backend endpoint, and a create-vs-link toggle in the dialog. Not started as of 2026-07-13. | User (2026-07-13), during local verification of this PR |
| **End-state platform: Postgres + GitHub, no Mongo** | The long-term control plane is **Postgres** (workspaces, members, app pointers, chat records — Mongo retired except perhaps webhook payloads) and the data plane is **GitHub** (all file storage: user-pays, version control, access management, Actions for CI later — explicitly not yet). Repo = tenant = the only isolation unit; **subfolders are organization, never authorization** (git can't scope fetch access by path — when two things must not see each other they go in different repos). Mako's API stays the access-control plane regardless (workspace members ≠ GitHub identities; password-signup users have none). Verified platform limits: 100k repos/org hard cap (shard orgs above it), unlimited private repos at $0 (seat pricing only, end users consume no seats), installation REST limit scales 5k→12.5k req/hr with repo count, git-protocol ops don't consume REST quota, repo creation throttled ~500/hr (secondary limit) → create lazily, pace backfills. Self-hosting git remains an escape hatch, not a plan: `git push --mirror` makes the store portable. | User (2026-07-15) |
| **Workspace repos (supersedes per-app topology + apps-v2-scoped binding)** | Repos are a WORKSPACE-level concept, not an apps-v2 one: `workspaceRepos[]` on the Workspace doc (apps-v2 will be promoted to "apps"; consoles and dbt projects will mount into the same repos later). Layout inside a repo: `<makoRoot>/apps/<app>` for workspace content and `<makoRoot>/users/<userId>/apps/<app>` for personal content (`users/<id>/apps` chosen over `apps/users/<id>` so `users/<id>/consoles` etc. compose later). Model allows N repos per workspace; the product default is exactly one. **This reverses the earlier repo-topology decision** ("one repo per app; app-level ACLs make a workspace mega-repo unauthorizable"): folder-level privacy is organization, enforced by Mako's API as the ACL plane — in a BYO repo, anyone with direct GitHub access sees all folders including personal ones (documented semantics; cloud-tier users have no direct repo access, so Mako's ACL is airtight there). Consequence for the cloud tier: per-app cloud repos become ONE `<prefix>-<workspaceId>` repo per workspace — a git-substrate change (repository/worktree services currently assume repo-per-project) scheduled as its own block. UX (Cursor-cloud style): "Add GitHub repository" is the single entry point (the sync/authorize hop runs invisibly inside it — no standalone Sync button); installations are plumbing shown only as manage/forget actions; the Settings page lists Connected repositories, not installations-then-one-binding-form. Chat/branch model unchanged and already aligned: conversation on main auto-branches, explicit dev branch honored (roadmap), turn = commit, merge to main = publish. | User (2026-07-15) |
| **End-state substrate: GitHub API reads + sandbox writes, NO API-host git (decided)** | The API host keeps **no git state at all** — it is stateless and serverless-correct (the local bare repos were exposed as a data-loss bug on Cloud Run: tmpfs, min-instances=0, no cross-instance sharing). Read path: explorer tree + file contents from **GitHub's Trees/Contents API with ETag caching** (304s are rate-limit-free). Write paths: (1) the agent works in the **sandbox, which is a real `git clone`**; every turn ends commit + `push --force-with-lease` — **GitHub is the ref authority**, which solves multi-instance coherence structurally; (2) sandbox-less edits (Monaco saves, scaffold) commit via the **Git Data API** (dbt's existing pattern — no git binary on the API). Merge-to-main/publish via the GitHub Merges API. `app2_grep/glob` run in the warm sandbox, or read the GitHub tree when cold. **WIP refs and the fenced-CAS machinery die as a concept**: the turn-end push is the durability watermark; crash window = at most the in-flight turn (accepted trade, matches commit-per-turn cadence). This also UNIFIES cloud and BYO tiers — the cloud repo is just another GitHub remote. Rollout: Phase A (bridge, built first): local repos demoted to a **rebuildable cache** — clone-on-miss from the cloud mirror + creation fails unless the initial durable push succeeds; Phase B (pivot): GitHub API becomes the primary read path, sandbox-clone lifecycle, delete the local substrate + WIP machinery. | User (2026-07-15): "use GitHub's API to render files in the tree and the sandbox's filesystem for the agent" |
| **Data bindings v2 (bindings-as-files) — Phase 1 BUILT** | A v2 binding is repo content: `mako.json` declares `bindings: [{name, connectionId}]`, the SQL lives in `bindings/<name>.sql` — authored with the ordinary file tools, versioned/branchable with the app, no bespoke CRUD. Materialization reuses v1's read-only-enforced parquet pipeline (`buildQueryParquetFile` + artifact store), artifacts keyed `apps-v2/<projectId>/<name>.parquet`, via `POST /{id}/bindings/{name}/materialize`. The preview runtime serves `__data/<name>.parquet` app-relative (resolves under the token prefix in both static and dev previews), so app code fetches a relative URL and reads it with DuckDB-WASM — v1's useRows pattern ports with a URL change. Next: `app2_materialize` agent tool (+ bridge-policy entry), scheduled refresh, dbt-schema templating (`{{ dbt_schema }}`), live (non-parquet) bindings. | User (2026-07-15), unblocking the v1→v2 Engagement Score port |
| **Mako Cloud storage (instant start) — BUILT** | Org **`mako-ai-cloud`** (github.com/mako-ai-cloud; "mako-cloud" was squatted) + private GitHub App **"Mako Cloud Storage"** (id 4300530, slug `mako-cloud-storage`, `administration:write` + `contents:write` + `metadata:read`), installed once org-wide (all current+future repos). **No per-user install flow exists on this path at all** — the entire setup-callback/stale-installation/wrong-slug bug class only applies to BYO repos. One org + one app serves every environment; repo names are namespaced per backing DB: `<prefix>-<workspaceId>-<projectId>` with prefix `ws` (prod) / `staging` (all PR previews) / `dev` (local). **One repo per app project** — mirrors the local one-bare-repo-per-project layout 1:1, so durability is a literal `git push --mirror` (auth via installation token in an HTTP header, never in the URL). Implemented: `cloud-app-auth.ts` (JWT + runtime-resolved installation id — private app ⇒ only possible install is the owner org), `cloud-repo.service.ts` (idempotent ensure-repo on app creation, delete-on-app-delete, per-project serialized+coalesced mirror pushes after commit/turn-commit/merge — not per WIP flush, too chatty), `canCreate` probe field (creation allowed = BYO binding ∨ cloud configured; the 409 link-first gate is gone). WIP refs may be pushed to cloud repos (we own the remote — the never-push-WIP-to-customer-remotes rule is BYO-only). E2E-verified 2026-07-15: create-app with no binding → private repo + scaffold on GitHub; commit → mirror lands the exact commit; delete app → repo deleted. | User's plan (2026-07-15), implemented same day |
| **Workspace monorepo (radical simplification)** | ONE repo per workspace (the N-repo model + org/repo explorer tree dies); `dbt/`, `apps/`, `consoles/`, `skills/` are folders at the repo root and leave Mongo; branch state is **per-user-session** (not per-workspace — preserves branch-per-conversation), and switching it re-checkouts everything the session sees: explorer, open tabs, sandbox. Manual saves auto-commit (agent turns already do) — the Commit button and change-count badge die. Folder privacy remains organization-not-authorization (Mako's API is the ACL plane). Plan: §10. | User (2026-07-16) |

---

## 1. Problem statement

Mako apps today are MongoDB documents (`MakoApp` in `api/src/database/workspace-schema.ts`) with an embedded `files[]` array as a virtual filesystem. The agent edits them through ~20 bespoke tools (`app_read_file`, `app_write_file`, `app_edit_file`, `app_add_dependency`, ... in `api/src/agent-lib/tools/server-app-tools.ts`), and the app is rendered in a sandboxed iframe by transpiling files with Babel-standalone and resolving npm dependencies from esm.sh (`app/src/app-runtime/preview.ts`).

This architecture was right for v1 (zero infra, instant preview, no build step) but it now caps what apps can become:

1. **The agent is handicapped.** It cannot `grep`, `ls`, `sed`, run a typechecker, run tests, or execute any program. Every capability must be hand-built as a bespoke tool. The single biggest lesson from Claude Code / Codex / Cursor is that a real filesystem plus a real shell makes the same model dramatically more effective: it composes unix tools instead of waiting for us to ship them.
2. **No real packages, no scripts.** `dependencies` is a JSON map resolved by a CDN at render time. There is no `package.json`, no lockfile, no `npm install`, no postinstall, no build step, no `npm run <script>`. Anything that needs bundling (Tailwind, CSS modules, workers, wasm, server code) is impossible. The `webcontainer` runtime enum exists in the schema but was never enabled.
3. **Mongo is a poor VCS.** We reinvented versioning twice (`MakoApp.version` draft counter + `entity_versions` checkpoints) and still have no diffs, no branches, no merge, no blame, and no way to check the app out locally. Meanwhile the dbt module already proved the git model works for us.
4. **Closed editing surface.** Apps can only be edited through Mako chat at API token prices. Users increasingly have Claude Code / Codex subscriptions with large included quotas; they want to point their own harness at their app. Today that is impossible because the app has no existence outside our database.
5. **Untapped adjacency.** An agent with a shell, database connections, and a package manager can also write ad-hoc data manipulation scripts (geocoding, deduplication, backfills). Out of scope for v2 delivery, but the architecture must not preclude it.

### What we must not lose (our USP vs. "just use Claude Code locally")

1. **Data source access with smart schema tools.** Apps have first-class, credential-free access to every workspace connection, with the schema discovery tools (`sql_list_tables`, `sql_inspect_table`, ...) that make the agent good at data work. Credentials never leave our backend.
2. **Instant deploy and hosting.** An app is live and shareable seconds after the agent writes it. No Vercel account, no CI setup, no DNS.

Both properties must survive — and both must extend to users editing from outside Mako.

---

## 2. Requirements

### Functional

- **R1** — Each app is a directory in a git repository with a real `package.json`, lockfile, and scripts.
- **R2** — The agent operates on a real filesystem through a real shell (`bash`), plus fast-path read/write/edit tools. It can install packages, run builds, typecheckers, tests, and arbitrary scripts.
- **R3** — Git is the durable source of truth. Versioning, history, diff, branches, restore, and conflict resolution come from git, not `entity_versions`.
- **R4** — The Mako file explorer and preview always reflect the latest state — committed *and* uncommitted — even when no sandbox is running, and survive sandbox death with at most seconds of loss.
- **R5** — Apps build with a real toolchain (Vite) and are hosted by Mako: dev preview with HMR while editing, and a published static deployment on a stable URL.
- **R6** — Runtime data access (`useQuery` bindings, parquet materialization, DuckDB) keeps working, and the sharing model (private / workspace / public link, `allowLiveQueries`) is preserved.
- **R7** — Users can edit apps with external harnesses:
  - via a **Mako MCP server** (Claude Desktop, Claude Code, Codex, Cursor get schema + query + app tools),
  - via a **local clone** (`git clone` + Claude Code in the repo, with data access through an authenticated CLI/SDK),
  - via the **`mako` CLI's own terminal agent** (`mako agent` — the Mako agent driving the local checkout, Claude Code-style),
  - via a **desktop extension slot** that hosts a coding agent (third-party or `mako agent`) in the right panel in lieu of Mako chat.
- **R8** — Existing v1 apps migrate without data loss; the v1 CDN renderer remains available until migration completes.

### Non-functional

- **N1 — Security:** user code never executes in the API process. Sandboxes and browsers only. Database credentials never enter a sandbox, a local machine, or an iframe.
- **N2 — Cost:** compute is billed only while a user/agent is actively working (idle sandboxes pause to $0). Hosting published apps is static-asset cheap.
- **N3 — Latency:** warm sandbox attach < 1s; cold start (clone + install from cache) < 15s; explorer file reads < 200ms regardless of sandbox state.
- **N4 — Tenancy:** everything scoped by workspace, consistent with `unifiedAuthMiddleware` + workspace membership patterns.
- **N5 — No new self-managed stateful infra where avoidable.** We deploy a single Node container to Cloud Run; the design must not require us to operate Kubernetes or a fleet of VMs.

---

## 3. Current-state summary (what we build on)

| Subsystem | Today | Reusable for v2? |
|---|---|---|
| App storage | `MakoApp` doc, embedded `files[]`, `dependencies` map | Migration source only |
| App versioning | `version` counter + `entity_versions` snapshots | Replaced by git; keep publish pointer concept |
| Agent tools | ~20 bespoke server tools + 3 client tools | Replaced by shell/file tools; binding tools evolve |
| Rendering | Babel + esm.sh import-map iframe, `@mako/app-sdk` injected via postMessage bridge | Bridge + SDK concepts survive; transpile pipeline retired |
| Data bindings | `dataBindings[]` on the doc; live via `POST /workspaces/:id/execute`; parquet via Inngest + DuckDB-WASM | Execution + materialization services reused as-is; binding *definitions* move into files |
| Sharing | `published` snapshot + `/api/share/:token` routes | Reused; "published" becomes a git ref + built artifact |
| Git integration | dbt module: GitHub App, Git Data API, Mongo mirror + per-user drafts (`api/src/dbt/dbt-github-*.service.ts`) | GitHub App auth + webhook plumbing reused; the Mongo-mirror pattern is *not* carried into apps v2 |
| Programmatic auth | Workspace API keys `revops_*` (`api/src/auth/api-key.middleware.ts`) | Reused for CLI/MCP; PATs added later |
| Sandboxing | None (dbt subprocess is the only server-side execution; E2B only mentioned in `docs/connector-builder-prd.md`) | Net-new |
| Local agent | `packages/local-agent` — loopback Hono server, DB drivers, no shell/files | Extended for desktop extension slot |
| Deploy | Cloud Run single container + Cloudflare Workers as edge routers | Workers/KV pattern extended for app hosting |

---

## 4. Recommended architecture

### 4.1 Overview

```
                                   ┌────────────────────────────────────┐
                                   │            Mako API                │
   Mako web app ───────────────────│  Files API (reads git)            │
   (explorer, preview iframe)      │  Session API (sandbox lifecycle)  │
                                   │  Execute API (queries, unchanged) │
   Claude Code / Codex ── MCP ─────│  MCP server (/api/mcp)            │
                                   │  Git smart-HTTP (/git/*)          │
   Local clone ── git+CLI ─────────│  Deploy API (publish)             │
                                   └───────┬──────────────┬────────────┘
                                           │              │
                              ┌────────────▼───┐   ┌──────▼───────────┐
                              │  Workspace git │   │  E2B sandbox     │
                              │  repo (bare,   │◄──│  per session:    │
                              │  Mako-hosted,  │   │  clone, shell,   │
                              │  GCS-backed)   │   │  vite dev, jobs  │
                              │  + optional    │   └──────┬───────────┘
                              │  GitHub mirror │          │ flush (git push
                              └────────┬───────┘          │  draft refs)
                                       │ publish = build + upload
                              ┌────────▼───────────────────────────────┐
                              │  Static hosting: GCS/R2 bucket +       │
                              │  Cloudflare Worker (apps router)       │
                              └────────────────────────────────────────┘
```

Three layers, with strict roles:

1. **Git (durable truth).** One Mako-hosted bare repo per app, namespaced by workspace. Every byte that matters ends up here — including uncommitted work, as *private WIP refs* (see 4.4).
2. **Sandbox (ephemeral working copy + compute).** An E2B microVM per editing session. It holds a clone, a shell, node/npm, and the Vite dev server. It is disposable by design: anything not yet flushed to git is at most seconds of work.
3. **Read model (API).** The explorer, preview, and external clients never talk to the sandbox for file state; they read git through the Files API. This is the invariant that makes sandbox death a non-event.

### 4.2 Repository topology: one repo per app, one workspace-shaped session

**Decision: one Mako-managed repo per app**, namespaced by workspace (`<workspace-slug>/<app-slug>.git`).

The original draft of this RFC proposed one repo per workspace for agent context. The merge reverses that on an authorization argument that has no good counter: apps carry **per-app ACLs today** (`access: private | workspace`, `sharedWith` collaborators), and a git repo is the authorization boundary — anyone who can clone a repo can read all of its objects. A workspace mega-repo would silently flatten private apps into workspace-readable ones. Per-app repos also give deployment, rollback, transfer, deletion, and audit a natural unit, keep clones and lockfiles independent, and bound blast radius.

**The context loss is recovered at the session layer, not the storage layer.** An editing session materializes *all apps the actor is allowed to access* into one workspace-shaped directory:

```
/workspace/                # sandbox or local checkout root
  apps/
    revenue-dashboard/     # clone of acme/revenue-dashboard.git
      package.json
      mako.json            # app manifest: entry, bindings, jobs, publish config
      src/App.tsx
      bindings/mrr.sql
    churn-explorer/        # clone of acme/churn-explorer.git
  scripts/                 # future: ad-hoc data manipulation scripts
```

The agent sees and greps across everything it may see; git boundaries stay per-app underneath (a cross-app change becomes N commits, which the commit tool handles). Cross-resource context beyond apps (schema, consoles, dbt) comes from the existing discovery tools and MCP, not from co-locating source.

Two nuances:

- **dbt stays where it is.** dbt projects typically bind to a *pre-existing customer repo* (`IDbtRepoBinding`) — untouched by this RFC.
- **BYO repo / external monorepos (later, separate RFC).** A subdirectory of a customer repo is not an authorization boundary, and WIP refs must never be written to a customer remote; users can export/subtree explicitly until that design exists. Async GitHub mirroring via the existing GitHub App remains the likely shape.

**Concurrency model:** per-actor worktrees (see 4.4), not a shared mutable draft. Committing to `main` checks the expected branch SHA; divergence requires merge/rebase with normal git semantics — a strict improvement over Mongo last-write-wins.

### 4.3 Git hosting: Mako-hosted bare repos (not GitHub-first)

**Decision: Mako hosts the git repos itself**, exposed over smart HTTP at `https://api.mako.ai/git/<workspace-slug>/<app-slug>.git`, authenticated with workspace API keys / PATs (git basic auth: `x-token:<revops_...>`), with per-app ACL enforcement at the route and WIP refs hidden from advertisement.

Why not GitHub-first (the dbt pattern)?

- dbt's model requires a GitHub App installation before anything works. For apps, that would put a GitHub signup + org-admin approval in front of "create your first app" — unacceptable for the instant-start UX. Hosting ourselves keeps app creation at one click.
- dbt's Mongo-mirror + Git-Data-API design exists because the server never has a real working tree. In v2 the sandbox *is* a real working tree with a real `git` binary, so we want a real remote it can push to at wire speed, not REST-API blob writes.

Implementation sketch (small, well-trodden):

- Bare repos on a GCS-backed persistent volume (Cloud Run volume mount or a small GCE disk served by the API container), served by `git http-backend` (or `isomorphic-git`'s server, but the C git backend is simpler and battle-tested) behind a Hono route that enforces auth + workspace scoping.
- Nightly bundle backups to GCS; repos are also implicitly replicated in every sandbox clone and local clone.
- If we outgrow this: swap in Gitea or managed git without changing any client, because the interface is plain git.

This is the one genuinely new piece of stateful infra. It is justified: it removes a hard external dependency (GitHub) from the core product loop, and "serve bare git repos over HTTP" is decades-old, low-operational-risk technology. (Weighed against N5 and accepted.)

### 4.4 Durability of uncommitted work: private WIP refs with fenced compare-and-swap

The answer to *"how does the app reflect the latest files, committed or uncommitted, and what happens if the sandbox dies?"*:

- Each active editor/agent gets an **`AppWorktree`** record: app, actor, branch, base commit SHA, a private WIP ref, a monotonic revision, and a **lease epoch**. WIP state lives at `refs/mako/worktrees/<worktreeId>` — a shadow commit of the full working tree (tracked + untracked, minus ignored caches like `node_modules`/`dist`).
- **WIP refs are private.** They are hidden from clone/fetch (`hideRefs` / not advertised over smart HTTP) and never mirrored externally; only the worktree service reads or advances them. This matters because a fetchable draft ref would leak in-progress work to every repo collaborator.
- **Compare-and-swap is the commit point.** Every flush carries `(worktreeId, leaseEpoch, expectedWipOid)`; the ref advances only if it still points at the expected OID (`git update-ref <ref> <new> <old>`). A stale sandbox — one whose lease was reassigned — is rejected and its snapshot preserved on a conflict ref instead of overwriting newer state. Mongo revision fields and realtime events are repairable projections, not the authority.
- **Flush cadence:** end of every agent tool batch (the natural "turn" boundary); a debounce (target ≤ 2–10s watermark) while shell commands or dev servers mutate files; and a forced flush on session pause/close/commit/publish. The UI shows the durability watermark rather than implying synchronous durability.
- **The Files API reads git, never the sandbox.** Tree/file reads resolve to the actor's WIP ref if a worktree exists, else the branch head. The explorer renders identically whether the sandbox is running, paused, or dead.
- **Sandbox death loses at most one flush interval.** Recovery = new sandbox, materialize base commit, apply WIP state, reinstall from cache, continue. No source correctness depends on the old sandbox resuming.
- "Commit" in the product UI = squash the WIP state onto the branch with a message (AI-suggested, like dbt's `commit-message` endpoint), advance the branch ref with CAS, reset the worktree base. This replaces `app_save_version`; publish (4.7) is a separate act.

Deferred from the stricter draft (explicitly, not silently): serializing the git *index* including merge-conflict stages 1/2/3 and sandbox-local refs into the WIP object. v2 foundation snapshots the working tree only; a sandbox-local `git commit` or unresolved merge should be committed or resolved before flush, and the tooling steers the agent that way. Revisit when shared/branchy workflows demand it.

**On mounting a stable filesystem into the sandbox instead:** considered (gcsfuse / juicefs) and rejected as the durability mechanism: network-FS latency ruins `npm install` and Vite; failure modes are worse (hung mounts vs. clean flush retries); FUSE/object mounts don't provide git-grade atomicity; and it would bypass git as the single source of truth. Provider volumes and pause/resume snapshots are *warm caches* — `node_modules`, pnpm store — never the system of record.

**Trusted git broker (no credentials in sandboxes).** The sandbox never receives a git password, token, SSH key, or credential helper. The broker (a trusted control-plane component) materializes the authorized repo content into the sandbox, receives snapshots back over the session channel, validates them (path canonicalization, no `.git`/symlink smuggling, size limits), and is the only principal that touches refs. Local clones on a user's machine are different: there the *user* is the principal, with their own short-lived git credential from `mako login`.

### 4.5 Sandbox layer: E2B

**Decision: E2B** for session sandboxes and job execution.

- Firecracker microVM isolation — appropriate for "agent runs arbitrary shell commands" (N1).
- Pause/resume persistence: auto-pause on idle timeout preserves filesystem + memory; paused sandboxes cost $0 and resume in ~100s of ms. This gives us warm `node_modules` and running dev servers across a coffee break without paying for idle.
- Public per-port URLs (`sandbox.getHost(port)`) — this is how dev-preview HMR reaches the browser (4.6).
- Mature TS SDK, per-second billing (~$0.08/hr at 2 vCPU / 1 GB — a heavy 8h build day costs well under $1), custom templates so our base image (node 22, pnpm, git, our CLI preinstalled, warmed pnpm store) boots ready.
- Alternatives considered: **Fly Machines** (more DIY: we'd own the sandbox layer, image plumbing, and pause semantics), **Cloudflare Sandbox SDK** (edge-fast but the most ephemeral of the group; durable state requires bucket mounts; weaker fit for long dev-server sessions), **Modal** (Python/GPU-first, cold starts in seconds), **WebContainers in-browser** (no server cost, but no real Linux, licensing fees, memory-capped, dies with the tab — and the agent runs server-side, so it couldn't reach the browser's FS anyway), **self-hosted Firecracker** (violates N5). E2B is also already the named choice in `docs/connector-builder-prd.md`, so one sandbox vendor serves both initiatives.

**Session lifecycle** (managed by a new `sandbox-session.service` + Session API):

1. First agent turn or user opening the app's terminal/preview → `POST /sessions` → resume paused sandbox for `(workspace, user)` or create from template.
2. Init: clone workspace repo (shallow, sparse-checkout of `apps/` — cheap), checkout draft ref if one exists, `pnpm install` (warm store makes this fast), start `vite dev` for the focused app.
3. Idle timeout (e.g. 10 min) → flush → auto-pause. Hard cap (e.g. 24h) → flush → kill.
4. One interactive sandbox per user per workspace (not per app — the repo is per-workspace, and this halves cold starts when hopping between apps). Scheduled jobs use separate short-lived sandboxes.

**What the sandbox can reach (N1):**

- The Mako API only, using a **short-lived scoped session token** minted per session (workspace-scoped, TTL ≈ sandbox lifetime, revoked on session end). Injected as `MAKO_TOKEN` env var; the preinstalled `mako` CLI and `@mako/sdk` use it.
- Database access is **always proxied** through `POST /workspaces/:id/execute` with that token. Raw connection credentials never enter the sandbox. Egress target posture (from the merged draft): deny-by-default with registry domains allowed only during install and build egress re-disabled after dependencies are present; the internal pilot may run relaxed with the scoped short-TTL token bounding blast radius, but GA requires the deny-by-default posture.
- Package lifecycle scripts (`postinstall` etc.) run inside the sandbox with **no** Mako token, git credential, or deploy credential in scope — the token is injected only for interactive/agent processes, not install phases.

**The cloud sandbox is one of two substrates.** The session layer is designed as an executor seam: the agent's `bash`/file tools dispatch to a *session executor*, of which there are two implementations — the E2B sandbox (web app, headless jobs) and the **user's own machine** (a local checkout driven via the `mako` CLI or the desktop app's local agent, see 4.8). Everything above the seam — the agent, the tool contract, draft-ref durability, git as truth, credential proxying — is identical in both. Users working locally or in the desktop app therefore don't consume cloud sandbox compute at all: their filesystem is the working copy and their machine runs the shell, while data tools stay server-side. This mirrors a pattern the product already has for database connections, where the frontend routes `local_`-prefixed connections to the local agent at `127.0.0.1:41720` instead of the cloud execute API.

### 4.6 Agent tools v2

The unified agent (`api/src/agents/unified/index.ts`, `app` mode in `modes/registry.ts`) swaps the bespoke suite for:

| Tool | Replaces | Notes |
|---|---|---|
| `bash` | (nothing — net new) | Runs in the session sandbox, cwd = repo root; streamed output; timeout param. The workhorse. |
| `read_file`, `write_file`, `edit_file` (str-replace), `glob`, `grep` | `app_read_file`, `app_write_file`, `app_edit_file`, `app_delete_file`, `app_rename_file`, `get_app_state` | Direct FS fast paths (cheaper + more reliable than shelling out for the 90% case). |
| `bash("pnpm add …")` etc. | `app_add_dependency`, `app_remove_dependency` | No bespoke tool needed — this is the point. |
| `git` via `bash` + a `commit_app` tool | `app_save_version`, `app_restore_version`, `browse_version_history`, `get_version_snapshot` | `commit_app` wraps draft-ref squash so the agent can't push broken refs; history/restore are `git log`/`git checkout` away. |
| binding tools (kept, thinner) | `app_create_data_binding`, `app_update_data_binding`, etc. | See below — bindings become files; tools become "validate + materialize". |
| `run_app`, `open_app`, `app_set_preview_environment` (client) | same | Kept; `run_app` now reports Vite dev-server diagnostics instead of Babel errors. |
| `sql_*`, `mongo_*` discovery/query tools | same | Unchanged — USP #1. |

**Data bindings become files.** A binding is `apps/<slug>/bindings/<name>.sql` (or `.js` for Mongo) plus an entry in `mako.json` (`connectionId`, `materialization`, schedule). On flush, the server parses `mako.json` and reconciles with the materialization service (`app-binding-materialization.service.ts` reused nearly verbatim, keyed by app path + binding name + content hash instead of embedded-doc ids). This makes bindings editable from *any* harness — Claude Code edits a `.sql` file and the schedule stanza, and it Just Works. The `parquet` cache metadata moves to a small `AppDeployment` Mongo doc (server-owned state was never a good fit for the user-editable document anyway).

### 4.7 Preview & hosting

Two tiers replace the single CDN iframe:

**Dev preview (editing).** The sandbox runs `vite dev`; E2B exposes it at a public per-sandbox URL; `AppRenderer` iframes that URL. HMR works natively. The `@mako/app-sdk` becomes a real npm package (dep of the scaffold) that keeps the same API (`useQuery`, `useDuckDB`, `useTheme`, `useLocation`) and the same postMessage bridge to the authenticated parent window — so live queries, parquet/DuckDB, theming, and virtual routing carry over with minimal renderer changes, and the iframe still never holds credentials. When no sandbox is running, the preview shows the last published build with a "start dev session" affordance.

**Published (deployed).** "Publish" = deploy an **immutable commit** (never a moving branch head; a dirty worktree gets an explicit "commit and publish"): run `vite build` with `--frozen-lockfile` in a fresh build sandbox, upload `dist/` to a GCS/R2 bucket under a content-addressed deployment prefix, record an `AppDeployment` (commit SHA, lockfile digest, artifact digest), and point the routing entry at it. Rollback is a pointer change, no rebuild. Serving reuses the Cloudflare pattern we already run (`cloudflare/app-router/` KV-routed Worker) — but on a **separate registrable domain, never a `mako.ai` subdomain** (e.g. `<stable-app-id>.makoapps.dev`, registered in the Public Suffix List so sibling apps are different browser *sites*). User code sharing a registrable domain with the control plane would share cookie scope and same-site trust; this was a flaw in the first draft of this RFC. The Worker enforces the existing public-share model (tokens, password unlock, `allowLiveQueries`); runtime data access continues through `api/src/routes/public-share.ts` initially, evolving to a dedicated runtime capability endpoint (opaque, short-lived, deployment-scoped tokens exchanged via one-time bootstrap codes) as the end state.

This answers "if the app installs packages, how do we host it": packages are resolved at build time by a real bundler; hosting is static output, not CDN import-maps. **Scope note:** v2 published apps are static SPAs + data via Mako APIs. Server-side app code (API routes, SSR) is explicitly out of scope; the escape hatch for compute is scheduled scripts (4.9).

### 4.8 External harnesses & local workflow

**(a) Mako MCP server** (net new — today we are MCP *client* only, `api/src/services/mcp-client.service.ts`). A streamable-HTTP MCP endpoint at `/api/mcp`, authenticated by API key / PAT, exposing: schema discovery (`sql_list_tables`, `sql_inspect_table`, ...), query execution (row-capped), binding validation/materialization, `publish_app`, and docs/skills lookup. This makes Claude Desktop / Claude Code / Codex / Cursor first-class Mako citizens with USP #1 intact. Implementation is thin: the tools already exist as server tool impls; we're adding a protocol adapter and an auth path.

**(b) Local clone + Claude Code.** The flow the user described — no Mako app open at all:

```bash
git clone https://api.mako.ai/git/acme.git && cd acme/apps/revenue-dashboard
mako login          # device-code flow → PAT stored in ~/.mako (or paste an API key)
mako dev            # runs vite dev; @mako/sdk proxies useQuery → cloud execute API
claude              # Claude Code, with Mako MCP in .mcp.json (scaffolded into the repo)
mako agent          # ...or vibe with the Mako agent itself, right in the terminal (see (c))
```

- **Auth:** workspace API keys (`revops_*`) work day one via the existing `unifiedAuthMiddleware`. Fast-follow: user-scoped PATs with scopes (read:schema, execute:query, write:repo) so a leaked local token isn't a workspace-admin key, plus the `mako login` device flow.
- **Data access:** `@mako/sdk` in dev mode resolves bindings against `POST /workspaces/:id/execute` with the PAT — same proxy path as the web preview, credentials still never local.
- **Publish from local:** `mako deploy` = push + call Deploy API. USP #2 intact.
- The repo scaffold includes `.mcp.json` and `AGENTS.md`/`CLAUDE.md` describing the layout and the SDK, so third-party harnesses are effective immediately after clone.

**(c) The `mako` CLI — plumbing *and* a terminal agent.** The commands above imply a real CLI product (`@mako/cli`, installed via `npm i -g mako` or a curl script), not just glue. Beyond `login` / `clone` / `dev` / `deploy` / `run <job>`, it ships **`mako agent`: the Mako agent as a terminal harness**, so users can vibe-code an app from their shell the way they would with Claude Code — except this agent natively knows their workspace.

- **It is a thin client, not a second agent.** `POST /api/agent/chat` already accepts `revops_*` API keys through `unifiedAuthMiddleware`, so streaming, chat persistence, model selection, skills, modes, and MCP tools all come from the existing server for free. The CLI renders the stream and handles tool round-trips.
- **Tool execution split reuses the existing client/server pattern.** The codebase already splits tools into server-executed and client-executed (`app/src/agent-runtime/client-tool-manifest.ts` + `useClientToolDispatch`); the CLI simply becomes an alternative "client" surface. Data tools (`sql_*`, `mongo_*`, bindings, materialization, publish) keep running server-side; the v2 `bash`/`read_file`/`write_file`/`edit_file`/`glob`/`grep` tools execute **locally against the user's checkout** instead of an E2B sandbox. Same tool contract, two interchangeable executors: cloud sandbox when driven from the web app, local filesystem when driven from the terminal. One brain, two pairs of hands.
- **Safety:** local commands run with user permissions, so `mako agent` gets the standard harness treatment — per-command approval prompts with an allowlist, and a `--yolo` flag for the brave. Database credentials still never touch the machine (execute-API proxy, unchanged).
- **Cost shape:** terminal sessions consume zero sandbox compute (the laptop is the sandbox); users pay only Mako-side model tokens. This is complementary to (a)/(b), not competing: users who want their Claude/Codex subscription quota use those harnesses over MCP; users who want Mako's full data-aware toolchain in a terminal use `mako agent`. A headless mode (`mako agent -p "add a churn cohort filter"`) makes it usable from CI and scripts.

**(d) Desktop: local-first sessions + extension slot.** The desktop app (`packages/desktop`) gets two things.

*Local-first sessions.* On desktop, even the regular Mako chat doesn't need a cloud sandbox: the desktop app keeps a managed local checkout of the workspace repo (e.g. `~/Mako/<workspace>/`), and the agent's `bash`/file tools dispatch to the **local executor** (4.5) via the local agent instead of E2B. `vite dev` runs on the laptop and the preview iframes `localhost` — the same routing trick the app already uses for `local_` database connections. Draft-ref flushes still push to the workspace repo on the same cadence, so the web explorer, collaborators, and durability guarantees are unaffected by where the shell happens to run. Result: faster (no clone/boot), free (no sandbox billing), and offline-tolerant for everything except data queries — with cloud sandboxes remaining the default for browser users and the only option for headless jobs.

*Extension slot.* A right-panel "coding agent" slot that can host Claude Code / Codex (their CLIs speak a well-documented stdio/ACP protocol) against either the managed local checkout or a cloud sandbox terminal. `mako agent` speaks the same protocol and becomes the slot's first-party occupant, which also makes it the reference implementation to test the slot against.

To support both, the local agent (`packages/local-agent`) is extended with two capabilities, both opt-in and scoped: a PTY endpoint (shell restricted to the managed checkout directory) and repo file access. Its existing loopback + CORS trust model carries over. This is the last phase and can ship independently.

### 4.9 Scripts & scheduled jobs (bridge to the "ad-hoc data manipulation" future)

`mako.json` may declare jobs:

```json
{ "jobs": [{ "name": "refresh-geocodes", "run": "pnpm tsx scripts/geocode.ts", "schedule": "0 6 * * *" }] }
```

An Inngest function (same pattern as `dbt-run.ts` / `app-binding-materialize.ts`) spins a short-lived job sandbox: clone at `main`, install, run the command with a scoped `MAKO_TOKEN`, capture logs/exit code to a run record, kill. This is deliberately the same primitive as binding materialization and the future connector-builder PRD sandbox — one execution substrate for everything.

---

## 5. What happens to v1

- **Migration tool:** for each `MakoApp`, write `files[]` into `apps/<slug>/`, synthesize `package.json` from `dependencies` (+ scaffold `vite.config.ts`, `index.html`), convert `dataBindings[]` to `bindings/` files + `mako.json`, and commit as the app's initial history. `entity_versions` snapshots are optionally replayed as historical commits (nice-to-have).
- **Dual runtime window:** unmigrated apps keep rendering via the CDN iframe path; migrated apps use v2. The `runtime` field ("cdn" | "webcontainer") is repurposed/extended to gate this. Migration is per-app, user- or admin-triggered, with a bulk path once stable.
- **Retired after migration:** embedded `files[]`, the ~15 bespoke file/dependency/version tools, Babel/esm.sh preview, `entity_versions` for apps.
- **Kept:** `MakoApp` doc slims down to metadata + sharing + publish pointer (`repoPath`, `publishedSha`, `publicShare`, ACLs) — sharing and ACLs are workspace concerns and stay in Mongo; execute/materialization/public-share services; `@mako/app-sdk` API surface.

## 6. Phasing

Everything lands as a **parallel v2 module**: `api/src/apps-v2/**`, new Mongo collections (`app_projects_v2`, `app_worktrees_v2`, later `app_deployments_v2`), new routes (`/api/workspaces/:id/apps-v2/...`), and new agent tools (`app2_*`). No v1 route, schema, tool, or renderer is modified; v1 and v2 apps coexist until per-app migration.

1. **Phase 1 — Git substrate.** Mako-hosted bare repos (per app) + repository service with CAS ref updates and hidden WIP refs; Files API (tree/read from a ref); worktree service. Smart-HTTP clone endpoint. *De-risks: git hosting, the read model.* **(Foundation implemented in this PR.)**
2. **Phase 2 — Sandbox sessions + agent v2.** `SandboxProvider` abstraction (E2B for production; a flag-gated local subprocess provider for dev VMs), session service materializing accessible apps into a workspace-shaped directory, scoped tokens, `app2_bash`/file tools, WIP flush loop, `app2_commit`. Chat can build an app end-to-end. *De-risks: sandbox integration, flush durability, tool ergonomics.* **(Foundation implemented in this PR: provider seam + local provider + session/exec/flush + tools; E2B adapter next.)**
3. **Phase 3 — Preview & hosting.** `@mako/app-sdk` as real package + Vite scaffold; dev-preview iframe via sandbox URL; publish pipeline (build sandbox → bucket → apps-router Worker); binding-as-files reconciliation + materialization rewire.
4. **Phase 4 — Open editing.** MCP server, `mako` CLI (`login`/`dev`/`deploy`, then `mako agent` reusing the Phase 2 tool contract with a local executor), PATs with scopes, repo scaffold docs for third-party harnesses.
5. **Phase 5 — Desktop local-first + extension slot + jobs.** Local-agent PTY/file capabilities; desktop-managed workspace checkout with local executor sessions (Mako chat with zero cloud sandbox); right-panel harness hosting (with `mako agent` as first-party occupant); `mako.json` scheduled jobs; bulk v1 migration + CDN runtime deprecation.

Each phase ships behind a flag and is independently valuable (Phase 1 alone gives apps real history + local read-only clones).

## 7. Risks & open questions

| Risk / question | Position |
|---|---|
| Git hosting is new stateful infra | Accepted; smallest possible surface (bare repos + `git http-backend`), nightly bundles to GCS, swap-out path to Gitea/managed git behind an unchanged interface. |
| E2B vendor dependency / outage | Session layer is behind our own Session API; E2B is Apache-2.0 self-hostable as a last resort; an outage degrades to read-only explorer + published apps (both git/bucket-backed), not data loss. |
| Sandbox egress (exfiltration via `npm install` etc.) | Deny-by-default with install-phase registry allowlist is the GA posture; pilot may run relaxed with scoped short-TTL tokens bounding blast radius, and lifecycle scripts never see tokens. |
| Concurrent edits (two users, or Mako session + local push) | Per-actor worktrees + fenced CAS on WIP refs; branch commits check expected SHA; divergence surfaces as merge/rebase, never silent overwrite. UX for "your worktree is behind main" needs design. |
| Cost of always-editing users | Auto-pause makes idle free; per-second compute at ~$0.08/hr is negligible vs. LLM token cost of the same session. Budget alarms per workspace anyway. |
| Do bindings-as-files break the binding editor UI? | No — the binding editor becomes a structured editor over `bindings/*.sql` + `mako.json` via the Files API. |
| Monaco in-browser editing (no sandbox running) | Explorer writes go through a Files API write endpoint that commits directly to the draft ref server-side (isomorphic-git or a transient sandbox); keeps "quick edit" cheap. |
| Public URL isolation for published apps | Per-app host on a separate PSL-registered registrable domain (never `mako.ai`): different browser *sites*, no shared cookies or same-site trust with the control plane; Worker enforces share tokens/passwords. |
| Where do secrets for apps/scripts live? | Workspace-scoped secrets vault (encrypt with existing `crypto.service`), injected as env into sandboxes per `mako.json` declaration; never committed. Design in Phase 5. |

## 8. Alternatives considered (summary)

- **Keep Mongo as truth, add emulated shell tools** — rejected: emulating unix on a document store is a treadmill; no local clone; no real packages; the core premise (real FS+shell makes agents better) is unmet.
- **dbt-style Mongo-mirror-of-GitHub for apps** — rejected: requires GitHub install before first app; REST-blob writes are the wrong interface for a sandbox with a real git binary; two sources of truth.
- **WebContainers (in-browser)** — rejected: agent executes server-side and can't reach a browser FS; licensing; memory/runtime limits; state dies with the tab.
- **One repo per workspace** — this RFC's original position, reversed in the merge: per-app ACLs make a shared repo unauthorizable (clone access = read access to all objects). Agent context is recovered by materializing all accessible apps into one workspace-shaped session directory instead.
- **Run user code in the API container** — rejected outright (N1).
- **Fly Machines / Cloudflare / Modal instead of E2B** — viable fallbacks; E2B wins on agent-native SDK, pause/resume economics, per-port public URLs, and alignment with the connector-builder PRD.

## 9. Bindings v2 plan (agreed 2026-07-15)

Everything lives in the binding file; nothing in Mongo except derived cache.

**Block 1 — Front matter (foundation).** Binding = `bindings/<name>.sql`; name = filename; discovery = git glob (the `mako.json bindings[]` array dies; kept briefly as deprecated fallback). Leading SQL-comment front matter: `-- connection:` (required), `-- materialization:` (default parquet), `-- schedule:` (cron, optional), `-- dbt_project:` (optional → `{{ dbt_schema }}` rendered at materialize time). Rationale: branch-per-conversation makes central metadata files (yaml/json array) merge-conflict magnets — two conversations adding bindings must never conflict; dbt-style in-file config; self-contained diffs/copies. Migrate binding-smoke; update apps-v2 skill.

**Block 2 — Agent/API completeness.** `app2_materialize` tool (+ bridge-policy entry + MCP candidate set) reading bindings from the conversation's OWN branch; materialize route gains `?ref=` so pre-merge branches build; single artifact per (project, binding) to start (last-writer-wins across branches — revisit if it bites). Materialization errors surface to the agent verbatim.

**Block 3 — Console-editor UX (v1 parity).** Opening `bindings/*.sql` from the v2 explorer routes to a console-style editor, not plain Monaco: SQL highlighting, connection picker ↔ `-- connection:` line, Run (console engine, read-only), materialization toggle + cron picker ↔ front-matter lines, Materialize-now button, last-build status chip. Explorer shows a per-app Data bindings node (v1 "Data sources" parity).

**Block 4 — Scheduler.** Derived schedule index rebuilt on commit/merge-to-main (parse front matter during the mirror-push hook) → registry (Mongo now, Postgres later; cache, rebuildable) → Inngest cron materializes due bindings, reusing v1 scheduling patterns.

**Block 5 — Runtime polish.** `__data/<name>.parquet`: Range support + ETag (Content-Length shipped 2026-07-15); skill guidance for hyparquet/duckdb-wasm; consider a tiny v2 SDK helper later.

Order: 1 → 2 → 3; 4 needs 1; 5 independent. Adjacent, already recorded elsewhere: Phase B substrate pivot (GitHub API reads, sandbox clones, delete local git), dev GitHub App callback repoint to app.mako.ai at merge.

## 10. Workspace monorepo refactor plan (agreed 2026-07-16)

Target model: a workspace IS a git repo. One repo, top-level folders per
content type, one branch per user session, auto-commit everywhere. Mongo keeps
only identity/ACL/derived caches — no file content, no per-type repo bindings.

**End-state invariants**
- `workspace.repo` (singular). Cloud tier: `<prefix>-<workspaceId>` under
  mako-ai-cloud, provisioned lazily. BYO: link/re-point an existing GitHub repo.
- Repo layout: `apps/<slug>/`, `consoles/`, `skills/`, `dbt/`,
  `users/<userId>/…` for personal content. Folders are organization, never
  authorization (Mako's API stays the ACL plane; documented BYO semantics).
- A user session is always on exactly ONE branch. Switching branch re-checkouts
  explorer, open tabs, and the session sandbox atomically. Conversations keep
  `chat/<chatId>` branches; opening a conversation switches the session onto
  its branch. Merge to main = publish, unchanged.
- Every mutation is a commit: agent turns (already), manual saves
  (`edit: <path>`, consecutive saves by the same author to the same file
  squashed within a short window). No staged/uncommitted UI state anywhere.

**Block A — auto-commit manual edits (no migration, do first).**
Worktree flush path (`worktree.service.ts flushWorktree` / file-save route)
commits on save instead of accumulating; mirror-push coalescing already
handles chattiness. Delete the Commit button + dirty badge from
`AppsV2Explorer`; VERSION CONTROL collapses to branch picker + history.

**Block B — one repo per workspace.**
Schema: `workspace.repo` replaces `workspaceRepos[]` (migration takes
`workspaceRepos[0]`; service-layer guard refuses adding a second). Cloud
provisioning becomes one `ws-<workspaceId>` repo; apps live at `apps/<slug>`
instead of repo-per-project (`cloud-repo.service.ts`,
`repository.service.ts`, `worktree.service.ts` drop the per-project repo
assumption). `AppProjectV2` demotes to a derived cache of `git glob
apps/*/mako.json` (kept for ids/back-compat, rebuilt on fetch). Explorer
flattens: rail shows the repo root, no org/repo grouping. Migration script
consolidates existing per-project cloud repos into `apps/<slug>` as tree
snapshots (old repos archived; full-history subtree import only if someone
needs it).

**Block C — per-session branch state + checkout propagation.**
Frontend: single `branch` in the apps-v2 store root, persisted per
(user, workspace); every read API call carries `?ref=` (explorer tree, file
opens, binding state). Backend: read endpoints accept `ref`; session sandbox
keyed (workspace, user) runs `git fetch && git checkout` on switch; realtime
`app-v2.updated` pokes carry the branch so only sessions on that branch
refetch. Branch picker lists main + conversation branches with friendly
labels ("Chat: port engagement score").

*Explorer ↔ sandbox sync contract (agreed 2026-07-16).* There is no shared
filesystem between the API and the sandbox and none is wanted (E2B can't
mount external volumes, Cloud Run disk is tmpfs, and a shared working tree
means two uncoordinated writers — shared bytes without atomicity, history,
or conflict detection). **The git remote IS the shared storage**; Block A's
auto-commit is what makes this sound — every manual save is a commit, so
"uncommitted change the sandbox can't see" is not a state that exists. Sync
is the same bus in both directions:
- Agent → explorer (built): turn ends → commit + push → poke → explorer
  refetches.
- Explorer → sandbox: manual save → commit (Git Data API) → the same poke,
  carrying the branch → the API execs `git pull --rebase --autostash` into
  the live sandbox sessions it tracks on that branch, over the E2B control
  channel. No in-sandbox daemon, no polling. Side effect: a running dev
  server HMRs the pulled change, so manual saves update live previews.

The sandbox pulls at exactly four moments: (1) session start/resume,
(2) poke received while no agent turn is in flight, (3) just before an agent
turn starts, (4) in the turn-end push loop — `push --force-with-lease` fails
because the remote moved → fetch, rebase, retry. (4) covers the only racy
window (manual save lands mid-turn): non-overlapping edits rebase silently;
true same-line conflicts surface to the AGENT at push time — the one writer
in the system that can actually resolve a merge conflict. A soft editor
warning when the branch has a turn in flight is the cheap guard if this
bites; not built until it does.

Deferred optimization (not v1 of this block): write-through — when a WARM
sandbox exists on the branch, route the manual save through it (write +
commit + push inside the sandbox) instead of the Git Data API: one working
tree per branch, zero rebases in the common case, instant HMR. Costs a
second write path and ties save latency to sandbox liveness; ship
pull-on-poke first, add write-through only if rebase noise shows up.

**Block D — content moves into the repo (staged, each shippable alone).**
- D1 `skills/`: workspace skills as `skills/<name>/SKILL.md`; agent skill
  discovery reads the repo (system skills stay in the API image).
- D2 `consoles/`: `consoles/<name>.sql` with the SAME front-matter convention
  as bindings (`-- connection:` etc.); `savedconsoles` migrates via script,
  then becomes read-only fallback → deleted. DECISION recorded: consoles in
  the repo are workspace-visible; personal ones go under
  `users/<userId>/consoles/`.
- D3 `dbt/`: dbt project folds into `dbt/` in the workspace repo; the
  separate dbt repo binding + Mongo file mirror (`DbtFileDraft`) unwind onto
  the session-branch model. Biggest migration, existing customers — LAST, own
  RFC section when we get there.

**Block E — decommission.** Delete: `workspaceRepos[]` array + service +
Settings repo-list UI, org/repo explorer nodes, per-project cloud repos,
remaining WIP/CAS remnants. Update skills + MCP docs.

Order: A → B → C → D1 → D2 → E → D3. A is independent and instant. C
technically works before B but the branch picker only becomes comprehensible
once there is a single repo, so B first. The Phase B substrate pivot
(GitHub-API reads) composes: single repo makes ETag caching and the ref
authority story strictly simpler.

Open questions: (1) history preservation when consolidating existing
per-project repos — default is snapshot, not subtree; (2) console autosave
cadence vs commit noise — squash window length; (3) whether `AppProjectV2`
dies entirely or stays as an id-stable cache once explorer reads git directly.

### 10.1 Status + Block B substrate design (2026-07-16)

Shipped: **Block A BUILT** (auto-commit on manual save, `edit: <path>`,
5-min same-author-same-file squash via branch-head amend; Commit button,
dirty chip and dialog deleted; verified live). **Block B slice 1 BUILT**
(`connectWorkspaceRepo` refuses a second distinct repo; `getWorkspaceRepo`
singular read API; legacy `appsV2Repo` counts as THE repo until
disconnected).

Block B substrate design (execution spec for the remaining slices):

- **Git substrate**: ONE bare cache repo per workspace,
  `~/.mako/apps-v2/repos/<workspaceId>.git`; cloud remote
  `<prefix>-<workspaceId>` under mako-ai-cloud. `repoDirFor(workspaceId)`,
  `ensureLocalRepo(workspaceId)`, `cloudRepoNameFor(workspaceId)` all drop
  their projectId parameter.
- **Apps are folders**: `apps/<slug>/` at the repo root. `AppProjectV2`
  gains an immutable `slug` (kebab, unique per workspace, derived from the
  title at creation; migration backfills from title, deduped). The doc
  stays as the id-stable pointer; content lives only in git. All per-app
  file APIs keep their shapes and internally prefix `apps/<slug>/`
  (routes, agent tools, bindings glob `apps/<slug>/bindings/*.sql`,
  scaffold, preview build cwd, dev-server root).
- **Worktrees per (workspace, actor)** — not per project: one
  `AppWorktreeV2` per actor per workspace, session dir = clone of the
  workspace repo; a chat's `chat/<chatId>` branch can span apps (a real
  capability, not a bug: one conversation can edit an app + its skill).
  `commitChatTurn` iterates the actor's single workspace worktree.
- **Migration** (`2026-07-16_workspace_monorepo`): per workspace — ensure
  the workspace cloud repo; per project, read the old repo's main tree and
  commit it under `apps/<slug>/` ("migrate: <title>"); mirror push; backfill
  `slug`; DELETE all AppWorktreeV2 docs (disposable caches — auto-commit
  means uncommitted residue is at most the last unsaved buffer) and the
  local per-project bare repos; old per-project cloud repos left in place,
  cleaned up manually after verification (snapshot migration — history
  stays reachable in the old repos).
- **Explorer/store flattening** rides the same slice: one repo node is no
  UI at all — the rail lists apps (later: all root folders); org/repo
  synthetic nodes and `repos[]` state die.

Execution order (each lands green): repository.service →
cloud-repo.service → worktree.service (+scaffold) → routes/tools/bindings →
preview/dev-server → store/explorer → migration script → tests.
