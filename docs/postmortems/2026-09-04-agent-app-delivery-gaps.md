# Post-mortem: Agent app delivery required browser and local fallbacks

- Date: 2026-09-04
- Status: P0 remediated; P1/P2 follow-ups planned
- Area: Apps, workspace repositories, data bindings, dbt tooling
- Severity: Reliability and developer-experience incident; no production outage

## Executive summary

Building and publishing the INTL Sales Dashboard exposed gaps between Mako's
agent-facing control plane and reliable end-to-end app delivery. The app
could be created and pushed correctly, but different API instances temporarily
disagreed about whether it existed; a running user sandbox could remain behind
the repository's default branch; and an app could be marked published before
its required parquet bindings existed. The result was a successful publish
whose first public load failed with `Data failed to load: Failed to fetch`.

The work was completed, but only after using the browser for control-plane
operations and local `gcloud`/dbt tooling for warehouse work. Those fallbacks
made the workflow slower, harder to reproduce, and less safe than a single
authenticated API/CLI path. Visual browser verification was useful and should
remain part of the workflow; browser automation should not be required for app
discovery, deployment, materialization, or dbt execution.

No customer data was lost. A newly published app was briefly incomplete until
its bindings were materialized. Existing Apps deployments were unaffected.

## What happened

The agent created a new dashboard in the workspace repository and iterated on
it using the FR Sales Dashboard as a reference. During the build and release:

1. The repository contained the new app, and `app_list_apps` could see it, but
   `app_open_app`, `app_publish`, and `app_publish_status` intermittently
   returned "not found" until another refresh caused the serving instance to
   fetch the latest repository state.
2. The user's already-running sandbox preferred its local checkout, which was
   behind the default branch. `app_materialize` consequently reported that a
   binding was missing even though its SQL file had been pushed.
3. The code build and publish pointer update succeeded before the required
   parquet artifact was present. The public app shell loaded, but its data
   request failed.
4. First-time dev startup exceeded the tool request window while dependencies
   installed and Vite booted. The operation ultimately completed, but the
   caller received a timeout instead of a durable operation handle.
5. Warehouse-mutating dbt tools existed, but the active MCP credential did not
   include `warehouse:write`. The production Transform UI also exposed the
   target while leaving Run disabled, so local Application Default Credentials
   and a temporary dbt environment were used instead.

## Impact

- The dashboard took roughly an additional hour to deliver and verify.
- The agent workflow consumed approximately 565k tokens, much of it on browser
  state inspection, retries, and reconstructing control-plane state.
- A published URL temporarily served a frontend whose required data artifact
  was absent.
- The operator had to move between MCP, the browser, a local checkout, and
  local cloud credentials, reducing auditability and reproducibility.
- The ambiguous dbt capability failure made an authorization problem look like
  a missing platform feature.

## Root causes

### 1. Repository freshness was not a tool-level invariant

An app is identified by its `apps/<slug>` folder. `app_list_apps` and the
folder fallback in project resolution read the API instance's local bare mirror
without first fetching the workspace's cloud repository. Instance-local cache
state therefore leaked into user-visible behavior: two valid requests could
disagree about whether the same pushed app existed.

Folder-only apps also have no database row until a stateful action such as
publish. The API publish route persisted that row, but the shared deploy worker
did not enforce the same invariant; an automatic deploy could therefore call
`setPublishedSha` against a row that did not exist.

### 2. A running actor sandbox could shadow newer repository state

Read and materialization paths intentionally reuse a user's live sandbox, but
not every entry point caught that checkout up before resolving files. A stale
but healthy sandbox was treated as authoritative and hid newly pushed binding
files.

### 3. Publish readiness covered code, not the app's data contract

The deployment lifecycle considered an uploaded `index.html` sufficient to
make a commit live. Bindings were resolved later, at request time, and missing
parquet artifacts produced a runtime fetch failure. The publish pointer update
was therefore not atomic with respect to everything the app needed to render.

### 4. Long-running starts lacked a durable operation boundary

App deployment already uses a durable background job, but dev-server startup
is synchronous. On a cold sandbox, dependency installation plus Vite startup
can outlive an MCP request even when the operation succeeds. A transport timeout
does not communicate whether the operation failed, continued, or completed.

### 5. Capability and authorization discovery was incomplete

Mako provides `dbt_run_model` and `dbt_run_job`, including asynchronous run
status, but write-capable warehouse tools are correctly hidden from read-only
OAuth clients. The caller had no concise capability report explaining that the
method existed, which scope was missing, and how to obtain an appropriately
scoped credential. The web UI's disabled production Run button did not provide
an equivalent automated path.

## What worked

- Git remained the durable source of truth; no app source changes were lost.
- Publish builds were already asynchronous and retryable through Inngest.
- Content-addressed binding artifacts make readiness checks idempotent and
  allow unchanged data products to be reused without rerunning warehouse SQL.
- The sandbox catch-up primitive already existed and safely avoids booting an
  idle sandbox.
- Browser-based visual testing caught both the missing-data failure and later
  rendering issues. It is the right tool for final visual and interaction QA.
- Read-only OAuth defaults prevented an agent from mutating the warehouse with
  credentials that had not been explicitly granted that authority.

## Remediation plan

| Priority | Capability                  | Remediation                                                                                                                                               | Success criterion                                                                   |
| -------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| P0       | Consistent app discovery    | Force-fetch the workspace repository before listing apps and before folder-based project resolution.                                                      | A pushed app is immediately addressable by every `app_*` tool on any API instance.  |
| P0       | Durable folder-only publish | Persist a repo-imported app's derived project row in the shared deploy worker before moving its publish pointer.                                          | Automatic and agent-triggered publishes remain published after reload.              |
| P0       | Fresh live checkout         | Catch up an existing actor sandbox before opening an app or materializing a binding, without booting an idle sandbox.                                     | Newly pushed app and binding files are visible on the first call.                   |
| P0       | Data-safe publish           | Verify/materialize every required parquet binding at the exact deployment SHA before updating `publishedSha`; reuse existing content-addressed artifacts. | A successful publish cannot expose an app with a missing required parquet artifact. |
| P1       | Publish observability       | Report code-build and binding-readiness state, including the failing binding, from publish status and logs.                                               | An agent can diagnose a stalled deploy without a browser or bucket inspection.      |
| P1       | Durable dev startup         | Return an operation identifier for cold dev starts and expose status/log polling while retaining a fast synchronous path for warm starts.                 | Tool request timeouts never leave startup outcome ambiguous.                        |
| P1       | Capability discovery        | Expose effective scopes plus unavailable tool names/reasons, with a documented scoped API-key flow for `warehouse:write`.                                 | An agent can distinguish "unsupported" from "not authorized" in one call.           |
| P2       | First-class CLI parity      | Provide authenticated CLI commands for app list/open/status/publish/materialize and dbt run/status using the same backend operations as MCP.              | Routine delivery can be scripted end-to-end without browser control.                |

## Security decision

The default OAuth client remains read-only for warehouse operations. Production
dbt execution can change durable datasets and must require an explicit
`warehouse:write` grant, such as a scoped API key or an approved delegated
credential. Remediation should make that boundary visible and easy to satisfy;
it must not silently broaden existing credentials.

## Verification plan

Automated coverage must prove that:

- app listing and folder fallback freshen a stale local mirror;
- opening and materializing catch up an existing sandbox before reading it;
- deployment checks bindings at the requested commit, materializes only
  missing parquet artifacts, and does not move `publishedSha` after a binding
  failure;
- an already-uploaded code deployment still passes binding readiness before it
  is made live;
- dev-only live bindings are rejected with a clear publish error rather than
  producing a deployment whose public data requests can never succeed;
- the full platform typecheck, lint, and relevant test suites pass.

## Follow-up ownership

The P0 items are implemented on the platform reliability branch associated
with this post-mortem. P1 and P2 work should be tracked independently so the
atomic correctness fixes can ship without waiting for broader CLI and
operation-status design.
