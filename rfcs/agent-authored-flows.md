# RFC: Agent-authored flows — "add a Stripe connector and sync it to BigQuery"

**Status:** implemented except gap 3 (headless connector creation) — see
"Where this landed" at the end
**Continues:** RFC #904 (flows as code), which shipped 2026-09-01
**Written from:** the code as it stands at `0d0eec98`, a production census, and
an end-to-end test against the live workspace — not from memory.

## The scenario

Someone clones their workspace repo, opens Claude Code in it, and says:

> add a Stripe connector and sync it to BigQuery

What should happen:

1. Claude reads a **skill** that ships in the workspace repo and knows the shape
   of the job.
2. It prompts for the API key.
3. It calls Mako — over MCP or a CLI — to create the connector. **The secret
   goes to encrypted Mongo and never touches the repo.**
4. It writes `flows/<slug>.yml` — the definition, referencing the connector by
   id.
5. It pushes.
6. The webhook reacts, the flow syncs, and Inngest makes it live.

Steps 4–6 exist and were verified in production on 2026-09-01. Steps 1–3 are
mostly classification and one skill. Step 6 has a hole, described below.

## Why this shape is right

The credential and the definition have different homes, and the split is the
whole design:

| | Home | Why |
|---|---|---|
| API key | encrypted Mongo | a secret in git is a secret forever, in every clone |
| Flow definition | `flows/<slug>.yml` | reviewable, diffable, revertible |
| Run state | Mongo | cursors move every sync; committing them is a merge-conflict machine |
| Webhook endpoint | Mongo | inbound URL identity external systems POST to; survives a `name:` change, while a file rename is a *different flow* — the slug is identity |

So this is deliberately **two mechanisms, not one**: a call that takes a secret
and returns an id, then a file that references it. Any design that puts the key
in the file is wrong, and any design that puts the definition behind an API
loses the review and revert that motivated RFC #904.

## What already exists

- **Files are authoritative.** A push reconciles definitions and CDC streams
  (`services/flow-sync.service.ts`, `sync-cdc/flow-reconcile.ts`), behind a
  fail-closed tree assertion for anything destructive.
- **Mako is an MCP server** — `POST /api/mcp`, OAuth 2.1 or scoped `mgt_`
  workspace keys. A local Claude Code can already reach it.
- **Skills live in the workspace repo** (apps.md §22), so a skill is *already
  in the checkout* when someone opens Claude there. This step needs no new
  mechanism at all.
- **`create_data_source` already exists as a tool.** It is excluded from MCP by
  policy, not absent — see below.
- **The bridge policy is enumerated.** `api/src/mcp/bridge-policy.ts` classifies
  every agent tool as bridged or excluded-with-a-reason, and an inventory test
  fails on anything unclassified. Changing this surface is a deliberate act,
  which is exactly the property we want.

## The gaps, with evidence

### 1. There is no validator — the agent writes blind

`parseFlowFile` returns `null` on a bad file; `syncFlowsFromRepo` logs
`"Flow file is invalid; keeping current row"` and skips. There is no
`flows:validate` script, nothing in `lint:all`, and no MCP tool.

So an agent commits YAML, gets a green push, and **nothing happens**. No error
reaches it, so it cannot self-correct. For an agent, a silent no-op is worse
than a loud failure — it is indistinguishable from success.

This is the first thing to build. Everything else is easier to debug once it
exists.

### 2. A file cannot create a working webhook flow

`generateWebhookEndpoint` is called only from `routes/flows.ts` (lines 608,
1050, 1107, 1217) — **never from the sync path**. `applyDefinition` sets
`webhookConfig.enabled` and deliberately never touches `endpoint` or `secret`,
because those are Mongo-side identity that must survive a rename.

That is correct for an *edit* and wrong for a *create*. A file-born webhook flow
gets `enabled: true` and **no endpoint**: Stripe has nowhere to POST. It is a
dead flow that looks configured.

The missing `secret` is NOT part of this gap, and mistaking it for one would
ship a bug. It is the *provider's* signing secret: `routes/flows.ts:1056` takes
it from the user ("Webhook secret must be provided by the user (from
Stripe/Close)"), the Stripe-managed path at :3162 stores `created.signingSecret`
from Stripe's API, and `routes/webhooks.ts:125` hands it to
`connector.verifyWebhook`. A value Mako invented would fail signature
verification on every real delivery while looking configured — worse than the
empty string, which at least fails honestly.

**17 of 31 production flows are webhook**, so this is the common case, not the
edge. The fix is narrow — mint an ENDPOINT ONLY when a row is created from a
file, never on update — but it must exist before an agent can author one. The
secret stays a user-supplied value — Stripe's `whsec_...`, checked by
`connector.verifyWebhook` — so an agent-authored webhook flow needs the
provider's signing secret supplied separately. That is a real limit on the
headline scenario and belongs in the skill.

Note what cannot be pinned here: "a rename must not re-mint the endpoint" is not
a case. The slug IS identity and the sync path matches on it, so a renamed file
finds no row and is a DIFFERENT flow by construction — new row, new `_id`, the
old one reconciled away. The real property to test is that the endpoint derives
from `workspaceId` + `_id` and never the slug, so an EDIT cannot move it. Making
renames preserve inbound URLs would need identity in the file or git rename
detection, and deserves its own argument.

### 3. Nothing can create a connector headlessly

**Corrected 2026-09-01, after this RFC first claimed otherwise.** The original
text said `create_data_source` already exists and merely needs reclassifying
from `exclude("client-only", "Dashboard builder UI.")` at `bridge-policy.ts:245`.
That is wrong, and the exclusion note is the reason it misleads: the note is
accurate about the tool and is easily read as being about connectors.

`create_data_source` lives in `packages/agent-tools/src/dashboard-tools.ts`. It
creates a **dashboard-local** data source — a query materialized into DuckDB in
the browser — alongside `list_data_sources` and `inspect_data_source`. Bridging
it would expose a dashboard-builder tool over MCP and would not create a Stripe
connector.

What actually creates a connector is `POST /api/workspaces/{id}/sources`
(`routes/sources.ts:213`, `new DataSource(...)` at `:256`). That is the *only*
construction site outside tests, and **no agent tool exposes it**. A scoped
`mgt_` key cannot reach it either: `scopedKeyMayAccess` limits scoped keys to
`/api/mcp` plus three binding routes.

So this item is **build a new credential-accepting tool**, not flip an
exclusion — which changes both the effort and the security question. What stays
true is that the six flow-form tools remain excluded and the file replaces them.

### 4. The agent cannot invent an ObjectId — three discovery gaps

A definition references ids the agent has to *find*. Walked against what
`FlowFile` (`flow-config-files.ts:59`) actually requires, and verified live over
MCP:

**Available today:** `destination.connectionId` and a database source's
`connectionId` via `list_connections` (which allowlists fields and returns no
credentials), and `destination.table.{database,schema,tableName}` via
`list_databases` / `list_tables` / `inspect_table`.

**Missing, all three:**

- **`source.connectorId`** — nothing lists connectors over MCP. An agent that
  has just created a Stripe connector cannot re-find it. (`list_data_sources`
  is the DuckDB dashboard tool, not this — see gap 3.)
- **`entityFilter[]`** — no way to ask what entities a connector offers.
  The registry has `supportedEntities` and connectors implement
  `resolveSchema(entity)`; neither is exposed. This is precisely how you get a
  flow that runs and syncs nothing.
- **Sync-shape introspection** — `getIncrementalCapabilities()` decides whether
  `sync.mode: incremental` is even valid for a connector. Not exposed, so an
  agent guesses.

So the MCP surface grows by roughly **three read tools plus one
credential-accepting write tool**, not one policy line.

### 4b. The connector secret path is fail-open

Found while auditing gap 3's security question, and true today independently of
this RFC. Connector credentials are encrypted **at the route** by
`applySchemaEncryption`, driven by each connector's own config schema
(`encrypted: true` or `type: "password"`), not by a mongoose setter. Two
consequences:

- It **fails open**: `try { encryptString(val) } catch { target[key] = val }` —
  "if encryption fails, leave as-is". A missing or short `ENCRYPTION_KEY` stores
  the secret in **plaintext** and returns 201. That is the #915 shape exactly:
  partial protection that reads as success.
- Protection depends on per-connector metadata being right, with nothing
  central enforcing it. A new connector that omits the marker stores plaintext
  silently. A census found 11/11 connectors and 49 fields correctly marked
  today — so this is a latent trap, not a live leak, and it deserves an
  executable check rather than a periodic census.

Note this is a **third** credential model: connections redact-on-read with a
sentinel restore (#909/#915), the app env vault is write-only (#899), and
connectors return **ciphertext** on read. Ciphertext is not a plaintext leak, so
this is not urgent — but a fourth model arriving with a new MCP tool is the
drift worth refusing now.

### 5. "Make it live" is unproven for a NEW flow

Everything verified in production on 2026-09-01 was **reconciliation of existing
flows**: 31 synced, 0 streams touched, CDC uninterrupted. The
**create-from-file** path has never produced a running stream. For a webhook
flow it demonstrably cannot yet (gap 2); whether a newly created CDC row gets
its stream started is untested.

"The file appeared" and "data is flowing" are different claims. Today's work
produced four separate cases of something looking done and not being
(apps.md §25); this is the same shape and deserves the same suspicion.

## Design

### Validator

One parse-and-resolve entry point, reachable three ways so the feedback loop
closes wherever the agent is:

- `pnpm flows:validate [file]` — for a local checkout
- an MCP tool — for the agent
- a pre-push or CI check — so a bad file cannot land silently

It should check, in increasing order of usefulness:

1. **Parses** — `parseFlowFile` does not return null.
2. **Resolves** — the connector and destination ids exist in this workspace.
   A well-formed file naming a nonexistent connection is the likeliest agent
   error and is currently invisible.
3. **Entities are real** — a selection naming an entity the connector does not
   offer is how you get a flow that runs and syncs nothing.
4. **Slug is free** — or belongs to the flow being edited.

### Dry-run

The agent's failure mode is not a typo. It is **omitting** a file or an entity,
and both are the destructive path: a missing file is a teardown, a missing
entity disposes that entity's checkpoint. The fail-closed guard defers a
teardown when the mirror cannot be verified — it does **not** protect against a
confidently wrong file that was pushed successfully.

So: a dry-run that reports what a tree *would* do — created, reconfigured, torn
down, entities dropped — without doing it. This is the difference between an
agent that can be trusted with a repo and one that cannot.

### The skill

Ships as a **system skill** in `api/src/agent-skills/` (revised — first draft
said the workspace repo's `skills/`; the knowledge is platform-wide, and system
skills reach a local Claude Code over MCP through `list_skills` / `load_skill`
with nothing in the checkout). It carries:

- the format, and the four things that never go in a file (credentials, run
  state, the webhook endpoint, cursors)
- that the slug is identity, minted once, and renaming a file does not rename a
  flow
- the two-step shape: create the connector first, get an id, then write the file
- a worked Close→BigQuery example, because 31 of 31 production flows are CDC and
  the entity-selection details are where a plausible-looking file goes wrong
- **validate, then dry-run, then push** as the loop

## Sequencing

1. **Validator** — closes the feedback loop; everything downstream is debuggable
   once it exists.
2. **Dry-run** — makes the destructive paths visible before they run.
3. **Webhook endpoint on create-from-file** — unblocks the majority case.
4. **Discovery** — walk the read tools against this exact task; add what is
   missing.
5. **Bridge `create_data_source`** — one policy line plus a review of the secret
   path.
6. **The skill** — last, because it should document what works rather than what
   is planned.

Gaps 2 and 5 are worth fixing regardless of whether this RFC is built: a
file-born webhook flow being dead is a bug in what shipped, and "make it live"
being unverified for new flows is a hole in the block-3 story.

## Open questions

- **Does a scoped `mgt_` key have the right scopes** for creating a connector
  that holds a secret? If not, what is the smallest scope that does?
- **Who reviews an agent-authored flow?** The file is in git and revertible,
  which is most of the answer — but a flow that starts syncing on push has
  already moved data by the time a human reads the diff.
- **Should `create_data_source` over MCP require a stronger auth tier** than
  read tools, given it accepts a credential?
- **What happens to the connector if the flow file is never pushed?** An
  orphaned connection holding a secret, created by step 3 and abandoned at
  step 4.

## Where this landed (2026-09-01, evening)

| Item | PR | What actually shipped |
| --- | --- | --- |
| 1 Validator | #938 | `validateFlowFiles` + `pnpm flows:validate`. **The CLI lives in this repo, which the person in the scenario does not have** — reachable only via item 2's tool. |
| 2 Dry-run | #937, #944 | `dryRunFlowReconcile` shipped in #937 with **zero non-test callers**. #944 gave it a caller: `check_flow_files`, one MCP-bridged tool that validates, hydrates the row and `validateSync()`s it, and plans against running streams. It reads the rest of `flows/` itself, so a partial input cannot manufacture a phantom teardown; its `guard` verdict is `unevaluated` pre-push rather than a laundered "verified". |
| 3 Webhook endpoint | #939 | Minted on create from `workspaceId` + `_id`. No secret from the file, by design. |
| 4 Discovery | #940 | `list_connectors`, `inspect_connector` bridged. |
| 4b Secret path | #943 | `applySchemaEncryption` fails closed: misconfigured key → 500 and nothing written, not 201 and plaintext. |
| 5 "Make it live" | #942 | **The create path had never once worked.** `createdBy` is required on the schema and the sync never set it; `save()` threw and the throw escaped the per-file loop, so the first new file in a push created nothing and skipped the reconciler. Gap 5 was "unproven" because it was impossible. Fixed; verified in production the same evening — an inert probe file created its row 6 s after push, 0 streams touched. |
| 6 Skill | this PR | `api/src/agent-skills/flows-as-code/SKILL.md`. A **system** skill, not a workspace one as first proposed: the knowledge is platform-wide, and system skills reach a local Claude Code over MCP via `list_skills` / `load_skill` without anything in the workspace repo. |
| — | #945 | Found while building #944: a YAML typo in an existing flow's file was a **teardown** — the row was dropped from the desired set and the reconciler read that as a removal. The row's own definition now stands in for an unparseable file. |

**Gap 3 remains open.** Nothing creates a connector headlessly; the skill says
so and routes the agent to the UI for that one step. It is a credential-
accepting tool over MCP and needs the auth-tier decision from "Open questions"
before it is built, not after.

**Changed since first written:** the skill's home (system skill, above), and
the claim that "steps 4–6 exist and were verified in production" — step 6 had
been verified for edits to existing flows only; for a new file it did not
work at all until #942.

## Related

- RFC #904 — flows as code (blocks 1–4 shipped 2026-09-01)
- apps.md §22 — skills live in the workspace repo
- apps.md §25 — four times "done" was wrong; the verification discipline this
  RFC's sequencing is built around
