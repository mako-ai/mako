# RFC: Published apps as agent context — close the loop between building and answering

**Status:** draft
**Written from:** the code as it stands at `f0ab587`, plus Hex's description of
the "improvement loop" (published apps and dashboards feed the agent with
reusable logic). Not yet validated against production.
**Depends on:** `rfcs/endorsements.md` (trust tiers). **Complements:**
`rfcs/context-improvement-loop.md`.

## The problem

Mako has a build path: someone (often the agent) writes an app, its bindings
(`bindings/<name>.sql`) are validated against the warehouse, and a merge to
`main` publishes it. That work encodes **decisions** — which table is the
source of truth for revenue, how a funnel is cut, which filters are applied —
and the people who made them reviewed the result.

The next agent that gets "what's our conversion by channel?" cannot see any of
it:

- `app_list_apps` lists apps; there is no search over their *content*
  (`agents/modes/registry.ts` has `search_consoles` and `search_dashboards`, no
  app equivalent).
- The apps index stores `title`, `description`, `schedules`, `treeOid`
  (`IAppIndexEntry`, `apps/app-index.service.ts`) — enough for a sidebar, not
  for retrieval of *logic*.
- Consoles have embeddings and generated descriptions
  (`descriptionEmbedding`, `descriptionSource`); apps and their bindings have
  none.

So every question re-derives the logic from raw tables, and can disagree with
the dashboard the CFO already looks at. Hex describes the opposite loop —
"accuracy improves with every answer" because published work becomes reusable
context. We already pay the cost of producing that work and then throw away
its value as context.

## Goals / non-goals

**Goals**

1. Published (merged-to-main) apps become **searchable by what they compute**,
   not just by title.
2. The agent can answer "how is X computed here?" from the app's own validated
   binding, and cite it.
3. Published work ranks above scratch work in discovery, below *endorsed* work.
4. No new source of truth: the derived read model stays derived and
   rebuildable.

**Non-goals**

- Auto-endorsing published apps. Publishing is "someone shipped this";
  endorsing is "we vouch for it." Different bars, different tiers.
- Letting the agent *execute* an app's bindings as a black box. It reads the
  logic and may reuse the SQL; running is still ordinary governed query
  execution.
- Indexing branches or drafts. Only `main`.

## What already exists

- **A push-driven derived index.** `app-index.service.ts` reads the tree at
  `main` once per push and writes one row per app; the doc comment says rows are
  disposable ("drop the collection and the next read rebuilds it"), and
  `treeOid` equality skips rebuilds of unchanged apps. This is exactly the hook
  to extend.
- **A proven description + embedding pipeline for consoles:**
  `descriptionSource: "authored" | "generated"`, `descriptionSourceSha`,
  generated only while the blob SHA has moved (apps.md §16.4),
  `embedding.service.ts`, a vector index `console_embeddings`, a
  `search_consoles` tool that falls back when vectors are unavailable. We reuse
  this, not reinvent it.
- **Bindings are plain files** (`bindings/<name>.sql` with front-matter,
  `bindings.service.ts` `parseBindingFrontMatter`), so their SQL and declared
  description are readable straight from the indexed tree.
- **Scope already modelled.** `scope: "workspace" | "private"` and `ownerId`
  on the index row distinguish shared apps from `users/<id>/apps`.

## Design

### 1. Index bindings, not just apps

Add a second derived collection, `app_binding_index`, one row per binding of a
published app:

```ts
interface IAppBindingIndexEntry {
  workspaceId: ObjectId;
  appId: string; appPath: string; appTitle: string;
  bindingName: string;
  sql: string;                         // truncated for storage, full text read on demand
  connectionId?: ObjectId;
  tablesReferenced: string[];          // parsed; ties into endorsements + the improvement loop
  description?: string;
  descriptionSource: "authored" | "generated";
  descriptionEmbedding?: number[]; embeddingModel?: string;
  sourceBlobSha: string;               // same skip-if-unchanged rule as consoles
  scope: "workspace" | "private"; ownerId?: string;
  indexedSha: string;                  // the main commit it was built from
}
```

Built by the same per-push pass that writes `app_index`, gated on `treeOid`
change. Description generation follows the console rule (authored in
front-matter wins; otherwise LLM-generated while the blob is stale), run off
the push path like console descriptions are.

### 2. One discovery tool: `search_apps`

Returns apps and, within each, the bindings that matched, with the SQL excerpt
and the tables referenced:

- Vector search on binding description embeddings with the existing keyword
  fallback.
- Result carries `tier: "published"`, `endorsed`, `appPath`, `bindingName`,
  `tablesReferenced`, and `indexedSha`.
- Classify per the repo rules: a **mode/deferred** tier decision in
  `agents/modes/registry.ts` (the tier-policy test fails otherwise) and an
  explicit entry in `mcp/bridge-policy.ts`. Read-only, so **bridged** to MCP,
  where "find how revenue is computed" is exactly what Claude Code wants.

### 3. Ranking tiers

Shared with the endorsements RFC:

```
endorsed  >  published (main)  >  saved  >  draft / branch / scratch
```

Published apps join `search_consoles`/`search_dashboards`-style discovery as the
second tier. Within a tier, relevance. An endorsed binding (front-matter
`endorsed: true`) is promoted accordingly.

### 4. The agent's behaviour

A short rule in the existing agent skill rather than the base prompt
(`.cursor/rules/35-agent-prompts.mdc`: base prompts stay lean; guidance lives
in `api/src/agent-skills/**`). A `searching-existing-work` section in a skill:
before writing new SQL for a business question, `search_apps` / `search_consoles`;
if a published binding already answers it, reuse and cite it; if the user's ask
differs, say how.

### 5. Access control — the part that must not be wrong

This indexes *logic* that people wrote, so leaks are the main risk:

- **Never index non-`main` content.** Branches and WIP are out of scope by
  construction; the index reads `main` only, as today.
- **`private` scope is filtered by `ownerId`.** A search by user B must never
  return user A's `users/<A>/apps/**` bindings, in chat or over MCP. Needs a
  test modelled on `apps/app-authorization.test.ts` and `adversarial.test.ts`.
- **Connection access still applies.** A binding that targets a connection the
  caller cannot use should not surface its SQL excerpt; return a stub.
- **API-key scopes.** `search_apps` over MCP respects the key's scopes
  (`query:read`) as bridged read tools already do.
- Workspace scoping on every query (project principle 1).

### 6. Improvement-loop link

When the agent reuses a binding, the interaction record (context improvement loop RFC) records
`{kind: "app", ref: appId, via: "search_apps", blobSha}` plus the tables
referenced. This closes the loop: admins see which published apps are actually
carrying answers and are therefore the best endorsement candidates, and which
bindings are stale relative to their sources.

## Sequencing

1. **Index bindings** into `app_binding_index` (no tool yet). Verify rebuild
   from empty reproduces rows, and `treeOid` skips unchanged apps.
2. **Descriptions + embeddings** reusing the console pipeline; confirm
   generation runs off the push path.
3. **`search_apps` tool** with tier classification and MCP bridging, with the
   scope/ACL tests landing in the same PR, not after.
4. **Ranking integration** once the endorsements RFC's tier field exists.
5. **Skill guidance** telling the agent to look before it writes.

## Open questions

- **Staleness.** A published binding can silently rot (source table renamed,
  metric definition changed). Surface `indexedSha` age and referenced-table
  existence; consider demoting bindings whose tables no longer resolve.
- **Is a binding the right unit, or the app?** Questions map to a query, but
  context (filters in the UI, parameterisation in the React code) lives
  outside the `.sql`. Start with bindings; revisit if answers need app-level
  context.
- **Vector index cost and Atlas limits.** Another `$vectorSearch` index per
  collection; check what the dev/prod clusters allow before committing to a
  separate collection versus extending `app_index`.
- **Parsing `tablesReferenced` across dialects.** Needed for endorsements
  gating and the improvement loop both. Reuse any existing SQL parsing in the
  codebase before adding a dependency; this is shared infrastructure with the
  other two RFCs and should be built once.
- **Dashboards.** They are Mongo-native and already searchable by regex. Do they
  get the same embeddings treatment now, or wait for the semantic search work
  to land for apps first?

## Risks

- **Reinforcing mistakes.** If a published binding is wrong, the agent now
  propagates it faster. The endorsement tier and the improvement loop's signals are
  the counterweight; ship this RFC after, or alongside, endorsements, not before.
- **Prompt bloat.** Returning SQL excerpts for many bindings into context is
  expensive. Cap results and excerpt length; the tool-weight tool
  (`pnpm --filter api tools:measure`) should be run on the new tool.
