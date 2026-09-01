# RFC: Agent-authored flows — "add a Stripe connector and sync it to BigQuery"

**Status:** proposed
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
| Webhook endpoint | Mongo | inbound URL identity external systems POST to; must survive a rename |

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
gets `enabled: true`, no endpoint and no secret: Stripe has nowhere to POST. It
is a dead flow that looks configured.

**17 of 31 production flows are webhook**, so this is the common case, not the
edge. The fix is narrow — mint an endpoint when a row is created from a file,
never on update — but it must exist before an agent can author one.

### 3. `create_data_source` is classified for a world that changed

`bridge-policy.ts:245` reads:

```ts
create_data_source: exclude("client-only", "Dashboard builder UI."),
```

That was right when connectors were made in a form. In this scenario the caller
is a local Claude Code with a scoped key, and the form is not involved.

Note what should stay excluded: `create_flow_tab` (:198), `list_flow_tabs`
(:223), `get_form_state` (:210), `set_form_field` (:224) and
`set_multiple_fields` (:228) all read or write **the open flow form in the
UI**. **The file replaces every one of them.** Claude does not drive the form;
it writes the definition. That is the elegant part of
this design and it means the MCP surface grows by roughly one tool, not six.

### 4. The agent cannot invent an ObjectId

A definition references a connector id and a destination connection id. The
agent needs to *discover* them, plus the entities a connector offers and the
BigQuery datasets available. Some read tools exist; the set has not been walked
against this specific task.

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

Ships in `skills/` in the workspace repo, so it is present the moment someone
opens Claude in their checkout. It carries:

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

## Related

- RFC #904 — flows as code (blocks 1–4 shipped 2026-09-01)
- apps.md §22 — skills live in the workspace repo
- apps.md §25 — four times "done" was wrong; the verification discipline this
  RFC's sequencing is built around
