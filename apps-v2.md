# Apps v2 — RFC / PRD

> Git-backed filesystem, real shell, real builds, and open editing for Mako apps.

- **Status:** Merged proposal (synthesis of this RFC and the parallel draft on `cursor/apps-v2-rfc-9359`); git substrate and workspace monorepo built (§10.1), local-first developer surface not started (§11.7)
- **Read this first:** §13 is the app lifecycle (view / edit / publish) and the nearest work; §12 settles the substrate (E2B everywhere); §11 states the current vision — why we are doing this (unit economics, not just ergonomics), the `main`-is-production monorepo model, the decided access model, the remaining open decision, and the sequencing. §§1–9 remain accurate as design history; where §11 disagrees with §4.8's framing or §6's ordering, §11 wins.
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
| **Local-first is the strategy, not a feature (supersedes §4.8's framing)** | Reselling inference at API rates loses to the Claude Code / Codex subscriptions our users already hold: the same building hour costs us gateway tokens + E2B minutes + kernel time in the browser, and **zero marginal compute** in their terminal — with a better harness than we will ever staff. Mako repositions as the **data and deployment control plane, not an inference reseller**; the moat is credential-free warehouse access with real schema tools (over MCP) plus instant deploy/hosting, neither of which a clone gives you. The web tier is NOT replaced — E2B, the kernel and the gateway remain, serving non-technical seats and the on-ramp. **Pricing must move from token-shaped to seats/workspaces/deployments before local-first goes wide**, or the product gets better exactly as revenue evaporates (decision required, not yet made). Detail: §11.1–11.2. | User (2026-08-19) |
| **`main` is production; the workspace repo is an app monorepo** | Target workflow: `git clone` the workspace repo → `mako` serves the UI at localhost:6969 → `claude` in the checkout is fully Mako-aware → commit, push, PR → **merging deploys**. Publishing stops being a concept separate from merging; conversation branches and human feature branches are the same kind of proposal. Per-PR preview deploys are desirable and explicitly NOT a blocker. Detail: §11.3–11.4. | User (2026-08-19) |
| **Repo access is a builder tier, not a member right (DECIDED)** | Git is not a member interface. **Normal users never touch the repo** — they reach content only through Mako's API, which enforces per-app ACLs exactly as today, so their ACL plane is unchanged and airtight. Repo access is a distinct **builder tier**: an explicit per-workspace capability carrying workspace-wide read as an accepted, documented property (the trust model every company runs on its monorepo). **Read and write are separate boundaries**: clone = confidentiality, push-to-`main` = integrity — builders push branches freely, `main` is branch-protected, and GitHub branch protection becomes the deploy gate for free. Consequence: `users/<id>/` means "not cluttering the workspace view", NOT "confidential from builders" — product copy must stop promising privacy the substrate does not deliver; splitting personal content into per-user repos is the trigger-based later fix. Open sub-decision: how builders get access — GitHub collaborators via the Cloud Storage App (proposed for pilot) vs. a Mako git proxy (`api.mako.ai/git/<workspace>`, a partial return of §4.3). Today no human has ANY access to cloud repos, so this is net-new work either way. Detail: §11.5. | User (2026-08-19) |
| **Repo layout stays owner-first; signal/noise is a checkout-scope problem** | Reconsidered and re-affirmed §10's layout: `apps/<slug>/`, `consoles/`, `skills/`, `dbt/` at the root, personal content under `users/<userId>/apps/…` and `users/<userId>/consoles/…`. Type-first (`apps/workspace/`, `apps/users/joan/`) rejected again — for a reason §10 did not state: **both access and noise are "exclude one subtree" operations**, so owner-first needs ONE rule where type-first needs one per content type, a list that grows with every new type and fails silently in the unsafe direction when someone forgets. Type-first wins only on uniform globbing — a cost paid once in code against a risk paid forever. **Layout alone does not fix noise: checkout scope does.** Sparse-checkout (nonexistent today) should default BOTH the builder's clone and the agent's sandbox to workspace content + the caller's own `users/<id>/`, with `CLAUDE.md` stating the scope. Converges with §11.5: if the per-user-repo trigger fires, the workspace repo becomes type-first by construction and the question dissolves — and owner-first `git subtree split`s cleanly into that end state where type-first would have to scatter-gather. Free to settle now: `users/<id>/` is unimplemented and nothing needs migrating. Detail: §11.10. | User (2026-08-19) |
| **Prior art (verified 2026-08-19): the differentiator is source-vs-serialized-state, not git-vs-no-git** | Netlify/Vercel are a deploy layer on a repo GitHub already governs — never owning the store, they never answer "who may clone", never bridge platform↔git identity, and have no personal-content-in-a-shared-repo concept; our cloud tier inherits all three as the price of instant-start. They validate §11.4 wholesale (many projects per repo with base directories + build-skip, production branch → prod deploy, **PR previews as table stakes** — evidence against deferring them), and their template flow is the origin of §11.5 option (iii). **Correction to an earlier draft:** Retool/Hex/Appsmith are NOT simply "a mirror". Retool Source Control has real git feature branching and PR-gated main-is-prod, serializing apps to **ToolScript** (`.rsx`, JSX-style, replaced YAML for readability) — but *"Retool recommends you not modify Toolscript files directly"*, no linting or type-checking: **reviewable by design, not authorable**. Hex Git export is **one-way only** (Hex is source of truth; manual YAML re-import exists but is not a sync) and is **incompatible with branch protection**. Appsmith (open source) keeps the **database authoritative** with one server-side mirror clone. So the real differentiator is **what the repo contains**: their serialized GUI state vs. our actual source (a real Vite/React app, real `.sql`), which is exactly why Claude Code works on a Mako repo and cannot work on a `.rsx`. Also corrected: multiplayer and git are NOT inherently in tension (Retool/Appsmith have both) — the trade is resolved by **whoever holds truth**, and git-authoritative costs us real-time co-editing, which must be stated rather than discovered. Lessons stolen: Appsmith's git-ops-too-slow→timeout→corruption and metadata-churn warnings; Hex's branch-protection incompatibility (our publish must go THROUGH a PR, never around it); secrets in the DB not the repo (consensus, settles §7). Detail: §11.11. | Verified research 2026-08-19 |
| **One substrate: E2B everywhere; the local provider is deleted (DECIDED)** | Three unrelated activities were all called "development", and the substrate was chosen for the wrong one. **(1) Developing Mako runs on E2B** — exercising a substrate no user runs ships untested code paths and carries a second implementation forever; every developer has an E2B key, like a database URL. Proven, not theoretical: the nested-node_modules bug (app could not build; 13-27s per command) survived from Block B until 2026-08-20 **because the local provider has no host↔sandbox sync at all** — structurally invisible there, immediate on E2B. **(2) Customer app dev on app.mako.ai runs on E2B** — N1, plus an unsandboxed shell lets a tenant exhaust the API host. **(3) Local customer dev uses NO Mako sandbox**: the user has the WORKSPACE repo checked out, a `mako` executable supplies data proxies + auth, and the user (or Claude Code) runs `vite dev` directly as themselves — Mako is not in the execution path, and **the user never checks out Mako**. This corrects §4.8(d)'s "local executor behind the provider seam". Deleted: local-provider.ts, dev-server.service.ts, dev-preview-ws-proxy.ts, the devPreviewAvailable probe + toolbar gating, and the APPS_V2_SANDBOX_PROVIDER knob; provider.ts stays as the seam for a Fly/Modal fallback. **Live preview moves INTO the sandbox** (vite on 0.0.0.0 + `sandbox.getHost(port)` + iframe), which is why it can finally exist in deployed environments at all. Detail: §12. | User (2026-08-21) |
| **App lifecycle: view / edit / publish (§13)** | Found by this RFC's own author: *"even though I built this, I don't understand the UX"*. The cause is not labelling — **there is no publish, no deploy and no viewer**: `publishedSha` is never written by anything, there is no public-share route, the built bundle is served behind a 30-MINUTE in-memory token, and even browsing an app calls `ensureWorktree`. Apps v2 is an IDE with two developer preview modes. **Correction to an earlier claim in this session:** data is much further along — bindings already materialize into the shared artifact store (GCS when deployed) at `apps-v2/<projectId>/<name>.parquet`, so warehouse→parquet→bucket is DONE and durable; only the serving path is tied to the ephemeral preview token. Target: three states, one primary action each — Published (no sandbox at all; primary = Edit), Editing (branch + dev session; primary = Publish), Never published. Publish = merge → build from main → IMMUTABLE addressable artifact → repoint, which makes rollback a repoint. Open: an ACL'd data path for published apps (§4.7 capability tokens — the genuinely hard part), scheduled refresh, failed-build-on-main, rollback UX, concurrent editors, static-only boundary. Detail: §13. | User + analysis (2026-08-21) |
| **What `mako` runs locally (OPEN)** | Two readings of "the full Mako app at localhost:6969": a **thin local shell** (serves the UI, owns the local checkout, runs `vite dev`, proxies control plane + data execution to the cloud — materially `packages/desktop` + `packages/local-agent` minus Electron; ships in weeks, no new deployment target) versus a **full local stack** (API + database + Inngest + kernel on the laptop; true self-host, permanent second deployment target and support surface). **Proposed default: thin shell**, full stack only if self-hosting proves to be a sales requirement. Detail: §11.6. | Raised 2026-08-19 |
| **Sequencing: cheap half first; `mako agent` deferred indefinitely** | Order: (1) scaffold `CLAUDE.md`/`.mcp.json` + §10 Block D1 `skills/` so `git clone && claude` is Mako-capable with no CLI at all — generated from the same source as `buildMakoSystemPromptAppend` to avoid drift; (2) **deploy on merge** (`publishedSha` is currently read but never written — no pipeline exists, so §11.4 is not yet true); (3) minimal `@mako/cli` (`login` + `dev` only); then Block D2 consoles + Block C branch state; then revisit §11.6. The **`mako agent` terminal harness (§4.8c) is deferred indefinitely** — building a competing harness with our tokens contradicts the reason for the work. Detail: §11.7–11.9. | User (2026-08-19) |

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

> **§12 removes the local provider.** The "flag-gated local subprocess provider
> for dev VMs" described here is deleted: Mako development runs on E2B too, so
> we exercise the substrate we ship. The seam stays for a Fly/Modal fallback.

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

> **§12.4 supersedes the dev-preview tier.** Live preview now runs `vite dev`
> INSIDE the sandbox and iframes E2B's per-sandbox public URL, rather than
> spawning vite on the API host. The published-app end state below (separate
> PSL-registered domain, capability tokens) is unchanged.

Two tiers replace the single CDN iframe:

**Dev preview (editing).** The sandbox runs `vite dev`; E2B exposes it at a public per-sandbox URL; `AppRenderer` iframes that URL. HMR works natively. The `@mako/app-sdk` becomes a real npm package (dep of the scaffold) that keeps the same API (`useQuery`, `useDuckDB`, `useTheme`, `useLocation`) and the same postMessage bridge to the authenticated parent window — so live queries, parquet/DuckDB, theming, and virtual routing carry over with minimal renderer changes, and the iframe still never holds credentials. When no sandbox is running, the preview shows the last published build with a "start dev session" affordance.

**Published (deployed).** "Publish" = deploy an **immutable commit** (never a moving branch head; a dirty worktree gets an explicit "commit and publish"): run `vite build` with `--frozen-lockfile` in a fresh build sandbox, upload `dist/` to a GCS/R2 bucket under a content-addressed deployment prefix, record an `AppDeployment` (commit SHA, lockfile digest, artifact digest), and point the routing entry at it. Rollback is a pointer change, no rebuild. Serving reuses the Cloudflare pattern we already run (`cloudflare/app-router/` KV-routed Worker) — but on a **separate registrable domain, never a `mako.ai` subdomain** (e.g. `<stable-app-id>.makoapps.dev`, registered in the Public Suffix List so sibling apps are different browser *sites*). User code sharing a registrable domain with the control plane would share cookie scope and same-site trust; this was a flaw in the first draft of this RFC. The Worker enforces the existing public-share model (tokens, password unlock, `allowLiveQueries`); runtime data access continues through `api/src/routes/public-share.ts` initially, evolving to a dedicated runtime capability endpoint (opaque, short-lived, deployment-scoped tokens exchanged via one-time bootstrap codes) as the end state.

This answers "if the app installs packages, how do we host it": packages are resolved at build time by a real bundler; hosting is static output, not CDN import-maps. **Scope note:** v2 published apps are static SPAs + data via Mako APIs. Server-side app code (API routes, SSR) is explicitly out of scope; the escape hatch for compute is scheduled scripts (4.9).

### 4.8 External harnesses & local workflow

> **Framing superseded by §11.** This section treats external harnesses as one surface among several; §11.1 promotes them to the strategically primary surface for technical users, and §11.8 reorders what gets built. The mechanics below (MCP server, local clone flow, auth staging, desktop local-first) remain correct — but note that `mako agent` (c) is now **deferred indefinitely** per §11.9, and that the repo scaffold promised in (b) is still unbuilt (§11.7), which is exactly what §11.8 step 1 fixes.

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

*Local-first sessions.* **Corrected by §12.2(3): there is no "local executor" and no Mako sandbox on the user's machine — the user has the workspace repo, `mako` supplies data proxies and auth, and they run `vite dev` themselves. The paragraph below is kept as design history.** On desktop, even the regular Mako chat doesn't need a cloud sandbox: the desktop app keeps a managed local checkout of the workspace repo (e.g. `~/Mako/<workspace>/`), and the agent's `bash`/file tools dispatch to the **local executor** (4.5) via the local agent instead of E2B. `vite dev` runs on the laptop and the preview iframes `localhost` — the same routing trick the app already uses for `local_` database connections. Draft-ref flushes still push to the workspace repo on the same cadence, so the web explorer, collaborators, and durability guarantees are unaffected by where the shell happens to run. Result: faster (no clone/boot), free (no sandbox billing), and offline-tolerant for everything except data queries — with cloud sandboxes remaining the default for browser users and the only option for headless jobs.

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

> **Phases 4–5 reordered by §11.8.** Phases 1–3 describe what was built (see §10.1 for actual status). The open-editing work in Phase 4 is now split: repo-resident agent instructions + `skills/` come FIRST (they need no CLI at all), deploy-on-merge second, and the `mako` CLI shrinks to `login` + `dev`. `mako agent` moves out of Phase 4 entirely (§11.9).

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
dirty chip and dialog deleted; verified live). **Block B BUILT**
(2026-07-16): slice 1 — `connectWorkspaceRepo` refuses a second distinct
repo, `getWorkspaceRepo` singular read API; slice 2 — the full substrate
per the spec below (workspace bare repo, apps/<slug> folders with internal
prefixing, per-(workspace, actor) worktrees, app lifecycle as commits,
workspace-keyed cloud mirror, `2026-07-16-120000_workspace_monorepo`
migration run against dev, explorer flattened to a plain app list).
Verified live end-to-end on the consolidated dev workspace. Remaining in
§10: Block C (per-session branch state + sync contract), Block D (skills →
consoles → dbt into the repo), Block E cleanup (workspaceRepos array
storage, repo-list settings UI, legacy fields).

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

---

## 11. Local-first: unit economics, the monorepo, and the developer surface (2026-08-19)

> Relationship to the rest of this RFC: §10 (workspace monorepo) is the
> substrate this section stands on and is unchanged. §11 **supersedes the
> framing of §4.8** (external harnesses were "a surface we should also have";
> they are now the strategically primary surface for technical users) and
> **reorders §6 Phases 4–5**. It also reopens one line in §8: the alternative
> "one repo per workspace" was rejected there because _"clone access = read
> access to all objects"_ — §10 reversed the topology, and §11.5 is where that
> objection comes due.

### 11.1 Why — the third reason, stated properly

Three arguments carry this work. Two are already in §1 and settled:

1. **Don't reinvent version control.** A file tree, versions, diffs, conflict
   resolution, and change descriptions are what git _is_. We built each of them
   badly on top of Mongo, twice (§1.3).
2. **Agents work best with a filesystem, a shell, and a sandbox.** The Claude
   Code / Codex / Cursor result is unambiguous: the same model is dramatically
   more effective when it can compose unix tools instead of waiting for us to
   ship bespoke ones (§1.1).

The third is a different kind of claim — not about product quality, about the
business — and it is the one that should drive sequencing:

3. **Reselling inference is a losing position.** Mako-web usage costs us
   gateway tokens at API rates, E2B sandbox minutes, notebook kernel time, and
   the maintenance of our own harness. The same user, in their own terminal,
   against a Claude Code or Codex subscription they already pay for, costs us
   **zero marginal compute** — and gets a better harness than we will ever
   staff. Every hour of serious building we move from our tokens to theirs
   improves gross margin and product quality _at the same time_. That is a rare
   alignment and we should lean into it hard.

The synthesis: **Mako is the data and deployment control plane, not an
inference reseller.** We stop competing with Claude Code and start being the
thing that makes Claude Code useful against a company's warehouse.

### 11.2 What Mako sells when the harness is BYO

If the user brings their own agent and their own machine, the value has to be
somewhere we cannot be cloned out of. It is, and it is the same pair §1 already
named as the USP — this section just promotes them from "must not lose" to
"the entire basis of the business":

- **Credential-free data access with real schema tools.** Connections,
  `sql_list_tables` / `sql_inspect_table` / query execution, bindings and
  materialization — over MCP, authenticated, row-capped, with warehouse
  credentials never leaving our backend. A local clone gets you the code; it
  does not get you the data. This is the moat.
- **Instant deploy and hosting.** Merge and it is live, shareable, and
  scheduled. No Vercel account, no CI, no DNS.
- **The web tier itself.** Non-technical users never clone anything. The
  browser app, with our sandbox and our harness, remains the on-ramp and for
  most seats the only surface. Local-first is a **second tier, not a
  replacement** — E2B, the kernel, and the gateway do not go away.

**Pricing consequence (decision required, not yet made).** If serious usage
moves to BYO harnesses, revenue cannot be token-shaped or it evaporates exactly
as the product gets better. Pricing must move to seats / workspaces /
deployments / connected data volume before local-first goes wide. Shipping the
local path on token-based pricing is how this becomes a very elegant way to
lose money.

### 11.3 The target workflow

The builder-facing story, end to end, with no Mako tab open until the last step:

```bash
git clone https://github.com/<org>/ws-<workspaceId>.git acme && cd acme
mako                  # serves the full Mako UI at http://localhost:6969
claude                # sees CLAUDE.md, .mcp.json, skills/ — fully Mako-aware
# ...build apps and consoles locally, with real workspace data...
git commit && git push && gh pr create
```

Merging the PR deploys. Everyone else opens the web app and the change is
simply there. If the PR is open rather than merged, a cloud preview deploy is
_nice to have, explicitly not a blocker_.

The load-bearing property is that **`claude` in a fresh clone is immediately as
capable as Mako's own chat** — same skills, same data tools, same conventions.
It gets there via the MCP server (already built) plus repo-resident
instructions (not built; §11.7).

### 11.4 `main` is production

The workspace repo behaves like an ordinary application monorepo containing
many apps:

- **`main` is the production deployment.** The deployed state of every app is
  whatever `main` holds. Publishing is not a separate concept from merging.
- **Branches are proposals.** A conversation branch (`chat/<chatId>`) and a
  human's feature branch are the same kind of thing; both merge to `main` to go
  live. §10's per-session branch model (Block C) already matches this.
- **A PR is the review surface** for anyone who wants one. Mako's in-app
  "publish" button and `gh pr merge` are two doors onto the same mechanism.
- **Preview deploys per PR** are the natural extension and are deferred.

This is the model the RFC has been converging on since §10 ("merge to main =
publish"); §11 states it as the product model rather than an implementation
detail, and notes the piece that makes it true is missing today (§11.7).

**This shape is orthodox, not invented here** — production-branch deploys, PR
previews, and many projects per repo with a base directory each are exactly how
Netlify and Vercel work. See §11.11.

### 11.5 Repo access is a builder tier, not a member right (decided 2026-08-19)

§10 committed to _"folders are organization, never authorization — Mako's API
stays the ACL plane"_, and justified it for the cloud tier on the grounds that
**cloud-tier users have no direct repo access, so Mako's ACL is airtight
there.** §11.3 hands exactly that access to anyone who clones: every app, every
console, every `skills/` file and every `users/<otherUserId>/` folder,
permanently, offline, and outside any revocation we control. This is §8's
original objection to the workspace mega-repo, arriving on schedule.

**Decision: git is not a member interface.** Normal users never touch the repo.
They reach content only through Mako's API, which enforces per-app ACLs exactly
as it does today — so for them the ACL plane is unchanged and airtight. Repo
access is a distinct **builder tier**: an explicit capability, granted per
workspace, that carries workspace-wide read as an accepted and documented
property. This is the trust model every company already runs on its monorepo —
engineers can read the whole thing — and it is a tier, not a per-object grant,
which is what keeps it comprehensible.

**Read and write are separate boundaries.** Clone is the confidentiality
boundary; push to `main` is the integrity boundary. With `main` = production
(§11.4) they decouple cleanly: builders clone and push branches freely, `main`
is branch-protected, and merges land via review or via Mako's API (which can
still enforce per-app publish rights). GitHub branch protection becomes the
deploy gate at no cost.

**Consequence — "personal" stops meaning "private".** §10 places
`users/<userId>/consoles/` in the workspace repo. The builder tier protects
normal users *from* git but not *in* it: a builder who clones reads every
user's personal content, and that user never opted into the builder tier's
trust model. Two honest resolutions:

- **Now (accepted):** `users/<id>/` means "not cluttering the workspace view",
  not "confidential from builders". Product copy must say so — no UI may
  promise privacy the substrate does not deliver.
- **Later (trigger-based):** if personal content becomes somewhere people keep
  secrets, `users/<id>/` moves to a per-user repo outside the workspace repo.
  Costs a second repo per active user and weakens the "one clone has
  everything" property that makes §11.3 attractive; do it only when the trigger
  fires.

**Open sub-decision — how builders actually get access.** Today *no human has
any access to cloud repos at all*: `mako-ai-cloud` repos are touched only by
Mako's installation token. Granting the builder tier is therefore net-new work,
with a fork:

- **(i) GitHub collaborators.** Mako adds/removes builders on the workspace
  repo through the Cloud Storage App (already holds `administration:write` —
  verify it covers the collaborator endpoints). Nearly free, and PR review
  comes with it. Cost: builders need GitHub accounts, coupling workspace
  membership to GitHub identity — the exact mismatch §0 flagged, though it is a
  safe assumption for builders specifically, who are already using git.
  Revocation must be wired to workspace membership removal.
- **(ii) A Mako git proxy.** `git clone https://api.mako.ai/git/<workspace>`
  authenticated by a Mako PAT, proxying to GitHub underneath. One identity
  system, no GitHub account required, and a natural policy chokepoint — partly
  a return of the smart-HTTP clone endpoint from §4.3 / §6 Phase 1.

- **(iii) Put the repo in the customer's own GitHub org.** The pattern Vercel
  and Netlify use when they create a repo from a template: the platform creates
  it in *your* account/org, never in a platform-owned one. Then "builder
  access" is simply GitHub access the customer already administers — no
  collaborator management, no proxy, and revocation is automatic when they
  remove someone from their org. Mako keeps its installation token and never
  becomes an identity provider for git. Cost: requires a GitHub org up front,
  which is exactly the friction the cloud tier's "instant start, no GitHub
  setup" promise exists to remove.

**Proposed: reframe as a tier split rather than one global answer.** BYO / pro
tier takes (iii) — the repo lives in the customer's org and this sub-decision
evaporates entirely. Cloud tier keeps `mako-ai-cloud` and takes (i) for the
pilot, with (ii) as the escape hatch if the GitHub-account requirement bites.
Note the pleasing asymmetry: the tier that most needs Mako to solve git access
is the tier whose users are least likely to want a clone at all, so (i) can
stay minimal for a long time. Not yet decided.

### 11.6 Open decision — what `mako` actually runs locally

"`mako` starts the service and the full app appears at localhost:6969" admits
two very different implementations:

- **Thin local shell (recommended).** `mako` serves the web UI, reads and
  writes the local checkout, runs `vite dev` for previews, and **proxies the
  control plane and all data execution to the cloud API**. Auth is the existing
  API-key / OAuth path. Warehouse credentials still never reach the machine.
  This is materially what `packages/desktop` + `packages/local-agent` already
  are, minus Electron — including the local-agent's existing loopback/CORS
  trust model and its ACP bridge. Ships in weeks; adds no new deployment
  target.
- **Full local stack.** `mako` stands up the API, its database (Mongo today,
  Postgres per §0's end-state), Inngest, and a kernel. True offline capability
  and a genuine self-host story, at the cost of a permanent second deployment
  target, a local migration story, and a support surface we have never carried.

**Proposed default: the thin shell**, with the full stack revisited only if
self-hosting turns out to be a sales requirement rather than a preference. The
thin shell also degrades honestly: everything works offline except data queries
and deploys, which is exactly the boundary §4.8(d) already drew for desktop
local-first sessions.

### 11.7 Gap analysis (2026-08-19)

The substrate is largely built. The local developer surface is close to zero.

| Capability                                                                                                                                       | State                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace = one git repo; apps are `apps/<slug>/` folders                                                                                        | ✅ §10 Block B, built                                                                                                                                                      |
| Every save is a commit; no dirty/uncommitted UI state                                                                                            | ✅ §10 Block A, built                                                                                                                                                      |
| Cloud storage (`mako-ai-cloud` org + GitHub App) and BYO repo linking                                                                            | ✅ built                                                                                                                                                                   |
| Real sandbox with shell, git, pnpm; `app2_*` tools over a real filesystem                                                                        | ✅ built                                                                                                                                                                   |
| Bindings as files (`bindings/*.sql` + `mako.json`)                                                                                               | ✅ Phase 1 built (§9)                                                                                                                                                      |
| MCP server — `POST /api/mcp`, OAuth 2.1 + scoped workspace API keys                                                                              | ✅ built                                                                                                                                                                   |
| Local Claude Code / Codex over ACP, auto-wired to Mako MCP with a generated system prompt (`packages/local-agent/src/acp/mako-system-append.ts`) | ✅ built — **the sleeper asset; §11.8 step 1 is mostly a retargeting of this**                                                                                             |
| Merge a branch into `main` (`POST /{id}/merge`)                                                                                                  | ✅ built                                                                                                                                                                   |
| **Deploy on merge to `main`**                                                                                                                    | ❌ `publishedSha` is exposed on reads and **never written**; no pipeline. Previews are token-gated sandbox builds, not durable deployments                                 |
| **Repo-resident agent instructions** (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`)                                                                     | ❌ `api/src/apps-v2/scaffold.ts` writes only `package.json`, `mako.json`, `index.html`, `vite.config.ts`, `tsconfig.json`. A fresh clone tells `claude` nothing about Mako |
| **Skills in the repo** (§10 Block D1)                                                                                                            | ❌ system skills live in the API image (`api/src/agent-skills/`)                                                                                                           |
| **`mako` CLI / npm package**                                                                                                                     | ❌ does not exist. The `mako-agent` bin in `packages/local-agent` is the local-database daemon + ACP bridge — a different product                                          |
| **App SDK for data access from a local checkout**                                                                                                | ❌ no `@mako/app-sdk` package exists, though §5 and §6 Phase 3 both assume one                                                                                             |
| Consoles in the repo (§10 Block D2)                                                                                                              | ❌ still Mongo `SavedConsole`                                                                                                                                              |
| Per-session branch state (§10 Block C)                                                                                                           | ❌ not started                                                                                                                                                             |
| **Human (builder) access to workspace repos**                                                                                                     | ❌ cloud repos are touched only by Mako's installation token — no human has any access. The builder tier of §11.5 is net-new: collaborator management or a git proxy, plus revocation wired to workspace membership |
| **Checkout scope (sparse-checkout) for clones and sandboxes**                                                                                      | ❌ does not exist anywhere. Personal `users/<userId>/` content is also unimplemented, so §11.10's owner-first layout + scoped checkout can be built correctly from the start rather than migrated                    |
| **A repo home for notebooks**                                                                                                                       | ❌ notebooks appear nowhere in this RFC; §10's layout is `apps/ consoles/ skills/ dbt/`. Path convention and the commit-outputs-or-strip question are both undecided (§11.11)                                         |
| **PR preview deploys**                                                                                                                              | ❌ deferred in §11.9 — but table stakes at Netlify/Vercel (§11.11), so the deferral is worth revisiting once deploy-on-merge exists                                                                                   |
| dbt in the repo (§10 Block D3)                                                                                                                   | ❌ last; own RFC section                                                                                                                                                   |

Net: **`git clone` works today; `claude` in that clone is Mako-blind; and a
merged PR deploys nothing.** Those are the three gaps between here and §11.3.

### 11.8 Revised sequencing

The vision splits into a cheap half and an expensive half, and the cheap half
delivers nearly all of §11.1. Do the cheap half first, and let real usage
decide whether the expensive half is wanted.

**Step 1 — make `git clone && claude` work, with no CLI at all.**
Scaffold `CLAUDE.md` + `.mcp.json` into the workspace repo and land §10 Block D1
(`skills/` in the repo). Generate the repo's `CLAUDE.md` from the same source as
`buildMakoSystemPromptAppend` so there is one place to maintain "how to be good
at Mako" rather than two that drift. Nothing else is required: the MCP server
already exposes the data tools and already authenticates.
_Acceptance test:_ clone the workspace repo on a laptop with no Mako tab open,
run `claude`, add a chart backed by real workspace data to an existing app,
commit, push — and see it in the web app. That single test proves §11.1 end to
end.

**Step 2 — deploy on merge to `main`.**
Write `publishedSha`, build from it, serve it durably. Without this, §11.4 is
aspirational and the monorepo model does not actually exist. PR preview deploys
remain deferred.

**Step 3 — minimal `@mako/cli`: `login` + `dev`.**
Auth (device flow or pasted API key) and a dev server that proxies bindings and
queries to the cloud execute API, so a local checkout renders with real data.
This is what makes local editing _useful_ rather than merely possible. Not the
full `mako` UI server yet — that is §11.6 and waits for the decision.

**Then** §10 Block D2 (consoles into the repo) and Block C (per-session branch
state), which together make the local checkout contain the _whole_ workspace
rather than only its apps.

**Only after that**, revisit `mako` as a local UI server (§11.6). By then we
will know from real usage whether people want the entire app locally or just
their editor plus a browser tab pointed at the cloud.

### 11.9 What this defers, and why

- **`mako agent` (the terminal harness, §4.8c) is deferred indefinitely.**
  §11.1's third argument says users already pay for a harness that is better
  than ours. Spending our tokens to build a competing one contradicts the
  reason we are doing this work at all. Revisit only if MCP-over-BYO-harness
  proves materially worse in practice.
- **PR preview deploys** — desirable, explicitly not a blocker for §11.3.
- **Full local stack** (§11.6) — pending evidence of demand.
- **Scheduled jobs from `mako.json`** (§4.9) — unchanged, still post-D2.

### 11.10 Signal, noise, and checkout scope (2026-08-19)

Access (§11.5) is not the only cost of putting everyone's content in one repo.
A builder who is fully *entitled* to read `users/jonas/` still does not want it
in their grep results — and neither does the agent, whose effectiveness is the
entire premise of §11.1's second argument. Confidentiality and signal-to-noise
are separate problems with, as it turns out, the same solution shape.

**Layout: owner-first, confirmed.** The repo keeps §10's shape — `apps/<slug>/`,
`consoles/`, `skills/`, `dbt/` at the root for workspace content; personal
content under `users/<userId>/apps/…`, `users/<userId>/consoles/…`. The
type-first alternative (`apps/workspace/`, `apps/users/joan/`,
`consoles/users/joan/`) was reconsidered on 2026-08-19 and rejected again, now
for a reason §10 did not state: **both access and noise are "exclude one
subtree" operations.** Owner-first makes that a single rule. Type-first needs
one rule per content type, the list grows with every type we add, and a
forgotten rule fails silently and in the unsafe direction — new personal
content leaks into the clone *and* into the agent's context. Type-first wins
only on uniform globbing (`apps/**/mako.json` finds every app in one pattern
instead of two), which is a cost paid once in code, against a risk paid
forever.

**Layout alone does not solve noise — checkout scope does.** No sparse-checkout
exists anywhere in the codebase today. Both consumers of a checkout want the
same default:

- **The builder's clone.** `mako clone` (or the CLI's first-run setup)
  configures sparse-checkout to workspace content plus the caller's own
  `users/<userId>/`. A plain `git clone` still gets everything — builders are
  entitled to it per §11.5 — with the narrowing documented rather than
  enforced.
- **The agent's sandbox.** Same scope, same mechanism. This is where the
  payoff lands: the agent's `grep`/`glob` hit signal instead of a dozen
  half-finished personal consoles.
- **`CLAUDE.md` states the scope**, so an agent that cannot see a path knows
  why and does not hunt for it or try to recreate it.

**Convergence with §11.5.** If the per-user-repo trigger fires, the workspace
repo becomes exactly `apps/ consoles/ skills/ dbt/` with no `users/` at all —
type-first by construction — and this question dissolves. Owner-first is the
interim that migrates there cleanly (`git subtree split users/<id>`); type-first
would have to scatter-gather across every type folder to reach the same place.
Owner-first is therefore both the better interim and the better stepping stone.

**Status:** cheap to get right now — `apps/<slug>` at the repo root is built
(`worktree.service.ts:83`), `users/<userId>/` is **not implemented at all**, and
sparse-checkout does not exist anywhere. Nothing to migrate; only to decide,
which this section does.

### 11.11 Prior art — and the two things it surfaces (2026-08-19)

**Netlify / Vercel — they dodge our hardest question.** Both are a deploy layer
bolted onto a repo GitHub already governs, via a GitHub App installation scoped
to selected repos. They never own the store, so they never answer "who may
clone" (GitHub's ACL, the customer's to manage and revoke), never bridge
platform identity to git identity (dashboard accounts and GitHub accounts are
simply different things), and have no concept of personal-content-inside-a-
shared-repo. Mako's cloud tier *is* the store, so it inherits all three — the
price of "instant start, no GitHub setup," which is a real advantage they do
not offer. What they *do* validate is most of §11.4: many projects in one repo
with a base directory each and build-skip so touching `apps/a` does not rebuild
`apps/b`; production branch → production deploy; and **PR previews as the
review surface, which is table stakes for both** — mild evidence against
leaving them deferred in §11.9. Secrets in the platform rather than the repo is
settled prior art for §7's open question. Their one repo-creating flow
(deploying a template) is the origin of §11.5 option (iii).

**dbt Cloud — our own precedent.** Repo is truth; the platform supplies the
IDE, scheduler, and credentials. §1.3 already cites the dbt module as proof the
model works for us; it remains the strongest precedent because we have operated
it.

**Retool, Hex, Appsmith — verified against their docs, 2026-08-19.** An earlier
draft of this section called these "a mirror, the pattern §8 rejected." That
under-credited them, and worse, it put the differentiator in the wrong place.
Corrected:

- **Retool Source Control** is genuinely git-native: feature branching across
  Apps, Modules, Resources, Workflows and the Query Library, with the flow
  branch-in-git → sync into Retool → edit → commits to the feature branch → PR
  → merge to main → Retool syncs from main. That is `main`-is-prod with PR
  gating, for real. Apps serialize to **ToolScript** (`.rsx`), a JSX-style
  markup that explicitly replaced an earlier YAML format for readability, plus
  autogenerated JSON dotfiles (`.defaults.json`, `.positions`). The decisive
  line: *"Retool recommends you not modify Toolscript files directly and only
  make changes when resolving merge conflicts"* — there is no linting or
  type-checking for `.rsx`. Reviewable, deliberately not authorable.
- **Hex Git export** is **one-way only** (Hex → git); Hex is explicitly the
  source of truth. YAML can be manually re-imported as a new project or a new
  version, but that is a manual round-trip, not a sync. Publishing creates a
  merge commit on the publish branch. Note for us: it is **incompatible with
  repositories using branch protection** — the repo must allow merging without
  review. (Hex's marketing blog describes a two-way, PR-gated model the docs do
  not support; check which one anyone citing it means.)
- **Appsmith** is open source, so the internals are public and worth reading:
  the **database stays authoritative** and the server keeps a local git repo
  mirroring it — `[web client] — [Appsmith server] — [remote]`, one server-side
  clone rather than per-user clones.

**The differentiator is not "we use git and they don't."** All three use git,
with branches, PRs, and main-is-production. It is **what the repo contains**:

- *Them:* a serialized representation of GUI-authored state (YAML, `.rsx` +
  JSON, JSON) — reviewable by design, explicitly not authorable. Hex will not
  take your edits back, Retool tells you not to make them, Appsmith's database
  remains the truth.
- *Us:* **actual source** — a real Vite/React app, real `.sql` files — with git
  as the only store. That is precisely what makes §11.3 possible: Claude Code
  works on a Mako repo because it is a React app, and cannot productively work
  on a `.rsx` file the vendor tells you not to edit.

**The collaboration trade, restated correctly.** An earlier draft claimed
multiplayer editing and git are in tension. Retool and Appsmith have both, so
that is wrong as stated. The tension is resolved by **whoever holds truth**:
database-authoritative buys real-time co-editing and git-as-export;
git-authoritative buys real source, branches and local checkouts, and costs
real-time co-editing. §10's one-branch-per-user-session model commits us to the
second — correct for code, an unremarked-on regression for anything
notebook-shaped, where side-by-side editing is the expectation. **A stated
trade, not a discovery during a customer call.**

**Two operational lessons worth stealing.**

- *Appsmith on performance:* early git operations were "simply too slow, which
  caused the Appsmith client to time out," leading to corruption. They
  recovered ~4x by skipping components unchanged since the last commit and
  moving non-user-facing metadata into separate ignorable files. Their still-
  unresolved problem — version upgrades churning metadata and polluting user
  commits — is a direct warning about `mako.json` and any generated file we
  commit. Our architecture already avoids the worst of this (the sandbox runs
  git, the API is stateless, commits are per-turn), but the metadata-churn
  lesson transfers intact.
- *Hex on branch protection:* their publish path cannot coexist with protected
  branches. §11.5 leans on branch protection as the deploy gate, so our publish
  must go **through** a PR/merge that respects protection, never around it. If
  we ever find ourselves needing an unprotected branch to publish, we have
  rebuilt Hex's constraint.
- *All three on secrets:* configuration in committed files, encrypted secrets
  only in the platform database, never in the repo. That is consensus, and it
  settles §7's open question.

**Gap this surfaced: notebooks have no repo home.** §10's layout is `apps/`,
`consoles/`, `skills/`, `dbt/`. Notebooks are absent from this RFC entirely,
despite `api/src/notebooks/`, the kernel providers, and substantial ongoing
work. They are the content type most like Hex's, the one where the multiplayer
trade bites hardest, and the one with the most open sub-questions once they
land in git — path convention, and whether outputs are committed or stripped
(committed outputs make diffs unreadable and repos heavy; stripped outputs make
a clone non-reproducible without a kernel run). Needs its own decision under
§10 Block D alongside `consoles/`.

**Sources (fetched 2026-08-19).**
[Hex Git export](https://learn.hex.tech/docs/explore-data/projects/git-export) ·
[Hex import/export](https://learn.hex.tech/docs/explore-data/projects/import-export) ·
[Hex GitHub sync (blog)](https://hex.tech/blog/github-sync/) ·
[Retool Source Control](https://docs.retool.com/source-control/) ·
[Retool ToolScript](https://docs.retool.com/source-control/concepts/toolscript) ·
[Retool git branching (blog)](https://retool.com/blog/git-branching-with-source-control) ·
[Appsmith git internals](https://www.appsmith.com/blog/appsmith-git-internal-tools-2)

---

## 12. One substrate: E2B everywhere (decided 2026-08-21)

> Supersedes §4.5's "E2B for production; a flag-gated local subprocess provider
> for dev VMs", the local half of §4.8(d), and §11.6's open question. §11.3's
> local-first workflow is unchanged in intent but corrected in mechanism below.

### 12.1 Three different things get called "development"

The confusion this section removes is that one word covered three unrelated
activities, and a substrate choice was made for the wrong one:

1. **Developing Mako** — us, working on this codebase.
2. **Developing workspace applications on app.mako.ai** — what customers do
   today.
3. **Developing workspace applications locally** — what technical customers
   will do once §11 lands.

### 12.2 All three point at the same answer

**(1) Developing Mako runs on E2B.** There is no value in a Mako developer
exercising a substrate that no user will ever run, and there is real cost: you
ship code paths you never executed, and you carry a second implementation
forever. Every developer has an E2B key; that is a normal cost of working here,
like having a database URL.

This is not a theoretical concern. The nested-`node_modules` sync bug — an app
that could not build at all, and 13-27 seconds of latency on every shell
command — survived from §10 Block B until 2026-08-20 **because the local
provider has no host↔sandbox sync at all.** The bug was structurally invisible
on the substrate Mako developers used and immediate on the one users run. The
local provider did not merely fail to catch it; it is the reason nobody did.

**(2) Customer app development on app.mako.ai runs on E2B.** Non-negotiable and
already settled by N1: user code never executes in the API process. Beyond
isolation, an unsandboxed shell lets a tenant exhaust the API host — CPU, disk,
memory — for everyone.

**(3) Local customer development does not use a Mako sandbox at all.** This is
the correction to §4.8(d), which imagined the desktop app holding a managed
checkout and dispatching the agent's file/bash tools to a "local executor"
behind the provider seam — Mako still executing on the user's behalf, just
pointed at their laptop.

The real shape is simpler. The user has **the workspace repo** checked out. A
`mako` executable supplies what only Mako can: data-source proxies,
authentication, and the API surface. The user — or Claude Code — then runs
`vite dev`, `npm test`, anything, **directly, as themselves**. Mako is not in
the execution path, there is no sandbox abstraction, and **the user never has
Mako itself checked out and never needs to.**

So the "local executor" has no third case to serve either.

### 12.3 Consequence: the local sandbox provider is deleted

It serves none of the three. It was the bootstrap substrate from the first
apps-v2 commit, written before the E2B provider existed and never removed —
its own test was never even registered in the test script, so it has never run
in CI.

Removed: `sandbox/local-provider.ts`, `dev-server.service.ts`,
`dev-preview-ws-proxy.ts`, the `devPreviewAvailable` capability probe and the
toolbar gating built on it, and the `APPS_V2_SANDBOX_PROVIDER` knob.
`sandbox/provider.ts` stays as the seam — §7 wants Fly/Modal reachable as a
vendor fallback — with one implementation behind it.

### 12.4 Live preview moves into the sandbox, where it always belonged

The live `vite dev` preview existed **only** on the local provider, because it
spawned vite as a child process of the API host. That is exactly what N1
forbids, so it could never ship; the throwaway substrate had the better
experience and the real one had none. That inversion is what produced a
primary-styled toolbar button that could not work in any deployed environment.

The correct implementation, which works everywhere and needs no capability
flag: **vite runs inside the sandbox**, bound to `0.0.0.0`; E2B's
`sandbox.getHost(port)` yields the per-sandbox public URL; Mako iframes that
URL directly. No proxy, no WebSocket relay of our own (HMR rides the same
origin), and no tenant process on the API host.

Notes carried into implementation: the sandbox's idle timeout must be held open
while a dev server is running; vite needs its allowed-hosts check satisfied for
the `*.e2b.app` host; and the public URL is unguessable but unauthenticated,
which is the same exposure the existing token-gated static preview already
accepts. §4.7's end state (separate PSL-registered domain, capability tokens)
still stands for *published* apps — this is the dev-preview tier only.

---

## 13. The app lifecycle: view, edit, publish (2026-08-21)

> The gap this closes was found by its own author: *"even though I built this,
> I don't understand the UX and I don't know how this works."* That is not a
> labelling problem. Apps v2 today is an IDE with two developer preview modes,
> and an app has no existence outside it.

### 13.1 What actually exists today

Stated plainly, because the confusion comes from looking for a product half
that was never built:

- **There is no publish and no deploy.** `publishedSha` is a schema field,
  returned by one endpoint, and **never written by anything**.
- **There is no viewer.** No public-share route, no read-only mode. Opening an
  app means opening the IDE.
- **The built bundle is throwaway.** `Build & preview` runs `npm run build` in
  the sandbox and serves the resulting `dist/` behind a token that expires in
  **30 minutes**, held in process memory. Restart the API and it is gone.
- **Even browsing calls `ensureWorktree`**, so merely looking at an app engages
  the sandbox machinery.
- **Data is the exception, and is further along than the rest.** Bindings
  already materialize through v1's read-only-enforced pipeline into the shared
  artifact store — GCS in deployed environments — keyed
  `apps-v2/<projectId>/<name>.parquet`. That half is durable and works. It is
  only *served* through the same ephemeral preview token, at
  `__data/<name>.parquet`.

So the missing piece is narrower than "publishing": the warehouse→parquet→
bucket path exists. What does not exist is a durable, authorized way to serve
an app **and** its data to someone who is not editing it.

### 13.2 Three states, one primary action each

| State | What the user sees | Primary action |
|---|---|---|
| **Published** (default for everyone) | the live app built from `main` — **no sandbox involved** | **Edit** |
| **Editing** (on a branch, dev session live) | live `vite dev` with HMR | **Publish** (+ *Stop session*) |
| **Never published** | empty state explaining what an app is | **Publish** |

Consequences worth stating:

- **Opening an app must never start a sandbox.** A hundred viewers must not
  mean a hundred microVMs. This is simultaneously the cost story, the latency
  story, and what makes "first click shows the app instantly" possible.
- **Edit is a state transition, not a mode toggle**: branch off `main`, start a
  dev session, and say which branch you are on. The agent does this on the
  user's behalf most of the time.
- **`Build & preview` largely stops being user-facing.** It is what Publish
  does internally, plus a "does this still build" check for the agent. Keeping
  it in the toolbar as a peer of the dev session is what made two developer
  preview modes look like a product decision.
- **The dev-session button must render its state.** It currently changes only
  its variant while still reading "Start dev session" with a session already
  running.

### 13.3 Publish

Merge the branch into `main`, build from `main`, store the output as an
**immutable, addressable** deployment, and repoint the app's URL at it. This is
§11.4's `main`-is-production made concrete, and it is the orthodox shape
(§11.11: it is what Netlify and Vercel do).

Immutability is what buys rollback: reverting is repointing, not rebuilding,
and every deployment keeps a stable URL that can be linked to.

### 13.4 Open questions this raises

1. **Serving data to a published app.** The artifacts are already durable; the
   serving path is not. A published app needs `__data/<name>.parquet` behind
   Mako's ACLs rather than a 30-minute token — and the current handler sets
   `Access-Control-Allow-Origin: *`, which is safe only *because* the token is
   the credential. This is §4.7's capability-token design and it is the hard
   part of publishing, harder than the build.
2. **Freshness.** A published bundle is static; its data is not. Something must
   refresh bindings on a schedule (§9's Block 4) and publish must therefore
   deploy *bundle + binding schedule*, not just a bundle.
3. **A failed build on `main`.** Production must keep serving the last good
   deployment and someone must be told. This argues for building the PR before
   the merge — the per-PR previews §11.11 found to be table stakes elsewhere.
4. **Rollback UX.** One click, not a git operation.
5. **Concurrent editors.** Two people clicking Edit get two branches, which is
   correct; the UI has to show "you are on `chat/abc`, 2 others are editing".
6. **Static-only.** `vite build` → `dist` means no server code, no API routes,
   no runtime secrets. Whether that is the permanent boundary is a product
   decision, not an implementation detail.

### 13.6 An app is a folder, not a row (decided 2026-08-21)

Answers §10.1's open question — *"whether `AppProjectV2` dies entirely or stays
as an id-stable cache"* — with: it dies. An app is `apps/<name>/` containing a
`mako.json`. The folder name is the identity, the manifest is the metadata, and
git history is the provenance. Listing apps means reading the repo, so a folder
pushed from a local checkout appears with no registration step of any kind —
which is what §12.2(3) requires of local development.

Uniqueness needs no mechanism: two apps cannot occupy `apps/<name>` at once.

Mongo keeps only what cannot live in a repo the customer can clone:

- **who may see it** — authorization must not be editable by anyone who can
  push, or a builder could grant themselves access by committing a file
  (§11.5 keeps Mako's API as the ACL plane);
- **the deployed sha**, which is server state about what is live, not
  something the source declares about itself;
- **the share token and its bcrypt password hash**, which must never be
  committed.

A row therefore appears only when someone restricts, publishes or shares an
app — never merely to open one. An app with no row is workspace-visible, the
same as any other file in the repo. Ids for such apps are derived from
(workspace, folder) so that deployment prefixes, binding artifacts and sandbox
affinity stay stable if a row is written later; apps predating this keep their
original ids, which already key their artifacts.

### 13.7 You do not edit production (decided 2026-08-21)

Every save auto-commits (§10 Block A), and every actor's worktree defaulted to
`main` — so a single bad keystroke broke the deployed branch for everyone, with
no publish involved. This was demonstrated by accident while testing: saving
one file with a type error put it straight on `main`, and the next publish by
anyone would have failed on it.

In a checkout this is so automatic it is invisible: you branch, you work, you
merge. Mako now does the same. Each person edits `user/<userId>`, forked from
`main`; conversations keep `chat/<chatId>`; only publishing reads `main`, and
only merging writes it. Sessions created before this are moved off `main`
automatically, carrying their work, because the WIP ref is keyed by worktree
rather than by branch.

Publish therefore means *ship my work*: it merges the caller's own branch by
default. Publishing with no edits at all is not an error — it deploys what
`main` already holds; telling someone who has changed nothing that their work
"could not be merged" would simply be false.

Combined with §13.3's build-before-merge, `main` is now protected from both
directions: bad edits cannot reach it, and a bad build cannot land on it.

### 13.8 Pushing to `main` is what deploys (2026-08-21)

If `main` is production, then putting a commit on `main` should be the act that
makes something live — whether that came from `git push` in a checkout, a merge
on GitHub, or the Publish button. A button that is the *only* way to ship
breaks §11.3 outright: someone working from a local folder would have to open a
browser to release.

**GitHub is where every path converges.** A local clone pushes straight there,
and Mako mirror-pushes its own commits there too, so one `push` webhook covers
all of them. The webhook plumbing already existed for dbt (HMAC verification,
event routing, detached work); this adds an Apps v2 branch to it.

On a push to the default branch of a workspace repo: fetch the commit into the
local bare cache (it landed on GitHub, not here), diff the range for touched
`apps/<slug>/` folders, and build and deploy each one. A failed build leaves
the previous deployment serving; `main` is NOT reverted, because it already
moved and rewriting a branch someone pushed to would be far worse than briefly
serving an older build. One app failing does not stop the others.

So `publishedSha` stops being a pointer somebody sets and becomes what it
always meant: **the last commit of `main` that built**. Publish becomes a
convenience for people already in the browser, not the mechanism.

### 13.5 Order

Deliberately smallest-first, because each step is independently useful and the
early ones stop the current UI from actively misleading:

1. Fix the dev-session button to render its state (stopgap; it lies today).
2. Publish: merge → build from `main` → immutable artifact → write
   `publishedSha` → repoint. Bundle only.
3. Viewer: opening an app serves the published bundle, **sandbox-free**, with
   Edit as the way in.
4. Authorized data path for published apps (13.4.1) — the hard one.
5. Scheduled binding refresh (13.4.2), then rollback (13.4.4).

## 14. State of play and roadmap (2026-08-26)

What exists now, what was decided in the 2026-08-26 planning round, and the
order we intend to work in. Earlier sections stay as the record of how we
got here; where this section disagrees with one of them, this one wins.

### 14.1 What shipped since §13

- **The sandbox is a real machine.** Interactive terminals are `dtach` +
  `script` sessions that survive reloads, reconnect after the box dies, and
  close on `exit`. The dev server is a session like any other (`dev-<slug>`),
  attachable from the workbench, stoppable with Ctrl-C, and killed by
  **Exit dev mode**. One box per (workspace, user), found by an E2B metadata
  tag — no database id in the identity path. Settings › Sandbox shows the
  box, its sessions and load, and recycles it.
- **Discovery over bookkeeping.** Branch, dirty tree, running dev servers and
  the box itself are all discovered from the machine; the UI never trusts a
  client-side or database memory of them. A wiped browser and a fresh login
  reconstruct everything.
- **Box events.** A small agent inside every box (installed by `ensureBox`,
  under dtach, version-stamped) pushes a snapshot of branch/HEAD/ahead/dirty
  files/serving ports on change and on a 30s heartbeat; the dev-server
  launcher and git hooks push instantly. The API merges these into a
  per-box snapshot in Redis (memory without `REDIS_URL`) with a 90s TTL and
  fans them out over the workspace realtime channel; the hot reads (`status`,
  `dev-servers`, `dev-preview/status`) answer from the snapshot when warm.
  Measured: state changes reach the UI in 250ms–2s instead of 15–30s; warm
  reads ~200ms instead of 1–1.5s. The snapshot is a cache with an expiry,
  never a source of truth: a box that stops asserting its state stops being
  believed, and reads fall back to discovery.
- **Source Control like VS Code.** Staged/unstaged groups, inline stage /
  unstage / discard / open-file, group actions, smart commit (staged only
  when anything is staged), diffs in Monaco tabs (Working Tree = index →
  working copy, Index = HEAD → index), branch menu with checkout, create and
  merge-into-main, an `↑N` unpushed badge, the GitHub link, and a red dot on
  the rail when the tree is dirty. Git is only in this panel; the Apps
  explorer is purely the tree.
- **Self-healing.** Stale git origins (tunnel restarts) reconfigure and retry
  on push/pull; a box that died under a shell reconnects the tab onto its
  replacement; a dead box's snapshot is forgotten the moment a replacement
  is cloned; a server started from a shell is detected (port scan +
  `package.json`) and adopted, or replaced if it rejects the preview host.
- **Verified by adversarial rounds** (kill the box via the E2B API, recycle,
  Redis outage, agent kill, API restart, 300 untracked files, quoted
  filenames, path traversal, branch flapping, delete under an open diff).
  Bugs found were fixed as they were found; this should become a nightly
  job (14.4).

### 14.2 Decisions from the planning round

- **Merge behind the existing per-workspace flag, soon.** The flag already
  hides the rail entry; make it settable by super-admins in Settings and
  merge. The v1 → v2 migration script is run over copies of every real
  workspace first, and v1 stays read-only for a while after a workspace
  switches.
- **Everything moves into the monorepo, in this order:** consoles (SQL text
  with revisions → files), notebooks (`.ipynb`; the kernel keeps running
  where it runs, only storage moves), then dbt (it has its own git
  integration today — this is unification, not migration). Flow
  *definitions* follow, with a push reaction that re-registers Inngest
  functions the way a push to `apps/` deploys; run state stays out of git.
  Dashboards are deferred: apps have replaced them in practice, so they
  move only if a generic entity-as-folder layer makes it free.
- **No GitHub requirement.** The bare repo plus cloud mirror is the source
  of truth and works with no GitHub at all; GitHub stays an optional mirror
  and escape hatch. Blocking a workspace without one would hurt exactly the
  users the git model exists to hide git from.
- **Repository health instead of "corrupted → block".** A Repository section
  next to Settings › Sandbox: `git fsck`, size and GC, mirror and GitHub
  sync lag, last push, and one-click repair from the mirror. Only the
  mutating paths are blocked, and only while a repair runs.
- **The agent gets rewritten for the sandbox.** Collapse the `App2 *` tool
  family into bash + read + edit; move git/vite/dbt know-how into skills;
  feed it the pushed box state; commit only what it touched (today's
  end-of-turn `git add -A` sweeps unrelated files); land its changes as a
  staged group the user reviews with the diff view; give it its own `git
  worktree` per chat so it and the user stop treading on each other.
- **Coding agents in the box.** Two tracks: ship the CLIs (Claude Code,
  Codex, OpenCode, Pi) in the template so people use their own accounts in
  the terminal — nearly free; then drive an agent running in the box over
  ACP (the types already exist) from Mako's chat, so Mako is a front-end
  for any agent and the user's own subscription pays for tokens.

### 14.3 Also on the list

- **Branch previews.** Publish already yields immutable deployments keyed by
  sha; extend to any branch → shareable preview URLs, so a feature branch
  is reviewable without a sandbox and "merge to main" is the release.
- **Pre-warmed boxes.** One spare box per template, adopted on first use, so
  a first terminal opens in under a second and a recycle is usable in five.
- **Secrets and env for apps**, injected from Secret Manager into the dev
  server and the deployment, never committed.
- **Git polish** the diff view set up: gutter change bars, hunk staging and
  revert, file timeline, compare-with-main, a real conflict view.
- **Horizontal scaling check** before the first multi-instance deploy: box
  state and pub/sub are Redis-ready, but the terminal relay keeps ptys in
  per-instance memory, so websockets need sticky sessions or a relay hop.

### 14.4 Order

1. Merge behind the flag, with the migration script iterated on real
   workspaces first.
2. Consoles → notebooks → dbt into the monorepo.
3. Agent rewrite: tool collapse, commit-what-you-touched, review mode,
   worktree isolation.
4. Repository health and repair; branch previews; secrets.
5. Coding agents: terminal track immediately, ACP track as the next product
   bet.
6. Nightly chaos job replaying the adversarial rounds against a staging
   workspace.

Flows and dashboards after that, if the entity-as-folder layer makes them
cheap.

## §13.3.1 Publish builds `main`, not a dangling candidate (RFC, 2026-08-27)

**Problem.** Publish computed a *merge commit that no branch points to* (so
`main` only moved after a green build), parked it as `refs/mako/publish-candidate`
— a ref namespace deliberately **hidden from the GitHub mirror** — and asked the
sandbox to `git fetch origin <sha>`. The one object the build depends on was the
one object that was never durable anywhere. On a serverless host (per-instance
ephemeral repo, a cache of the mirror) the sandbox's fetch can hit an instance
that never saw that commit → `upload-pack: not our ref`. It only ever worked on a
single persistent instance (localhost), which is why it shipped.

**Decision.** Reframe publish as **ship `main`**, matching the standing decision
that "merging deploys" (decision log, 2026-08-19):

1. Merge the caller's branch into `main` and **advance `main` to the merge
   NOW** (compare-and-swap against the main the publish started from), then
   **mirror-push** it. The build target is a real, durable, mirrored ref.
2. Check that ref out in the sandbox and build it. On success, upload the
   deployment and move `publishedSha`.

**Source and production are now decoupled.** `main` is the source of truth (may
or may not build, like any branch). `publishedSha` is production and moves *only*
on a successful build. So a failed build leaves `main` ahead of what is deployed
and the **live app untouched** — never "poisoned", just un-deployed. Rollback is
still repointing `publishedSha`. This deletes the dangling-candidate machinery
(the class of "not our ref" bug goes with it) and unifies the button with
`deploy-on-push` (both build `main`; the second is deduped by `deploymentExists`).

**Optional PR gate.** A workspace that wants review flips on "require PR": Publish
opens a GitHub PR instead of merging directly, and merging it triggers the same
`deploy-on-push`. Default stays direct-merge — forcing a human PR merge on every
app tweak is the wrong friction when everyone is building apps.

**Still required for serverless foolproofness (NOT yet done).** Building `main`
makes the target durable *in the mirror*, so a **cold** instance restores it. An
**already-warm but stale** instance still can't serve a just-pushed `main`, and a
naive "reconcile on read" is unsafe (a *forced* mirror fetch can revert a local
commit that hasn't been mirror-pushed yet — data loss). The durable fix is to
make the bare repo a **store, not a per-instance cache**: a shared/persistent
volume for `APPS_V2_GIT_ROOT`, or `min-instances=1` per environment, or an
*additive* fetch-by-missing-sha at the git endpoint (never a forced ref update).
This is an infra decision to make before high-concurrency use.
