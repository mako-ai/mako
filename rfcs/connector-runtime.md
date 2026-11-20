# RFC: Connector runtime — every connector out of the API, run in leased E2B boxes

**Status:** proposed, 2026-11-16
**Continues:** RFC #947 ([connectors as code](./connectors-as-code.md)). That RFC's
folder, wire protocol (Airbyte's, verbatim), tiers and security model stand. This RFC
changes four things it decided or left open, listed in §2.
**Sources:**

- the code at `master` 5906b5588: `api/src/connectors/*`, `api/src/connectors/workspace/sync-box.ts`, `api/src/sync/sync-orchestrator.ts`, `api/package.json`;
- RealAdvisor's production flow status on 2026-11-16;
- Netlify's write-up of moving Edge Functions from V8 isolates to Firecracker microVMs;
- Cloudflare Workers for Platforms and Containers documentation.

## 1. Summary

The API runs Mako's own connectors in its own process, and they carry vendor code. One of them is the `stripe` SDK, one of the API's 60 npm dependencies. A connector change ships only with an API release. One misbehaving connector shares memory and an event loop with every tenant.

Workspace connectors already run elsewhere: in one E2B box per workspace (RFC #947 §6.3).

This RFC moves **every** connector to that model. It then makes the box scale:

1. **One runtime for all connectors.** Mako's own connectors become folders on `@makoai/connector-sdk`, built into versioned bundles and run in E2B boxes like workspace connectors. The API keeps only the engine, the destinations and the database drivers.
2. **Mako builds; nobody deploys.** A connector folder is bundled into one file per source hash, by Mako, on push. Workspace repos hold source only. Users never deploy.
3. **Install by reference.** A workspace installs a Mako connector by committing one line, `source: mako/stripe@1`. The marketplace is a registry of bundles.
4. **Boxes are leased, not owned.** A scheduler leases a box per run, scales boxes up from queue depth and down to zero, keeps a backfill from starving live reads, and holds every workspace to a budget.

In one sentence: **the API is the control plane; connector code runs only as short, leased, snapshot-restored jobs in Firecracker microVMs, speaking the protocol it already speaks.**

This is not microservices. There is one deployable, one database and one owner of state (§9).

## 2. What changes from RFC #947

| RFC #947 said                                                                                                      | This RFC says                                                                                                                                                      | Why                                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Stripe and Close stay in-process "indefinitely"; they are the reference, not a migration target (§10)              | **They move out**, after the box passes a benchmark on Close's largest sync (§10, gate G2). They stay the quality bar: the move must be invisible in their output. | Vendor code in the API, release coupling, blast radius. Decided by Joan, 2026-11-16. |
| A connector may depend on the SDK only; dependencies later via a generated `package.json` installed per sha (§6.3) | **A folder may carry `package.json` and a lockfile. Mako bundles it into one `.mjs` per source hash.** `node_modules/` is refused in the repo.                     | Repos stay light; the box gets one file; the build is cached by hash.                |
| One sync box per workspace; several flows may run in it at once (§6.3)                                             | **A scheduler leases boxes per run, keyed by connection and bundle hash**, restored from a snapshot, paused within a minute of going idle, killed on a TTL.        | Contention, credential separation, elasticity, cost (§6).                            |
| Cost per chunk measured in iteration 1; fallback "a box per run" (§13)                                             | Measured as gate G1 of this RFC, on RealAdvisor's ES Close backfill.                                                                                               | The number decides how many runs a box serves.                                       |

Untouched: the folder, `connector.yaml`, the Airbyte wire protocol, `BaseConnector`, `SandboxedConnector`, the push reconciler with its `indexed` and `verified` states, the rule that a box never clones the repo and holds no Mako token, the engine owning destination writes, and the five runtimes.

## 3. Decisions taken

Taken by Joan on 2026-11-16 in the design discussion this RFC records.

| Question                                                         | Decision                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox provider                                                 | **E2B**, kept. Firecracker microVMs give hardware isolation for code that holds credentials. Mako already runs on them.                                                                                                                                         |
| Cloudflare Workers for Platforms                                 | **Not now.** It is fast and cheap for HTTP connectors. But the isolate model forces paged reads under CPU limits and a second runtime for anything native or TCP-based. Netlify moved the other way for isolation. Revisit only if G1 fails on latency or cost. |
| Moving all of Mako to Cloudflare                                 | **No.** dbt and MetricFlow (Python subprocesses), MongoDB through Mongoose and DuckDB's native binding cannot run in isolates. Lifting the Docker image into Cloudflare Containers changes the host, not the design.                                            |
| Mako's own connectors                                            | Out of the API process, onto the same runtime as workspace connectors (§4).                                                                                                                                                                                     |
| Database drivers (pg, BigQuery, Mongo, ClickHouse, MSSQL, MySQL) | **Stay in the API.** They are query engines and destinations, not connectors.                                                                                                                                                                                   |
| Who builds and deploys                                           | **Mako, automatically.** A user saves or pushes. The next run uses the new code.                                                                                                                                                                                |
| Architecture style                                               | Control plane plus sandboxed jobs, not microservices (§9).                                                                                                                                                                                                      |

## 4. Where connectors live

| Tier                                                                                                            | Source lives in                                                                     | Built by                                                             | Installed as                                                                        | Runs in    |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- |
| **Mako** (Stripe, Close, PostHog, Wise, Calendly, PandaDoc, Claap, the REST, GraphQL and custom API connectors) | Mako repo, top-level `connectors/<slug>/` (moved from `api/src/connectors/<slug>/`) | Mako CI on release, semver per connector                             | `source: mako/<slug>@<range>` in the workspace's `connectors/<slug>/connector.yaml` | Leased box |
| **Vendored** (Airbyte, Estuary; RFC #947 iterations 3–4)                                                        | Mako repo, `connectors/<slug>/`, with `origin:`                                     | Mako CI, bot PR per upstream release                                 | Same reference                                                                      | Leased box |
| **Workspace**                                                                                                   | Workspace repo, `connectors/<slug>/` with `entry:`                                  | Mako, on push to main or on first run from a branch, per source hash | Itself                                                                              | Leased box |

The folder shape is identical across tiers, as RFC #947 required. Promotion and ejection move a folder:

- **Eject.** Copy a Mako connector's source into the workspace's `connectors/<slug>/`. It becomes a `ws:` connector the workspace owns. It no longer upgrades. The switch is visible in the flow file.
- **Publish (later).** A workspace connector is submitted to the registry. After review, others install it by reference.

What leaves `api/src`: the 10 vendor-facing connector directories (`calendly`, `claap`, `close`, `custom_api`, `graphql`, `pandadoc`, `posthog`, `rest`, `stripe`, `wise`). What stays: `base/` (the contract), `registry.ts`, `rate-gate.ts`, `probe.service.ts`, `workspace/` (the adapter and runtime), and `bigquery/` while it is a warehouse reader rather than vendor APIs.

### 4.1 What stays in the API: the connection gateway and workflows

Two paths reach vendor APIs without running connector code. Neither moves.

- **The connection gateway (#1178).** Hatchet workflows and agents call a vendor through `api/src/connections/proxy.service.ts`.
  - The API forwards the request with the stored key, so the key never leaves Mako.
  - Each connection lists who may read and who may write. A deployed workflow acts as itself (`workflow:<name>` or `workflow:*`). A write is bound to an executing run and recorded.
  - It holds no vendor SDK and no tenant code: it is credential handling plus HTTP forwarding. Moving it into a box would put the key back into a sandbox and undo #1178's guarantee.
- **Named live-read operations (#1269).** `call_connection` operations such as Close `search_leads` or PostHog `hogql` are request builders on that gateway. They execute in the API in milliseconds and need no box, so they are not runs and not P0 (§6.5).
- **Hatchet workflows.** Workflow step programs run on Hatchet workers (`deploy/workflows/`), a separate runtime this RFC does not touch. A workflow that needs synced data reads the warehouse. A workflow that needs a vendor calls the gateway.

**Where the two meet later.** A connector in a box could make its vendor calls through the gateway too, with a run-scoped token in place of the raw key. The box would then never hold a credential at all. The cost is vendor responses passing through the API twice during a backfill. Left as an open question (§12).

## 5. Build: a source hash in, one bundle out

### 5.1 The pipeline

| Step                                                                                           | Who                                                                  | When                                          |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| Compute the **source hash**: the folder, its lockfile and the SDK version                      | Mako (the push reconciler, or the run that finds no bundle)          | On push to main; on first run from a branch   |
| Resolve dependencies from the lockfile, then esbuild into one `.mjs` with dependencies inlined | Mako, in a **build box**, an E2B box with network and no credentials | Once per hash                                 |
| Store the bundle under its hash                                                                | Mako, in object storage                                              | After the build                               |
| Make the box **template**: a snapshot of a box with Node, the SDK and the bundle loaded        | Mako                                                                 | After the build, or lazily on the first lease |
| Clean up                                                                                       | Mako                                                                 | Bundles and templates unused for 7 days       |

Rules:

- A bundle is immutable and named by its hash. Two flows on the same hash share it; a new hash never touches an old one.
- A build failure is a connector status, shown where `indexed` is shown today, and returned by `mako connector test`.
- **Build is not trust.** A bundle runs with the rights of its connection, nothing more. RFC #947 §6.4 holds unchanged.
- Non-`node` runtimes (`declarative`, `pypi`, `image`, `estuary`) skip esbuild. Their "bundle" is the pinned package or image reference, and the template carries the installed result.

### 5.2 What the user sees

- **Save, then it runs.** The first run after an edit waits for the build, a few seconds. Later runs start from the template.
- **Branches work.** A session branch has its own hash, so it gets its own bundle. Main never changes until merged. This loosens one RFC #947 §6.4 row: a branch can _run_ a connector for testing, under the same connection rights; only main can _index_ one into the picker.
- **No deploy step, no Cloudflare or E2B account, no artifact to manage.**

## 6. Box lifecycle

### 6.1 The unit is a run

Every `spec`, `check`, `discover` and `read` chunk and every webhook batch is a **run**. Live reads through `call_connection` are not runs: they go through the connection gateway in the API and execute no connector code (§4.1). A run carries:

- the connection;
- the bundle hash;
- a priority;
- a cursor (`FetchState`);
- a deadline.

The engine already works in chunks: `fetchEntityChunk` stops after `maxIterations` pages (default 10) and returns a resumable state (`sync-orchestrator.ts`). A chunk is therefore the natural run.

### 6.2 States

| State                                       | Cost       | Moves to                                                |
| ------------------------------------------- | ---------- | ------------------------------------------------------- |
| **Template**: a snapshot per bundle hash    | Storage    | A box, on lease                                         |
| **Paused**: a box with disk and memory kept | Storage    | Running, on lease; killed after its TTL                 |
| **Running, leased**: executing one run      | Per second | Running, idle, when the run ends                        |
| **Running, idle**                           | Per second | Paused after 30–60 s; killed if the pool is over target |
| **Killed**                                  | None       | —                                                       |

Rules:

- **A box is keyed by connection plus bundle hash.** Connections never share a box, so one connector never sees another's credential, even concurrently. That closes the open question in RFC #947 §6.3, where several flows shared one workspace box.
- **No box runs without a lease.** Each lease has a heartbeat and a deadline. A **reaper** kills a box whose lease expired or whose heartbeat stopped, which covers API crashes and lost orchestration steps.
- **A new bundle hash gets fresh boxes.** Old boxes drain and die.
- **Retirement.** A box is replaced from its template after K failed runs or M hours, so memory leaks and stray files do not accumulate.
- **Health.** A lease starts with a cheap `ping`. A failed ping kills and replaces the box.
- **Per run:** credentials, config and state files are written to a per-run directory under a per-run Unix user, and deleted in a `finally`, as `sync-box.ts` does today.

### 6.3 Scaling up

- **Signal:** queued runs and run age, per connection and per workspace.
- **Order:** restore a paused box first, then fork a new one from the template.
- **Parallel backfill:** a large backfill splits by entity, each with its own cursor. Close FR's `Call`, `Email` and `EmailThread` (31.2M, 24.1M and 18.0M rows applied) can run in parallel.
- **Per-connection cap:** concurrency per connection is capped at what the vendor's rate limit allows. More than 2–4 boxes per Close account buys nothing, because Close throttles per key. `rate-gate.ts` stays the per-key limiter.

### 6.4 Scaling down

- Idle running boxes pause within a minute.
- Paused boxes die after a TTL: 24 h for connections with runs in the last day, 1 h otherwise.
- Templates unused for 7 days are deleted.
- **Warm boxes are the exception.** A connection gets one warm box during its active hours only when its run rate justifies it: webhook-driven Close tenants during European business hours. Everything else starts from paused or from the template.

### 6.5 Priorities

| Priority            | Runs                                                                                        | Rule                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **P0, interactive** | Connection tests, `discover` in the picker, the first chunk of a flow a person just started | May take a box from P2 at the next chunk boundary. Target lease wait under 2 s at p95.                   |
| **P1, steady**      | Webhook batches, polls, the daily resync                                                    | Normal                                                                                                   |
| **P2, bulk**        | Backfills, full resyncs                                                                     | Pre-emptible after any chunk; the cursor makes that safe. At most 50% of a workspace's concurrent boxes. |

The existing chunk caps give natural pre-emption points: 32 MB or 50,000 protocol messages per command (`MAX_CONNECTOR_PROTOCOL_BYTES`, `MAX_CONNECTOR_PROTOCOL_MESSAGES`) and a 10-minute timeout.

### 6.6 Cost controls

- **Per-workspace budget:** box-seconds per day, plus a maximum of concurrent boxes, set by plan.
  - At the budget, P2 pauses, P1 slows down and P0 keeps running.
  - The workspace is alerted; nothing stalls silently.
- **Global ceiling** below the E2B plan's sandbox limit. Past it the scheduler queues, and an alert fires at 80%.
- **Right-sized boxes.** The default is 1 vCPU and 1 GB. A connector may declare more in `connector.yaml`. The scheduler records peak memory per bundle and flags oversized declarations.
- **Fewer runs.** Webhooks first; polls only where no webhook exists; the daily resync samples, plus entities whose cursor shows drift.
- **Cost on the page.** Box-seconds per connection and per flow show in flow status, the MCP `flow_status` tool and an admin panel.

### 6.7 Reliability

- **Chunks are idempotent.** A chunk keyed by run, entity and cursor can retry in any box. A box dying mid-chunk loses at most one chunk; the destination's key columns absorb the overlap, as RFC #947 §6.2 already relies on.
- **Long foreign processes.** Airbyte `read` that cannot stop early (RFC #947 §6.2) holds its lease through heartbeats. On box loss it restarts from the last `STATE`.
- **Read sessions (`CONNECTOR_SESSION_READS`, off by default).** One connector process reads a whole entity instead of one process per chunk, which removes the Node boot, SDK import and bundle load from every chunk after the first. A root supervisor in the box cuts its output into one file per chunk. The API pulls batch N with one `readFile` and acknowledges batch N − 1. The engine's chunk metadata names the session and the last applied batch, so a retried chunk re-reads the same batch, and a lost session restarts from the last applied `STATE`. The run user and its credential live for the read, capped at 1 hour, and die after 5 minutes without an acknowledgement. Sessions run in the workspace sync box; with leases on, reads stay one process per chunk until a lease can hold a box across Inngest steps.

### 6.8 Where it lives

- **Scheduler and reaper:** in the API. Leases and boxes in a Mongo collection; queues and heartbeats in Redis, which the API already runs for chat streams.
- **Durable runs:** the existing Inngest functions, one step per chunk, so a run survives an API deploy.
- **Provider:** E2B behind a small `BoxProvider` interface (`lease`, `exec`, `pause`, `kill`, `snapshot`). `getSandboxProvider` already abstracts most of it.

### 6.9 What we measure

- Queue depth and age per priority.
- Lease wait.
- Snapshot restore time.
- Box counts per state.
- Box-seconds and cost per workspace and per connection.
- Pre-emptions, reaped boxes and failed pings.

Alerts:

- P0 lease wait over 5 s;
- a workspace at 80% of budget;
- global boxes at 80% of the ceiling;
- a connection whose queue grows for 30 minutes.

## 7. Marketplace and install

| Action              | How it works                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Browse**          | The registry lists bundles: entities, live operations, auth type, version, changelog, and a Mako or verified badge. Agents read it through `list_connectors` and `inspect_connector`.                |
| **Install**         | Mako commits `connectors/<slug>/connector.yaml` with `source: mako/<slug>@<range>` to the workspace repo. No code. The repo stays the truth; the push reconciler resolves the reference to a bundle. |
| **Connect**         | Unchanged: enter a credential, `check` runs, the connection becomes `verified`.                                                                                                                      |
| **Upgrade**         | Patch and minor releases within the range apply on the next run. A major release opens a commit or PR bumping the range, with the changelog and a `discover` diff (RFC #947 §13, schema drift).      |
| **Eject**           | Copy the source into the folder and drop `source:`; it becomes `ws:<slug>` (§4).                                                                                                                     |
| **Publish (later)** | Review, then registry entry. Out of scope until the registry carries Mako's own connectors.                                                                                                          |

The `connector.yaml` schema gains one field, `source`, mutually exclusive with `entry`.

## 8. What happens to scale: RealAdvisor's Close syncs

RealAdvisor runs the largest syncs today, all in-process.

| Flow       | Rows applied, lifetime                                        | Steady state        | Daily resync | Last full backfill        |
| ---------- | ------------------------------------------------------------- | ------------------- | ------------ | ------------------------- |
| `fr_close` | about 110M (31.2M `Call`, 24.1M `Email`, 18.0M `EmailThread`) | webhooks, backlog 0 | 24–47 s      | October, entity by entity |
| `es_close` | about 75M (21.4M `Email`, 17.9M `Call`)                       | webhooks, backlog 0 | 6.5–8 min    | 15 Nov 2026: 3 h 54 min   |

Same workspace: 4 more Close tenants, 6 Stripe accounts and about 20 workspace connectors.

In a box:

- **Memory is bounded:** one page in flight per chunk, a few MB, at any total volume.
- **CPU is not the limit:** JSON parsing and paging; Close's rate limit dominates wherever the code runs.
- **The risks are contention and per-chunk overhead.** The ES backfill becomes about 1,500 chunk round trips. Contention is solved by per-connection boxes and priorities (§6). Overhead is what gate G1 measures.

## 9. This is not microservices

|                     | Microservices                                             | This design                                                                                                           |
| ------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Deployables         | Many services, each with an API, a database and a release | One API, plus connector bundles that are artifacts                                                                    |
| Runs in Firecracker | Everything                                                | Connector code only                                                                                                   |
| Communication       | HTTP between services                                     | The API runs a command in a box. The connector answers in Airbyte JSON lines on stdout. No HTTP between parts.        |
| State               | Every service                                             | The API owns cursors, leases, budgets, credentials and destination writes. Boxes are stateless except their snapshot. |
| Coordination        | Events between services                                   | The API's scheduler; Inngest makes long runs durable                                                                  |

The closest analogies are GitHub Actions runners and Airbyte workers: a control plane hands bounded jobs to throwaway sandboxes. The scheduler and the build step may become separate internal processes if load demands it. Nothing tenant-facing changes if they do.

## 10. Iterations

Each iteration ships behind a flag and has a gate that is watched, not inferred.

| #      | Iteration                             | Ships                                                                                                                                          | Gate                                                                                                                                                                                                                                        |
| ------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** | **Benchmark**                         | A test workspace replays RealAdvisor's ES Close backfill shape through `SandboxedConnector` in a box                                           | E2B snapshot restore under 1 s at p95. Per-chunk overhead under 300 ms. Total backfill time within 1.5× the in-process 3 h 54 min. Cost per backfill recorded. A failure here reopens the Workers for Platforms option for HTTP connectors. |
| 1      | **Bundles for workspace connectors**  | `package.json` and lockfile in a folder; the build box; bundles by hash; the `node_modules/` guard; build status on the connector              | An existing workspace connector gains an npm dependency, builds, runs, and the repo holds no `node_modules/`. Repo size per connector recorded before and after.                                                                            |
| 2      | **Leases and lifecycle**              | Scheduler, leases, heartbeats, reaper, box per connection plus hash, snapshot templates, pause on idle, TTL kill, metrics                      | All of RealAdvisor's workspace connectors run through leases for 7 days with zero leaked boxes (running with no lease), and the box-seconds per day reported.                                                                               |
| 3      | **Priorities and budgets**            | P0–P2, chunk pre-emption, per-connection caps, per-workspace budgets, the global ceiling, the cost panel                                       | During a forced backfill, a connection test gets a box in under 2 s at p95. A test workspace hits its budget, P2 pauses, P0 keeps working, and an alert fires.                                                                              |
| 4      | **Registry and install by reference** | `source:` in `connector.yaml`, the registry, release CI for `connectors/`, upgrade within range, eject                                         | Stripe, moved to `connectors/stripe/` and built by CI, installed by reference in a test workspace, matches the in-process Stripe output on the same account, entity for entity.                                                             |
| 5      | **Mako connectors out of the API**    | Stripe, Wise, Calendly, PandaDoc, Claap and PostHog switch per connection behind a flag; then Close, gated on G1 numbers holding in production | For each connector, 7 days of parity on row counts and key checksums between in-process and boxed runs on RealAdvisor's connections. Then the old directory and its dependency (the `stripe` SDK) are removed from `api/`.                  |
| 6      | **Marketplace**                       | Catalog UI, changelogs, the major-version PR, publish flow for workspace connectors                                                            | A workspace installs, upgrades and ejects a connector without touching code.                                                                                                                                                                |

## 11. Alternatives rejected

| Alternative                                         | Why not                                                                                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers for Platforms as the default runtime        | Isolates bound CPU and memory, break native and TCP drivers, and need a second runtime for the rest. A microVM runs today's connectors unchanged. Kept as a fallback if G1 fails. |
| One box per workspace with a better queue           | Still one VM: a backfill delays live reads, and connections share a box with each other's credentials.                                                                            |
| A Firecracker fleet of our own (Netlify's approach) | A platform team's work: VM lifecycle, snapshots, sticky routing. E2B sells it.                                                                                                    |
| Publishing connectors to npm                        | Versioning without immutability by content, a public surface, and still a build step. A hash-addressed bundle store is simpler.                                                   |
| Docker images for every connector                   | Hundreds of MB and seconds of start for code that is a few hundred KB of JavaScript. Images stay one of the five runtimes, for connectors that need them.                         |
| Keeping Mako's connectors in-process                | Vendor code in the API, release coupling, shared blast radius.                                                                                                                    |

## 12. Open questions

- **E2B limits on our plan:** concurrent sandboxes, snapshot count and retention, restore latency at volume. G1 measures the last; the first two need E2B's answer.
- **Sizing:** the sync box's actual vCPU and memory today, and whether 1 vCPU and 1 GB is enough for Close pages.
- **Close chunk state:** confirm the Close connector's `FetchState` carries everything a chunk needs to resume in a different box, with nothing held in process memory between chunks.
- **Credential isolation today:** confirm whether two flows running at once in today's shared workspace box can read each other's per-run credential directory. If they can, iteration 2 is also a security fix, and a per-run Unix user should ship ahead of it.
- **Egress:** an E2B network policy per box (allowlisted vendor hosts) is now cheap to add per connection. Decide whether it ships with iteration 2 or stays out of scope, as RFC #947 §6.4 left it.
- **Pricing:** whether box-seconds become a visible plan limit or stay internal.
- **Keys out of the box:** whether boxed connectors call vendors through the connection gateway (§4.1) with a run-scoped token, so no credential ever enters a box. Measure the extra API traffic on the ES Close backfill before deciding.

## Related

- RFC #947, [connectors as code](./connectors-as-code.md): the folder, protocol, tiers and security model this builds on.
- #1178: the connection gateway (`api/src/connections/proxy.service.ts`), through which Hatchet workflows and agents call vendors with keys that never leave Mako. Unchanged (§4.1).
- #1269: live reads of Close, PostHog and Stripe through named operations on that gateway. Unchanged (§4.1).
- #1271: the user sandbox shell, which shares the E2B provider but not these boxes.
