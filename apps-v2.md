# Apps v2: workspace Git, isolated development, and deployment

- **Status:** Apps v2 is always available as an independent product surface.
- **Pilot storage:** when `APPS_V2_GIT_ROOT` is unset, the API stores Git data
  under `/tmp/mako-apps-v2-git`. Cloud Run filesystem data can disappear after
  a deploy, restart, reschedule, or instance replacement. This is acceptable
  for pilot testing and is not production durability.
- **Current implementation:** Git-native projects, private worktrees, secure
  agent tools, session-only routes, and E2B execution exist, but each app still
  receives a separate repository. That repository topology must be refactored
  before a durable rollout.
- **Target architecture:** one durable Git repository per workspace, with
  top-level source folders named exactly `consoles/`, `dbt/`, and `apps/`.
- **Migration:** there is no Apps v1 migration, source import, or dual write.
  Apps v1 and Apps v2 remain independent until a separate retirement project.
- **Last updated:** 2026-07-12

## Target and pilot are different

This document describes the target architecture. The current pilot proves the
Git, branch, worktree, sandbox, ACL, and agent workflows while accepting
temporary Cloud Run storage and the existing per-app repository model.

The pilot must not be described as durable:

- the default Git root is ephemeral in every environment, including production
  and Cloud Run;
- setting an absolute `APPS_V2_GIT_ROOT` marks storage as `configured`, but the
  operator is still responsible for durability, backups, and recovery;
- the status API reports `storageDurability: "ephemeral" | "configured"`;
- the UI shows an ephemeral-storage warning without hiding or disabling Apps
  v2; and
- PR previews are pinned to one Cloud Run instance and use session affinity;
  production uses best-effort session affinity but can still route to another
  instance; and
- pilot data can disappear or become temporarily unavailable after scaling,
  routing, deploys, or process restarts.

Before durable rollout, the current per-app repositories must be replaced with
the workspace repository described below. Pilot app repositories are disposable
test data and are not migrated or dual-written into the target repository.

## Product boundaries

Apps v1 and Apps v2 are independent:

- they have separate rail icons, routes, stores, collections, tools, URLs, and
  renderers;
- Apps v2 uses session-authenticated, workspace-scoped routes and rejects
  workspace API keys;
- every Apps v2 read and mutation applies workspace membership and resource ACL
  checks;
- Apps v2 never reads or mutates an Apps v1 `MakoApp` document;
- Apps v1 continues to use its existing Mongo-backed source and CDN renderer;
  and
- retiring Apps v1 requires an explicit later project.

Always-on availability does not weaken security. Sandbox execution remains
independently conditional on provider configuration, and GitHub delivery remains
conditional on its own feature flag and credentials.

## Target source architecture

### Git is the durable source

Git is the source of truth for user-authored workspace source. MongoDB stores
control-plane metadata such as workspace and resource ACLs, repository identity,
branch/worktree projections, sandbox leases, deployment records, and audit
events. It does not become a second source store.

The durable system must provide:

- content-addressed Git objects and refs;
- atomic compare-and-swap ref updates;
- repository quotas, garbage collection, backups, and restore procedures;
- hidden service refs for recoverable uncommitted state when needed;
- encrypted storage and audit events; and
- standard clone, fetch, and push through short-lived authorization.

Sandboxes and Cloud Run filesystems are replaceable compute and cache. Neither is
the only durable copy of acknowledged source.

### One repository per workspace

Each workspace has exactly one Mako-managed source repository. Its top-level
source folders are exactly:

```text
.
├── consoles/
├── dbt/
└── apps/
```

Resource source lives below those roots. For example:

```text
apps/<app-id>/
consoles/<console-id>.sql
dbt/<project-id>/
```

An app keeps its normal project files under its folder, including
`package.json`, a checked-in lockfile, `src/`, `public/`, `vite.config.ts`, and
`.mako/app.yaml`.

The workspace repository gives the in-product agent and local coding tools
workspace-wide source context. This enables cross-module search, coordinated
refactors, and changes spanning consoles, dbt, and apps in one branch and
commit history.

### Visibility tradeoff for external clones

API reads remain resource-ACL filtered. Direct Git clone is different: Git
repository access is a repository-wide visibility boundary, and sparse checkout
or a subdirectory is not an authorization boundary. Anyone authorized to clone
the workspace repository can potentially read all reachable workspace source
objects.

Therefore external clone requires explicit workspace-wide source visibility and
must be limited to principals allowed to see that scope. App-level ACLs still
govern Mako API, preview, deployment, and runtime operations, but they cannot
hide reachable Git objects from an authorized full-repository clone. The UI and
authorization flow must state this tradeoff before issuing clone credentials.

## Explorer and editing APIs

The left explorers for Consoles, dbt, and App Projects list and read source
through workspace-scoped API calls backed by Git. They never read a sandbox
filesystem directly.

The API:

- resolves the authorized workspace repository and resource subtree;
- applies workspace membership and resource ACLs before repository access;
- canonicalizes POSIX-relative paths;
- rejects absolute paths, `..`, NULs, `.git` mutation, symlinks, special files,
  case collisions, and paths outside the authorized subtree;
- enforces per-file, file-count, request, worktree, and repository quotas;
- uses revision, expected-object, and lease compare-and-swap values for writes;
  and
- emits realtime invalidations after successful updates so clients refetch from
  the API.

Consoles, dbt, and Apps may present domain-specific APIs and projections, but
all source reads and writes converge on the same workspace Git authority.

## Conversations, branches, and sandbox flow

### One workspace branch per conversation

Each new conversation creates or reuses one workspace branch:

```text
mako/chat/<chat-id>
```

The branch belongs to the workspace conversation, not to an individual app.
Every Apps v2 tool invocation in that conversation uses the same branch, so a
single turn can inspect and refactor files across `consoles/`, `dbt/`, and
`apps/`.

Retries and continuation segments reuse the same conversation branch. A durable
outer-turn identity and fenced lease prevent an older request or sandbox from
overwriting a newer turn.

### Local sandbox checkout

The trusted controller creates or resumes an isolated sandbox and then:

1. clones the authorized workspace repository into sandbox-local storage, or
   fetches it when a checkout already exists;
2. checks out and pulls the conversation branch;
3. applies any authorized recoverable WIP state;
4. lets tools read, edit, install, test, and build against that local checkout;
5. captures eligible source changes while excluding secrets and caches; and
6. at outer turn end, commits the complete eligible workspace change set once
   and pushes the conversation branch through the trusted Git controller.

The sandbox works locally during the turn. It receives no GitHub credential,
Mako service credential, cloud IAM credential, database credential, or broad
workspace token. Pull and push are controller-mediated and authorized again.

Explicit checkpoint commits may exist, but normal turn completion produces one
outer-turn commit. Aborted turns with eligible acknowledged changes are also
committed and labeled as aborted so work is not silently stranded. A clean turn
is a no-op.

### Recovery and concurrency

The control plane tracks conversation ownership, branch head, local checkout
revision, lease epoch, and finalization state. Mutations fail closed when the
turn owner, expected ref, WIP object, or lease no longer matches.

If a sandbox disappears, a replacement clones the repository, checks out the
conversation branch, restores authorized WIP if present, installs dependencies,
and resumes. Git remains the durable source; dependency stores, `node_modules`,
build output, and sandbox snapshots are reconstructible caches.

Promotion to the workspace default branch uses a committed-head-only
compare-and-swap merge. It never includes private WIP implicitly and never
overwrites a moved ref.

## Agent behavior

The App expertise mode supports both product generations, but the current App
tab or visible rail selects the tool family:

- `app-v2` and `app-v2-file` tabs, or the App Projects explorer, expose only
  `app2_*` tools;
- Apps v1 tabs or the Apps explorer expose only Apps v1 `app_*` tools;
- Apps v2 tools require browser-session authentication and a real user
  principal; and
- API-key chats never receive Apps v2 tools.

Apps v2 file and Git tools remain available when the sandbox provider is off.
Shell and package tools report provider unavailability without disabling source
access.

At outer turn end, the finalizer commits and pushes touched workspace changes on
the conversation branch. Scheduled maintenance retries stale provisioning and
pending finalization regardless of product availability. Optional GitHub
delivery runs only when the independent GitHub push flag and credentials allow
it.

## Sandbox and supply-chain security

Tenant commands and package lifecycle scripts run only in hardware-isolated
compute, never in the API or Cloud Run process. Each sandbox has:

- a workspace/conversation identity and fenced lease;
- an unprivileged user with no sudo or Linux capabilities;
- no host filesystem mount or cloud metadata access;
- no service, database, Git push, deploy, or OAuth refresh credentials;
- CPU, memory, disk, process, command-duration, and output limits;
- deny-by-default network policy with phase-specific registry access; and
- authenticated preview exposure on a separate registrable domain.

The custom E2B template remains optional and independently configured with
`APPS_V2_SANDBOX_PROVIDER=e2b`, `E2B_API_KEY`, `E2B_TEMPLATE_ID`, and
`APPS_V2_E2B_USER`. Provider absence disables compute only, not Apps v2 routes,
Git access, or UI visibility.

Ignored caches, `.env*`, secrets, sockets, devices, and over-limit files are not
eligible source. Finite commands report excluded paths. Repository and path
validation runs again outside the tenant process before objects or refs are
accepted.

## GitHub and external tools

The Mako-managed workspace repository is canonical. Optional GitHub push keeps
its independent `APPS_V2_GITHUB_PUSH_ENABLED` gate, GitHub App credentials,
binding ACL checks, validated owner/repository/ref/subdirectory fields, and
controller-mediated delivery.

External IDEs and coding agents use an ordinary clone after workspace-wide
source visibility is authorized. A future Mako CLI and OAuth-protected MCP
server can provide schema discovery, governed read-only data access, preview,
and deploy operations without placing database credentials in source or browser
bundles.

## Build, preview, and deployment target

Development runs from the conversation branch checkout in an isolated sandbox.
Publishing resolves an immutable commit, validates manifests and mappings,
builds in a fresh isolated environment with a frozen lockfile, and uploads a
bounded content-addressed artifact through the trusted controller.

Deployments:

- identify the exact workspace commit and app subdirectory;
- never deploy a moving branch or uncommitted sandbox state;
- use immutable assets and a stable deployment pointer;
- run on a registrable domain isolated from Mako control-plane cookies and
  origins; and
- preserve the previous deployment when a build or upload fails.

Database access remains capability-based and server-side. App source receives
query results through versioned bindings, never connection credentials.

## Durable rollout prerequisites

Always-on pilot availability is not approval for durable production use. Before
claiming production durability:

1. replace per-app repositories with one repository per workspace;
2. implement the exact `consoles/`, `dbt/`, and `apps/` root layout;
3. move all three left explorers to Git-backed API reads and writes;
4. prove conversation-wide branches and cross-module turn finalization;
5. deploy configured durable Git storage with backups and restore testing;
6. enforce repository-wide clone authorization and communicate its visibility
   tradeoff;
7. validate quotas, garbage collection, audit, and disaster recovery; and
8. retain Apps v1 independence with no app migration or dual write.

Pilot data is disposable. No migration path from current per-app pilot
repositories is promised.
