---
name: flows-as-code
description: Load when adding, changing or removing a sync flow by editing flows/<slug>.yml in a workspace repo — "add a Stripe connector and sync it to BigQuery", "sync the new Close account", "stop syncing X" — or when a pushed flow file did nothing.
entities:
  - flows/
  - flow file
  - flow yaml
  - flows as code
  - connector_id
  - connection_id
  - backfill_schedule
  - entities.layouts
  - partitionField
  - check_flow_files
  - list_connectors
  - inspect_connector
  - probe_connector
  - cdc flow
  - webhook flow
  - scheduled flow
  - teardown
---

# Flows as code

`flows/<slug>.yml` in the workspace repo is the **definition** of one EL sync:
what to move, from where, to where, on what trigger. It is authoritative — a
push to main that changes the file changes the flow; a push that removes the
file tears the stream down **and disposes its checkpoints** (re-adding the
file re-backfills from scratch). This skill is for the agent working in a
checkout of that repo, over MCP. For the in-product flow form, load `flows`.

## Identity and what never goes in a file

- **The filename slug is the identity.** Minted once, never changes. Renaming
  `close-eu.yml` → `close-europe.yml` is a delete plus a create: the old
  stream is torn down, the new one starts from zero with a new webhook URL.
  `name:` inside the file is the display name and is free to change.
- **Never in a file** (the format has no key for them; the sync never writes
  them from a file): credentials — connectors and connections are referenced
  by ObjectId only; the webhook `secret` and `endpoint` (URL identity, minted
  in Mongo on first create from `workspaceId` + flow `_id`, never the slug);
  run state — cursors, `lastRunAt`, checkpoints, counters.

## The loop: discover → write → check → push → verify

1. **Discover the ids.** Ids cannot be guessed and a connector NAME where an
   id belongs (`connector_id: close`) is refused.
   - `list_connectors` → `source.connector_id`
   - `inspect_connector` → the entities it offers (an entity it does not
     offer yields a flow that runs and syncs nothing), whether incremental is
     valid, config field names (never values)
   - `list_connections` → `destination.connection_id` (BigQuery / Postgres
     connection); the same id goes in `destination.table.connection_id`
   - `probe_connector` → run the connector LIVE before committing a flow:
     the credential check, and with `entity` one bounded page of real
     records (`limit` ≤ 200, `fields` to narrow), written nowhere. Use it to
     confirm a new connector works and to see the fields an entity really
     carries — that is where `partitionField` and `clusterFields` come from.
2. **Write `flows/<slug>.yml`.** Copy a neighbouring file for the same
   connector type when one exists — its entity list and `partitionField`
   choices are production-tested. Strip any `_id:` lines inside
   `entities.layouts`: they are Mongo subdocument ids that leaked into the
   projection and must not be copied onto a new flow.
3. **Check before pushing: `check_flow_files`.** Pass the files you changed
   as `[{ path, contents }]`; the tool reads the rest of `flows/` at main
   itself, so an unmentioned flow is never read as deleted. It reports in
   three layers — parse + id resolution (`problems`), the row schema (a
   layout missing `partitionField`, a `write_mode` outside the enum), and
   the plan against running streams: `wouldCreate`, `wouldReconfigure`
   (entities dropped → their checkpoints disposed), `wouldTeardown`. **Read
   `wouldTeardown` and `wouldReconfigure` first.** The agent failure mode is
   not a typo; it is *omitting* a file or an entity, and both are the
   destructive path. To check a deletion, name it in `deletedPaths`. The
   `guard` verdict is `unevaluated` pre-push by design — the fail-closed
   mirror check runs against the pushed commit.
4. **Push to main.** The push reactor upserts rows and reconciles streams. A
   push with a bad file does not fail: the reactor keeps the current row and
   logs a warning you cannot see. Step 3 is the only feedback.
5. **Verify it is live** — below. "The file appeared" and "data is flowing"
   are different claims.

## Format

On-disk keys are **snake_case** (the API's `FlowFile` type is camelCase; do
not mix). A Close → BigQuery CDC flow, the shape most production flows take:

```yaml
name: ch_close → bigquery_write
type: webhook                 # CDC = type: webhook + backfill_schedule. type: scheduled = polling on schedule.cron
source:
  type: connector
  connector_id: <ObjectId from list_connectors>
destination:
  connection_id: <ObjectId from list_connections>
  table:
    connection_id: <same ObjectId>
    schema: ch_close_crm      # BigQuery dataset — REQUIRED for BigQuery; created on first write if create_if_not_exists
    create_if_not_exists: true
    partitioning: { enabled: false, require_partition_filter: false }
    clustering: { enabled: false, fields: [] }
backfill_schedule:            # this is what makes a new CDC flow START — see "What live means"
  cron: 0 3 * * *
  timezone: UTC
webhook:
  enabled: true
sync:
  mode: incremental           # full | incremental
  write_mode: append_dedup    # append_dedup | append | overwrite
  engine: cdc                 # legacy | cdc
  delete_mode: soft
  batch_size: 2000
entities:
  layouts:                    # explicit selection; dropping an entry later disposes that entity's checkpoint
    - entity: leads
      label: Leads
      partitionField: _syncedAt     # REQUIRED per layout
      partitionGranularity: day     # day | hour | month | year
      clusterFields: [id, status_id]
      enabled: true
    - entity: activities:Call       # Close activities are sub-typed "activities:<Type>"
      partitionField: _syncedAt
      partitionGranularity: day
      clusterFields: [lead_id, user_id, activity_at]
      enabled: true
conflict:
  strategy: update            # update | ignore | replace | upsert
pagination:
  mode: offset
  keyset_direction: asc
```

- Required: `name`; `type` ∈ {scheduled, webhook}; `source.connector_id`
  (connector source) or `source.connection_id` + `database` + `query`
  (database source); `destination.connection_id`. A missing id is refused
  and the current row is kept.
- Database-source flows add `incremental: { tracking_column, tracking_type:
  timestamp|numeric }` and `pagination: { mode: offset|keyset, keyset_column
  }`; queries use `{{limit}}`, `{{offset}}`, `{{last_sync_value}}`,
  `{{keyset_value}}`.
- `partitioning` / `clustering` blobs are camelCase in the API and
  snake_case on disk (`require_partition_filter`); both directions are
  normalised.

## What "live" means after the push

Nothing sends a start event on create — the UI does not either. Everything is
field-driven by 5-minute Inngest crons, so a file-born flow becomes live only
if it carries the field the cron looks for:

| File carries | What happens |
| --- | --- |
| `sync.engine: cdc` + `backfill_schedule:` | first backfill starts on the next scheduler tick (**≤5 min**); ingest/materialise of change events is workspace-wide and needs no per-flow registration |
| `sync.engine: cdc`, no `backfill_schedule` | row sits at `idle` until a human presses Backfill in the UI |
| `type: scheduled` + `schedule: { cron, timezone }` | runs on the cron |
| `type: webhook` | row is *addressable* (endpoint minted, shown on the flow's page) but inbound deliveries are rejected with 400 until (a) the provider's signing secret is pasted in the UI — never from the file — and (b) the provider is pointed at the minted URL. Push first, then do both. |

Verify: there is no flow-status tool over MCP yet — open the Flows page:
`streamState` should leave `idle` and a backfill run should appear; then
`SELECT count(*)` in the destination via `execute_query`.

## Removing and renaming

- Deleting a file tears the stream down and disposes checkpoints. The
  reactor **refuses and retries next push** if it cannot verify the tree
  against the GitHub mirror, so a deletion that "did nothing" may be a
  deferred one (API log: "Flow teardown deferred"). It never guesses.
- Renaming the slug = teardown + fresh create. To rename only what users see,
  edit `name:`.
- An empty or missing `flows/` directory means "this workspace has not
  adopted flows as code" and touches nothing. It is not "delete everything".

## Creating the connector (the step the file cannot do)

A flow file references a connector that must already exist. **No MCP or CLI
tool creates one**; `POST /api/workspaces/{id}/sources` behind a signed-in
session is the only construction site, and it takes the API key. So: ask the
user to create the connector in Mako (Sources → Add), `list_connectors` for
its id, then write the file. Never write an API key into a repo file.

## Gotchas that have bitten

- The push reactor reads **main**. A branch push does nothing to flows.
- One bad file does not stop the others, but it also does nothing visible:
  the row is kept and the slug lands in the sync result's `invalid` list,
  which only the API log shows. Run `check_flow_files` before every push.
- `entities.layouts[].partitionField` missing, or `sync.write_mode` outside
  the enum, passes parsing and fails at save. `check_flow_files`' schema
  layer catches both; the CLI `pnpm flows:validate` (mako repo only) does
  not yet.
