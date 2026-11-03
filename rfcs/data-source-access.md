# RFC: Who may write through a data source

Status: implemented (writes). Read restrictions: designed, kept on branch
`claude/connection-read-gate`, not shipped.

## What people need

- Sources are readable by everyone in the workspace (as today).
- Writing is rare: little to no one, and sometimes one workflow to one table.
- Reads must not get slower.

## Model

```ts
// on DatabaseConnection; absent or empty = no one writes
writers?: { principal: string; where?: string; addedBy; addedAt }[]
// principal: "user:<id>" | "workflow:<name>"   ("group:<name>" later)
// where:     absent = anywhere | "finance" (schema / dataset) | "finance.invoices"
```

- Reads have no field: everyone. If reads are ever restricted, a `readers`
  field with the same shape is added; absent keeps meaning everyone, and
  writers can read where they write.
- No mode and no workspace setting: the list is always enforced. Before
  this, members could not write from the console (only admins, through
  "Execute anyway") and MCP keys only with `allowAgentWrites`, so an empty
  list matches what people already do; admins and agent chats that wrote
  are refused until listed, and the refusal says how to get added.
- Owner and admins edit the list, in the app only (not API keys, MCP or
  agents), the same people who may set `allowAgentWrites` or delete a
  connection today.

## The check

One function, `checkConnectionWrite`, at the entry of `executeQuery`,
`executePreviewQuery` and `executeStreamingQuery` (once per query):

1. **Who is acting**: an explicit actor (a scheduled console runs as its
   owner), else the workflow of the request, else the signed-in person or
   API key owner. No one for work no request started (syncs, flows, CDC,
   dbt): the system's, never checked.
   Workflow code can read the key it runs with, so `X-Mako-Workflow` is
   trusted only from the deployed worker's key (this environment's
   `Workflows worker` key) and only for a workflow deployed from main. A
   sandbox run's key acts as the person testing, whatever it sends, and is
   removed when the run ends. The worker naming no deployed workflow acts as
   `worker:workflows`, which no list can hold: never as whoever deployed it.
2. **Is it a write**: in memory, with the existing read-only classifier
   (`checkPreviewQuerySafety`, plus SHOW, DESCRIBE, EXPLAIN), with no lookup.
   A read returns here, marked to run read-only where the engine allows
   unless its principal may write anywhere (see Limits). MongoDB requests
   are classified by their operation or shell method.
3. **May they**: the writers list comes with the connection document. A
   writer limited to a place must write one statement that names its target
   (`INSERT INTO s.t`, `CREATE TABLE s.t`, `UPDATE`, `DELETE`, `MERGE`,
   `DROP`, `TRUNCATE`, `ALTER`); the target is read from the statement,
   since a write names what it changes. Anything else is refused for that
   writer, never guessed.
4. **Record and decide**: every write by a person or workflow is recorded
   (`connection_write_events`, 90 days: who, connection, target, allowed;
   never the statement). A write not allowed is refused with a message
   saying what to do.

A flow writing to its own destination from a route a person called (dataset
on create, CDC resets, resync, recover) runs as Mako (`asSystem`), like its
syncs; so does every Inngest function (`/api/inngest`). Inside a request,
a write by no identified person or workflow is refused unless it runs as
Mako; work outside any request (scripts, startup) is Mako's. Routes that
change a MongoDB connection with the raw client (create or drop a
collection or view) run the same check first.

For agents and API keys, being on the list is also the connection's
`query:write` opt-in for that principal only, next to `allowAgentWrites`.
The workflow worker's key carries `query:write`; existing keys gain it on the
next deploy.

## Rollout

Enforced from the start. The Access tab shows who wrote or tried to write
through the connection in the last 30 days and what the list does not
cover, with **Allow** for each, so whoever is refused is added in one click.

## Limits

- A write hidden inside a function call (`SELECT f()` where `f` writes) is
  classified as a read. Reads by anyone not allowed to write anywhere run
  read-only (Postgres, Cloud SQL, Redshift: `BEGIN TRANSACTION
  READ ONLY` sent with the query in one round trip; MySQL: a read-only
  transaction; ClickHouse: `readonly=2`), so the database refuses it.
  BigQuery and D1 `SELECT`s cannot write. MongoDB and SQL Server have no such
  mode: connect with a read-only database user where that matters, as for
  Postgres `dblink`, which opens its own connection.
- MongoDB commands (`runCommand`, `adminCommand`, `eval`) count as writes.
  MongoDB writers limited to a place cannot be checked; allow them anywhere
  or not at all.
- dbt, syncs and flows are not concerned. App bindings only read (MongoDB
  and KV included).

- Deployed workflows share one worker process and key, so one deployed
  workflow's code could send another's name. Reaching main takes an admin,
  who can edit writers lists anyway; review workflow code for it. Closing it
  needs a process (and key) per workflow.

## Later, without changing the model

- Groups from SSO (`group:<name>`), expiry on an entry, request-and-approve.
- Read restrictions (`readers`), using the gate kept on
  `claude/connection-read-gate`.
- Column and row security belong in the warehouse, reached by passing the
  person's own identity through (BigQuery or Snowflake OAuth), not in Mako.
