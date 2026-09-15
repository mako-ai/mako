# RFC: Connectors as code — a folder anyone can write, run in the workspace's sandbox

**Status:** proposed
**Continues:** RFC #936 (agent-authored flows), RFC #904 (flows as code)
**Sources:** the code at `ce70274d`, a production census of 2026-09-01, the
unmerged `cursor/connector-builder-system-b06c` branch, all 509 reachable
Airbyte YAML manifests and the Airbyte OSS registry, and a survey of
Airbyte, Singer/Meltano, dlt, Estuary, Sling, Debezium, PeerDB, Hasura,
n8n, Steampipe and Nango. Numbers are in the appendix.

## 1. Summary

Mako is pivoting to ETL: "transfer X to Y" for every source X and every
destination flavour Y, launched as thousands of generated pages. Connector
breadth is the growth engine, so connectors must be importable from the
open-source corpora and writable by agents against a conformance test,
without giving up the streaming CDC that already runs production.

The model is a game console:

1. **Mako is a console and an emulator.** The engine runs native
   connectors directly and emulates foreign ones.
2. **Native, Mako-sanctioned connectors are the best tier.** They live in
   Mako's source and implement the full `BaseConnector`, webhooks included,
   as Jonas's Stripe and Close do.
3. **Workspace connectors are written by any agent** into the workspace
   repo and discovered by the instance on push.
4. **The connectors directory installs any Airbyte or Estuary connector.**
   The emulator runs them; they work against every destination on day one.

In one sentence: **a connector is a folder that a runtime turns into a
process in the workspace's sandbox, speaking `BaseConnector`'s methods as
commands over stdio, so nothing downstream changes.**

The message format on that stdio is Airbyte's, taken unchanged. It is a
JSON line per record and per checkpoint, Singer's shape with more message
types, and it is what every connector in every corpus worth importing
already emits. Adopting it verbatim is the whole difference between
iteration 3 being a runtime and being a translator. Nobody writing a Mako
connector ever sees it: they write `defineConnector`, and the SDK does the
talking.

## 2. Decisions already taken

Taken by Joan on 2026-09-01. The rest of the document builds on them and
does not reopen them.

| Question | Decision |
|---|---|
| Contract level | **Code only.** A connector is an executable folder, never a form. |
| Contract | **`BaseConnector`, as it is.** Stripe and Close implement it in full; imported connectors implement the read half; nothing about it changes. |
| Wire protocol | **The Airbyte protocol, verbatim.** Mako's extensions are the wire form of `BaseConnector`'s webhook methods, additive and namespaced. |
| Runtimes | The TypeScript SDK, the Python declarative-manifest runner (a TypeScript port later), PyPI packages, OCI images, and Estuary connectors. All inside E2B. |
| Elastic License (541 of Airbyte's 600 sources) | Build on them under the analytics-platform clause. Mako ingests on behalf of its customers and never exposes Airbyte's UI, API or name. |
| Where connectors live | Three tiers (§3): native in Mako's source; workspace connectors in the workspace repo; emulated Airbyte and Estuary connectors installed into either place. |
| Estuary | Joan spoke to Estuary on 2026-09-01 and they agreed. Their LICENSE names *written* consent, so iteration 4 is gated on that written form existing in the repo, not on the conversation. |
| OAuth-type auth | Deferred. All 8 production data sources use API keys. |
| Database connections as YAML with env indirection | Later; needs a workspace-level vault first. |
| Reverse ETL | Rejected. |
| Destinations | Mako writes them, as drivers. Not a plugin tier, and Estuary's materializations are not imported: `destination-contract.test.ts` already says "adding a new sync destination = adding one row here". The page count is linear in them, so the destination backlog is a growth lever the same size as the connector backlog (§10.1). |
| Stack | TypeScript, npm, GitHub, E2B for everything Mako writes and hosts. Python and the JVM are allowed inside the box as connector runtimes, as notebooks already run Python. |
| Jonas's Stripe and Close | The quality bar and the conformance target. Untouched by this RFC. Imported sources are the long tail. |

## 3. The shape: one folder, three tiers, five runtimes

### 3.1 The folder

```
<slug>/
├── connector.yaml      # runtime, origin, page metadata; the only file read without executing
├── connector.ts        # runtime: node  — hand-written on @makoai/connector-sdk, or a manifest plus webhook methods
├── manifest.yaml       # runtime: declarative — a vendored Airbyte manifest
├── LICENSE             # upstream license, for vendored connectors
├── icon.svg
└── fixtures/           # recorded cassettes and vendor events for the conformance test
```

`connector.yaml` is small on purpose. Everything about behaviour comes
from running the connector (`spec`, `discover`).

```yaml
runtime: declarative                  # node | declarative | pypi | image | estuary
package: airbyte-source-github==1.8.0 # pypi
image: airbyte/source-salesforce:2.7.4 # image, estuary
origin:                               # vendored connectors only
  repo: airbytehq/airbyte
  path: airbyte-integrations/connectors/source-close-com
  sha: 4f2c…
  license: ELv2
page:                                 # feeds the generated pages; absent on workspace-private connectors
  vendor: Close
  category: crm
  docs: https://developer.close.com
```

The slug is identity, minted once. A data source instance keeps living in
Mongo with its encrypted credential and a `type` that resolves to the
folder (§3.3).

### 3.2 The tiers

| Tier | Lives in | Type on the data source | Who writes it |
|---|---|---|---|
| **Native** (Mako-sanctioned) | Mako's source, `api/src/connectors/<slug>/` | `<slug>` | Mako. Stripe and Close today, as in-process classes; new ones as in-process classes or as folders on the SDK, whichever is convenient |
| **Emulated, sanctioned** | Mako's repo, but a top-level `connectors/`, not `api/src/` | `<slug>` | vendored by Mako, kept current by a bot PR per upstream release |
| **Workspace** | the workspace repo, `connectors/<slug>/` | `ws:<slug>` | any agent; discovered on push; may be native-shaped or emulated |

Sanctioned emulated connectors sit in a top-level `connectors/` rather
than under `api/src/` because hundreds of manifests, licenses and icons
are data, not TypeScript: inside `api/src/` they would enter the API's
compile and its Docker image for no reason. Native connectors stay where
they are, because they are code.

The folder shape is identical across tiers, so promotion is moving the
folder into Mako's source. The namespaces do not overlap and nothing
shadows anything: `stripe` is always Mako's, `ws:stripe` is always the
workspace's. A workspace that wants to patch a broken vendored connector
copies the folder and points its flows at `ws:<slug>`, which is a visible
switch rather than a silent substitution on push.

### 3.3 Resolution

`registry.ts` today scans `api/src/connectors/*` for a class export.
It learns a second case, a folder whose `connector.yaml` has no class, and
registers a `SandboxedConnector` (§6) for it. Workspace connectors are not
scanned at boot; the push reconciler (§7) writes an index row, and
`getConnector` resolves `ws:<slug>` against that index, falling back to the
sanctioned entry of the same slug. Nothing else in the API learns a new
type; the `type` string on a data source is already free-form.

### 3.4 Runtimes

| Runtime | Executes in the box | Covers | Notes |
|---|---|---|---|
| `node` | `node connector.ts <cmd>` on `@makoai/connector-sdk` | hand-written connectors, and imported ones that add webhooks | The only runtime that can implement the webhook methods. |
| `declarative` | `source-declarative-manifest <cmd> --manifest-path manifest.yaml` from `pip install airbyte-cdk` (MIT) | 513 Airbyte sources | Replaced later by a TypeScript interpreter of the same MIT schema, gated on message-for-message agreement across the 509-manifest corpus. |
| `pypi` | `pip install <package>` then `<package> <cmd>` | 62 Airbyte sources on PyPI; Singer taps through a shim in the SDK package | The shim maps `--discover`/`--config`/`--state` and `SCHEMA`/`RECORD`/`STATE` onto Airbyte messages; a few hundred lines. |
| `image` | `docker run --rm -i <image> <cmd>` inside the box | Java Airbyte sources, anything shipping an image | Pull cache lives on the paused box's disk. If pulls dominate, per-image E2B templates built `fromImage` are the optimisation. |
| `estuary` | `docker run --rm -i <image>` driven over stdio with Estuary's capture protocol, translated to the wire in §4 | 24 Go database and stream CDC connectors, 19 native SaaS connectors on estuary-cdk | No gRPC: `flow-connector-init` is only a bridge; the connectors themselves speak newline JSON or length-prefixed protobuf on stdin and stdout. |

## 4. The wire protocol: Airbyte's, plus three commands

The process in the box speaks Airbyte's protocol: `spec`, `check
--config`, `discover --config`, `read --config --catalog --state`, JSON
Lines on stdout, messages `SPEC`, `CONNECTION_STATUS`, `CATALOG`,
`RECORD`, `STATE`, `LOG`, `TRACE`. State is opaque to Mako and passed back
verbatim; it is today's `FetchState.metadata`. `LOG` and `TRACE` lines go
to the flow run's log. Choosing the protocol verbatim is what makes the
corpora free.

Mako's extensions are additive, so a stock Airbyte connector is a valid
Mako connector with no stream:

| Extension | Purpose |
|---|---|
| `webhook --config` command | `extractWebhookCdcRecords` on the wire. stdin: a batch of stored vendor events; stdout: `RECORD`s with `op: upsert\|delete` and `sourceTs`. Batched because the engine already processes stored events in batches of up to 500 (`webhook-flow.ts:163`). |
| `subscribe --config --endpoint` command | `createWebhookSubscription` on the wire. stdout: subscription id and signing secret. |
| `mako.webhooks.verification` in `SPEC` | `verifyWebhook` as a declaration: `hmac-sha256` with header and encoding, `token` in header or query, or `none`. Mako verifies on the hot path in-process, so no connector code runs before an event is stored. |
| `changes --config --cursor` command | Only for the `estuary` runtime, whose database connectors emit a continuous change stream rather than receiving webhooks. stdout: `RECORD`s with `op`, then `STATE`. The adapter feeds them into the same ingest the webhook path uses. |
| `mako.entities.<name>.layout` in `SPEC` | partition field, granularity, cluster fields; today's `TableLayoutSuggestion`. |

`CATALOG` json_schema types map onto `ConnectorLogicalType`: string,
integer, number, boolean, `format: date-time` to timestamp, object and
array to json; `primary_key` becomes `keyColumns`. Many Airbyte streams
declare a loose schema (`additionalProperties: true`, or no properties at
all). The adapter infers missing fields from the first `read` page and
sets `unknownFieldPolicy: "string"`, so a loose stream lands as columns
plus a JSON overflow column rather than failing.

## 5. The contract is `BaseConnector`; the engine does the rest

There is no new contract. `BaseConnector` (`:227-539`) is what Stripe and
Close implement, and each of its methods has one wire command:

| `BaseConnector` method | Wire | Who implements it |
|---|---|---|
| `testConnection` | `check` | every runtime |
| `getAvailableEntities`, `resolveSchema` | `discover` | every runtime |
| `fetchEntityChunk` | `read` | every runtime |
| `verifyWebhook` | `mako.webhooks.verification` in `SPEC` | `node`, and any connector that declares it |
| `extractWebhookCdcRecords` | `webhook` | `node` |
| `createWebhookSubscription` | `subscribe` | `node` |
| `getIncrementalCapabilities` | derived from `SPEC` and `CATALOG` | every runtime |
| `getConfigSchema` (static) | `connectionSpecification` in `SPEC` | every runtime |

`getConfigSchema` is easy to miss and blocks everything else: it is what
`GET /api/connectors/{type}/schema` returns (`connectors.ts:140`) and what
renders the credential form (`ConnectorForm.tsx:218`). A sandboxed
connector has no class to call it on, so it comes from `spec`, whose
`connectionSpecification` is a JSON Schema of exactly the config fields
the connector needs. Without that wiring there is no way to type an API
key into a workspace connector, so it is iteration 1, not a detail.
`GET /{type}/icon` is served the same way, from the folder's `icon.svg`.

A stock Airbyte connector implements the first three rows. A native
connector implements them all. That is the whole difference between
**scheduled** and **instant** on a page.

Everything that makes Stripe and Close instant and correct is in the
engine, not in the two connector classes, and every connector on this
adapter gets it without knowing it exists:

| Mechanism | Where |
|---|---|
| Every webhook stored before anything else; unique on (flow, event id) so vendor retries cannot double-apply | `routes/webhooks.ts`, `WebhookEventSchema` index at `workspace-schema.ts:2712` |
| Failed and stale-in-processing events re-queued and replayed | `webhook-flow.ts` `webhookRetryFunction` |
| Change events carry an idempotency key; ingest dedupes, and a persistently high dedup ratio is flagged as a bad key rather than silently dropping changes | `sync-cdc/ingest.ts:35-85`, `event-store.ts:50` |
| A backfill cannot start while a run holds the lock; the stream position is `lastIngestSeq` plus `backfillCursor` | `sync-cdc/backfill.ts:180`, `sync-state.ts:136`, `flow-reconcile.ts:20` |
| Post-backfill state machine: mark complete, drain the events that arrived during the backfill, transition, restart the stream | `inngest/functions/flow.ts:1525-1545` |
| Materialization through destination adapters with retry of failed applies, orphan and stale-pending cleanup | `sync-cdc/backfill.ts:914`, `cdc-orphan-applystatus.ts`, `cdc-stale-pending-cleanup.ts` |

**An imported source plus webhooks is a native connector.** A folder with
`runtime: node` may take `check`, `discover` and `read` from a vendored
manifest and implement only the webhook methods itself:

```ts
export default defineConnector({
  ...fromAirbyteManifest("./manifest.yaml"),   // check, discover, read
  webhooks: {
    verification: { scheme: "hmac-sha256", header: "Calendly-Webhook-Signature" },
    subscribe: async ctx => ({ id, secret }),
    extract: (event, type) => [{ entity, op: "upsert", id, data, sourceTs }],
  },
});
```

That is the progressive-release path: one connector at a time, an agent
adds the webhook methods, and the conformance test replays recorded vendor
events through the engine before the connector is called native.

## 6. The adapter and the sync box

### 6.1 `SandboxedConnector extends BaseConnector`

One class. `testConnection` runs `check`; `getAvailableEntities` and
`resolveSchema` come from `discover`, cached per data source and sha;
`fetchEntityChunk` runs `read`; `extractWebhookCdcRecords` runs `webhook`
over a batch; `createWebhookSubscription` runs `subscribe`; `verifyWebhook`
reads the `SPEC` declaration. Every Inngest function, the CDC materializer,
the destination adapters, the flow form and the `/types` route keep
working, because they never see anything but `BaseConnector`. **The plugin
runtime is one more connector, not a second engine.**

### 6.2 `read` is a stream; the engine wants chunks

The engine calls `fetchEntityChunk` for at most `maxIterations` API calls
(default 10) and expects a resumable `FetchState` back
(`sync-orchestrator.ts:328`).

**For `node` connectors this is not a problem, and iteration 1 does not
solve it.** The SDK owns the process: `read --max-iterations N` stops after
N pages, prints `STATE`, exits. One `exec` per chunk, stdout to a file in
`scratch()` because `exec` caps output, `STATE` into
`FetchState.metadata`. No long-running process, nothing to reattach to.

**For foreign runtimes it is a real problem, and it arrives with iteration
3.** Airbyte's `read` runs until the stream is exhausted, which can take
hours, and no flag stops it early. The shape that follows is `execDetached`
with stdout to a file, chunks consuming that file from a byte offset, and a
restart from the last `STATE` when the process or the box is gone; Airbyte
sources checkpoint per slice, so the replay is bounded and the
destination's key columns absorb the overlap. Two things make it a design
to settle against a real process rather than on paper: a paused box freezes
the connector mid-request and the sockets it holds are dead on resume, and
a detached reader with nothing consuming it writes the whole stream to the
box's disk, so backpressure has to come from somewhere. Iteration 3 has an
Airbyte process to measure; this section does not pretend to have solved
it.

Config, catalog and state files are written per command and deleted when
the run ends, so a paused box's snapshot never holds a credential longer
than a run. The bulk carrier later is Parquet written in the box and loaded
through `cdcAdapter.loadStagingFromParquet`, the path apps.md §18 already
uses.

### 6.3 The sync box

One E2B box per workspace, separate from users' session boxes, paused with
memory between chunks. Its template is the apps template plus Python 3.11,
`airbyte-cdk` and a Docker daemon.

**Dependencies come with the folder or not at all.** In iteration 1 a
connector may depend on `@makoai/connector-sdk` and nothing else, and the
box's template ships it. That is a deliberate scope cut, not an oversight:
the box no longer clones, so the workspace's `package.json` and lockfile
are not there to install from, and reproducing an install in a paused box
is its own problem. When arbitrary dependencies are wanted, the copied
payload grows a generated `package.json` pinning what `connector.yaml`
declares, installed into `scratch()` once per sha and cached there.

**The sync box never clones the repo.** For every tier the API resolves the
folder and copies it into `scratch()` before the first command of a run: a
workspace connector at the sha the flow was reconciled against, a
sanctioned one at Mako's build sha. This is not a convenience. A box that
is given a remote gets a workspace-scoped `mgt_` token in a file for git's
credential helper (`box.ts:190`), and that token can push to the workspace
repo, which holds the apps, flows, dbt models and every other connector.
Cloning would turn "runs tenant connector code" into "can rewrite the
workspace". Copying the folder means the sync box holds no Mako token at
all, which is what makes the second row of §6.4 true.

Several flows of one workspace may run concurrently in the same box; the
box is sized for that, and per-vendor rate limits are the connector's job
as today.

### 6.4 Security model: a workspace connector can only hurt its own workspace

The bar for iteration 1 is that a vibe-coded connector adds no risk beyond
what the workspace already accepts by giving Mako a credential. Connector
code is untrusted tenant code, and it never runs in the API process, not
even for `spec` on reconcile.

| The connector can | The connector cannot | Because |
|---|---|---|
| Read the one credential the data source holds, decrypted into a file for the duration of a command | Read any other data source, any other workspace, or the API's environment | It runs in the workspace's E2B microVM with the allowlisted environment `SandboxProvider.exec` already enforces for apps |
| Reach the internet, which it needs to reach the vendor | Reach Mako's API at all; the box holds no Mako token | The sync box never clones, so it never gets the `mgt_` git token (§6.3). That is the difference between a connector that can read one API key and a connector that can rewrite the workspace repo |
| Emit records | Write to the destination database | The engine writes; the connector never sees a destination credential |
| Import the SDK the template ships, and in later iterations the dependencies its folder declares | Affect any other tenant's box or the API's dependencies | Per-workspace box, per-workspace disk |
| Run until the command's hard timeout and fill its output cap | Run forever or exhaust the API | `exec` and `execDetached` timeouts and caps; a stuck `read` is killed and restarted from the last `STATE` |
| Become active by being pushed to the workspace repo's main | Become active from a session branch, a fork, or an API call | The push reconciler runs on main only, behind the same branch policy flows and dbt use (apps.md §19) |
| Declare how its webhooks are verified | Run code before an inbound webhook is stored | Verification is declared in `SPEC` and executed in-process; parsing runs later, in the box, over stored events |

What remains is exfiltration of the workspace's own credential by a
connector the workspace itself pushed to its own main, which is the same
risk as any code a workspace member writes with that key, and the
credential lives in the box only for the length of a command (§6.2).
Egress control is not in scope; if it becomes needed, it is an E2B
network policy on the sync box, not an API change.

## 7. Discovery, registration, conformance

**Workspace push.** `connectors/*/connector.yaml` is reconciled the way
skills are (`skills.service.ts:231`): run `spec` in the sync box, write a
`ConnectorDefinition` index row (`workspaceId`, `slug`, `sha`, `runtime`,
`spec`, `status`), tear down on delete behind the fail-closed tree guard
flows use. No install step; the repo is the truth and Mongo is the index.

**Reconcile cannot prove a connector works, and should not pretend to.**
At push time there may be no data source and no credential, so `check`,
`discover` and `read` have nothing to run against. What reconcile can do
is run `spec`, validate it, and replay the folder's cassettes, which
catches a connector that does not start, does not declare its config, or
has drifted from its own fixtures. That yields `indexed`, and an
`indexed` connector is offered in the picker so a credential can be
entered. The live `check` runs when the data source is saved, exactly as
it does for a built-in connector today, and that is what yields
`verified`. A connector that fails either step is `blocked`, with the
failing message stored, and blocked connectors cannot back a flow.
Entities and incremental capabilities also arrive only after the first
`discover`, for the same reason.

**Conformance is a command.** `mako connector test <path>` runs `spec`,
`check`, `discover` and one `read` page against a real credential,
validates every message against the Airbyte protocol schema plus Mako's
extension schema, checks that `discover` types agree with what `read`
emitted, exercises `webhook` and `changes` against recorded events when a
stream exists, and prints a table preview. `--record` writes cassettes into
`fixtures/`; without a credential the test replays them, so CI stays green
and secret-free. The same command is an MCP tool, so an agent closes the
loop the way RFC #936 does for flows.

**The SDK.** `@makoai/connector-sdk`, published from
`packages/connector-sdk`: `defineConnector`, whose methods are
`BaseConnector`'s methods spoken over stdio, `fromAirbyteManifest`,
`ctx.http` with retries and rate limits, `ctx.paginate` for cursor, offset,
page and link styles, the protocol writer, and the Singer shim. Workspace
connectors pin it in the workspace repo's `package.json`; sanctioned ones
use Mako's.

**The sanctioned catalogue.** One vendored folder per Airbyte manifest or
Estuary image in Mako's source, with LICENSE, `origin` and `page`. A bot
opens a PR per upstream release; the conformance test is the judge; an
agent repairs a broken one in place. That repair loop is the answer to
"their connectors broke on us". The page feed is built from
`connector.yaml` plus `SPEC`, one page per (connector, destination);
workspace connectors have no `page` block and never appear.

## 8. Licensing posture

The analytics-platform clause of Airbyte's ELv2 FAQ allows "creating an
analytics platform and using Airbyte to bring data in on behalf of my
customers", and forbids hosting Airbyte and selling it as an ELT tool, or
exposing Airbyte's UI or API. Engineering consequences:

- Mako never exposes an Airbyte UI, API or the word Airbyte to a customer;
  connectors are Mako connectors with an `origin`.
- Every vendored connector keeps its upstream LICENSE in its folder. The
  Mako repository is MIT and becomes a mixed-license repository; a
  top-level `THIRD_PARTY_LICENSES.md` lists what is vendored under what.
- The 49 MIT Airbyte sources, the MIT CDK, dlt, Debezium, and anything an
  agent writes are unconditional.
- Estuary's LICENSE grants MIT or Apache only with written consent. Joan
  has their agreement as of 2026-09-01; the written form is committed next
  to the vendored connectors, not kept in email.
- Sling is GPL with paywalled API sources and PeerDB is an AGPL platform;
  neither is vendored.

## 9. Estuary, examined

Estuary is the closest thing to this RFC in the field, and importing it is
cheaper than it looks.

- **Their catalogue is a console too.** 19 of 99 sources are native on
  estuary-cdk; the rest are Go connectors or Airbyte images run through
  their `airbyte-to-flow` adapter.
- **Their native connectors separate backfill from change capture** and
  reconcile the overlap with a cutoff, which is what the engine's backfill
  lock and drain do. Their native Stripe polls `/v1/events` with a log
  cursor; nothing of theirs receives a vendor webhook per tenant.
- **Their protocol is transactional.** The runtime acknowledges checkpoints
  after commit. Mako's engine gives the same guarantee through stored
  events, idempotency keys and the drain, at the cost of a Mongo round
  trip per event rather than a stream.
- **Importing needs no gRPC.** `flow-connector-init` spawns the image
  entrypoint and speaks Request/Response over stdin and stdout. A
  TypeScript host in the box drives `spec`, `discover`, `validate`,
  `apply`, one `open` with the last checkpoint, then a stream of
  `captured` and `checkpoint` lines acknowledged after Mako has stored
  them. That is the `changes` command in §4, feeding the same ingest as
  webhooks.

| Group | Count | What it brings |
|---|---|---|
| Database and stream CDC, Go | 24 | Postgres logical replication, MySQL binlog, MongoDB change streams, SQL Server CT, Oracle, DynamoDB, Firestore, Kafka, Kinesis, S3, GCS. The Debezium alternative as a stdio process, and the Postgres-to-warehouse product for 964 of our 1,342 connections. |
| Native SaaS on estuary-cdk | 19 | Stripe, HubSpot, Salesforce, Shopify, Zendesk, Jira and others. |
| Airbyte-derived | the rest | Already covered by the Airbyte runtimes. |

Two gates. The written consent their LICENSE names, which iteration 4
waits for. And one technical gate: some connectors emit partial documents and
rely on Flow's reduction annotations to assemble rows. Mako implements the
strategies a connector uses or the conformance test rejects it. The
database CDC connectors emit full rows with an op field and are the easy
case. Images are public on GitHub's registry; estuary-cdk installs from
git, not PyPI.

## 10. What happens to the 11 built-ins

Stripe and Close keep serving the 8 production instances, in-process,
indefinitely. They are the reference, not a migration target. Calendly,
PandaDoc, Wise and Claap are complete, implement webhooks, and have zero
production instances, which makes them **comparison oracles**: their
Airbyte counterparts run through the new path against the same account,
and parity with the in-house output is the gate. The remaining five are
candidates for deletion once their Airbyte equivalents pass conformance.

### 10.1 The other axis: destinations

Pages are (source, destination) pairs, so the catalogue is a product of two
backlogs and the destination one is the shorter and cheaper. Nine drivers
exist; five of them have a CDC adapter and can therefore back an
**instant** page.

| Destination | Driver | CDC adapter |
|---|---|---|
| BigQuery, ClickHouse, MySQL, Postgres, MongoDB | yes | yes |
| Redshift, CloudSQL Postgres, Cloudflare D1, Cloudflare KV | yes | no |
| Snowflake, Databricks, S3 or Iceberg | no | no |

Adding one is ordinary work on an extension point that already exists:
`destination-contract.test.ts` says "adding a new sync destination = adding
one row here", the Redshift driver is 127 lines and ClickHouse 197 because
each reuses a dialect, and the Postgres, MySQL and MongoDB CDC adapters are
about 330 lines each. Ten more SQL destinations is a backlog, not an
architecture, and it multiplies the page count by three.

The three missing names are the ones the ETL market actually buys, so they
belong in the same plan as the connector work even though this RFC does not
schedule them. Which ones come first is answerable before any of it is
built: pages can be generated for a source or a destination that does not
exist yet and carry a waiting list, which makes the sign-ups the priority
queue for both backlogs.

## 11. Alternatives rejected

- **A Mako protocol dialect.** Every imported connector would need a
  translator, and the translators would be the product's biggest surface.
- **A YAML tier authored by hand.** Vendored Airbyte manifests give the
  corpus without an authoring tier.
- **Connector as an HTTP service** (Hasura NDC). A deploy per connector.
- **In-process npm packages** (n8n). Full host access in a multi-tenant
  API.
- **Docker outside E2B** (Cloud Run Jobs, GKE Jobs, Fly Machines). Cheaper
  per second, but a second execution substrate with its own secrets path;
  apps.md §12 decided one substrate.
- **Estuary's capture protocol as the wire contract.** Richer, but the
  Airbyte catalogue would then need a translator on day one. Its
  connectors run through a runtime instead (§3.4).
- **A new connector contract.** An earlier draft proposed one, borrowed
  from estuary-cdk. It was `BaseConnector` with different names; dropped.
- **Reviving the connector-builder branch.** Source in Mongo and a blob
  contract with no streaming or checkpoint.

## 12. Iterations

Joan's order, 2026-09-01. The first iteration is the whole product in
miniature: someone vibe-codes a connector into their own workspace repo,
Mako discovers it, and a flow uses it, with no security risk. Everything
after that widens what a folder can contain. Each iteration ships behind
a flag, has a gate that is watched rather than inferred (apps.md §25), and
leaves Stripe and Close untouched.

| # | Iteration | Ships | Gate |
|---|---|---|---|
| 1 | **A vibe-coded connector in the workspace repo, discovered, used in a flow, safely** | The folder shape and `connector.yaml` with the `node` runtime only (§3.1); `@makoai/connector-sdk` with `defineConnector` for `check`, `discover` and `read`, `ctx.http` and `ctx.paginate`, and no other dependency allowed yet (§6.3); the wire fixed as Airbyte's protocol (§4), so iteration 3 is a runtime and not a translator; the sync box, copying folders rather than cloning (§6.3); `SandboxedConnector` with one `exec` per chunk, which is all a `node` connector needs (§6.2); the credential form and icon served from `spec` and the folder (§5); the push reconciler and `ConnectorDefinition` index with its three states (§7); `ws:` resolution and the data-source picker; `mako connector test` as a CLI and as an MCP tool; the security model in §6.4, every row of it. | From a laptop clone, an agent writes `connectors/<slug>/` for a vendor Mako has never had a connector for, the test passes, it pushes to main, the connector appears in the picker, a scheduled flow created through the RFC #936 path lands rows in BigQuery. A second workspace cannot see or use it. The connector's process is shown to hold no Mako token and no other credential. Cost per chunk and resume latency are measured here. |
| 2 | **Instant: webhooks on the wire** | The `webhook` and `subscribe` commands, `mako.webhooks.verification` in `SPEC`, the adapter's three webhook methods, `defineConnector` extended with `webhooks`. | The iteration-1 connector gains webhook methods and its flow becomes instant: events verified in-process, stored, parsed in the box in batches, and a backfill with webhooks arriving during it reconciles through the engine's drain. Separate from 1 because it opens a public endpoint per data source and is the only place connector-declared behaviour touches the hot path. |
| 3 | **Airbyte connectors** | The `declarative`, `pypi` and `image` runtimes (§3.4), the streaming-`read` adapter for processes that cannot be told to stop (§6.2), the registry's class-less-folder case for sanctioned vendored folders, the loose-schema policy (§4), `fromAirbyteManifest` in the SDK. Staged: `declarative` first, then `pypi` and `image`. | Airbyte's Calendly, PandaDoc and Wise vendored as folders match the in-house connectors on the same accounts. GitHub from PyPI and one image-only source land rows. An agent adds webhook methods to the vendored Calendly with `fromAirbyteManifest` and it becomes instant. |
| 4 | **Estuary connectors** | The `estuary` runtime: a stdio host for their capture protocol, the `changes` command feeding ingest, the written consent committed, the reduction-annotation check in conformance. | Estuary's Postgres capture streams inserts, updates and deletes from a dev database into BigQuery, with a backfill and changes arriving during it, acknowledged only after events are stored. One estuary-cdk SaaS connector passes conformance. |
| 5 | **Harmonize the contract** | Whatever 3 and 4 had to bolt on, folded into `BaseConnector` properly, with spec, SDK and test updated together. The known candidate is a long-running change stream with acknowledged checkpoints, which log-CDC sources need and which exists until then only as the `changes` command. **Constraint: additive.** Connectors written in iterations 1 and 2 keep working unchanged; if a change cannot be additive, it ships with a migration for every workspace folder and is not merged without one. | In-house, vendored Airbyte and Estuary connectors all pass one conformance test with no special cases, and every iteration-1 connector still passes it. |
| 6 | **Sanctioned catalogue and pages** | The vendoring bot, `THIRD_PARTY_LICENSES.md`, the page feed from `connector.yaml` plus `SPEC`, deletion of the unused built-ins whose equivalents pass. The TypeScript declarative runner as a background track. | One generated page per (connector, destination). Can start as soon as 3 lands; placed last because it is the first thing a customer sees and the earlier iterations decide what it can promise. |

What each iteration deliberately leaves out: 1 is scheduled-only and
`node`-only, and ports nothing; 2 adds no runtime; 3 and 4 add no product
surface; 5 changes no behaviour a customer can see; 6 is the launch.

## 13. Open questions

- **Cost per chunk** is measured in iteration 1. If pause-between-chunks
  is too slow or too costly at 31 scheduled flows, the fallback is a box
  per run, not a second substrate.
- **Who merges a bot PR when conformance goes red** is a policy, not a
  mechanism.
- **Debezium** fits the `image` runtime and Apache-2.0, but log CDC with
  slots and snapshots is a different product surface. Estuary's Go
  captures cover the same databases through iteration 5; whether Debezium
  is still needed is decided after it.
- **Schema drift.** A vendored manifest's `discover` can change between
  upstream releases. Today's engine treats schema as resolved at flow
  creation; the bot PR must surface a `discover` diff before merge.

## Appendix A. The corpora, measured

| Corpus | Size | Form | License | Verdict |
|---|---|---|---|---|
| Airbyte sources | 600 | 513 pure YAML manifests, 63 Python (62 on PyPI), 24 Java | 541 ELv2, 49 MIT | **Primary.** |
| Airbyte declarative CDK | 133 component types, 5,599-line schema | Python package `airbyte-cdk`, ships `source-declarative-manifest` | MIT | The runner for the 513. |
| Singer taps (Meltano Hub) | 628 | Python, `tap-*` on pip | SDK Apache-2.0; taps MIT, Apache, ELv2 or AGPL per repo | **Secondary.** A shim away. |
| dlt verified sources | 36 | Python | Apache-2.0 | Small; the rest_api source is a reference. |
| Estuary connectors | 99 sources (19 native, 24 Go CDC, the rest Airbyte-derived), 34 materializations | OCI images speaking Request/Response over stdio (JSON lines or length-prefixed protobuf); proto Apache-2.0 | Connectors MIT/Apache with written consent, BSL otherwise | **Import.** |
| Sling | 30 DBs, 93 API specs | one Go binary | GPL-3.0; API sources paywalled | **Skip.** |
| Debezium Server | 13 database sources | JVM, HTTP sink | Apache-2.0 | **Later**, see §13. |
| PeerDB | narrow | full platform | AGPL-3.0 since 2026-01 | **Skip.** |

Of the 509 downloaded manifests: an interpreter of the top 20 component
types runs 218, top 30 runs 399, top 40 runs 462. Auth is bearer (156), API
key (152), basic (80), OAuth2 (74), session token (18). 250 have datetime
incremental cursors, 205 have parent-child substreams, 53 reference custom
Python classes and need porting whatever the runtime. Stripe and Close in
Airbyte are both manifest-only polling sources: importing is a floor, not
a ceiling.

## Appendix B. What we build on

- **The engine is destination-agnostic already.** `sync-orchestrator.ts`
  drives a `BaseConnector` and writes through the driver layer
  (`writer.writeBatch`, `:766-788`) or `sync-cdc/adapters/*` for BigQuery,
  ClickHouse, MySQL, Postgres and Mongo. Records with a declared
  `ConnectorLogicalType` (`BaseConnector.ts:172-178`) are translated per
  destination.
- **The connector contract exists as a class.** `BaseConnector`
  (`:227-539`): `testConnection`, `getAvailableEntities`, `resolveSchema`,
  `fetchEntityChunk` with an opaque `FetchState`, `verifyWebhook`,
  `extractWebhookCdcRecords`, `createWebhookSubscription`,
  `getIncrementalCapabilities`.
- **Discovery by folder is the house pattern.** `connectors/registry.ts`
  scans directories; skills reconcile from the repo with Mongo as a
  derived index; the connector `type` is a free-form string
  (`workspace-schema.ts:1560`).
- **The sandbox primitive exists.** `SandboxProvider.exec` guarantees cwd
  containment, an allowlisted environment, a hard timeout and output caps;
  `execDetached`, `readFile` and `scratch` exist (`provider.ts:105-169`).
  E2B boxes pause with memory, resume in about a second, and are not billed
  while paused. E2B documents a Docker daemon inside a sandbox and
  templates built `fromImage` on Debian images; Airbyte images are Debian
  bookworm.
- **The census.** 11 built-in connectors, about 11,400 lines, 8 with zero
  production instances. 8 data sources (Close 4, Stripe 2, GraphQL 2), 31
  flows, all CDC, one workspace. 1,342 database connections across 1,295
  workspaces, 964 of them Postgres.
- **The failed attempt.** `cursor/connector-builder-system-b06c` (7,847
  lines, March to April 2026) put source in Mongo and returned one blob
  per run. Its pagination helper is salvageable; its data model is not.

## Related

- RFC #936 agent-authored flows; RFC #904 flows as code
- `docs/connector-builder-prd.md`, the March 2026 design this replaces
- apps.md §12 (one substrate), §18 (Parquet through the bucket), §19 (repo
  doctrine), §25 (false-completion discipline)
