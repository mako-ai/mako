# RFC: Endorsements and Endorsed Mode — telling the agent what to trust

**Status:** draft
**Written from:** the code as it stands at `f0ab587`, plus Hex's public docs
(Threads, Notebook Agent, Context Studio). Not yet validated against a
production census — see "Open questions".
**Related:** `rfcs/context-improvement-loop.md`, `rfcs/apps-as-agent-context.md`

## The problem

When a user asks "what was revenue last month?", Mako's agent can reach many
candidate sources: saved consoles, dashboards, apps, dbt models, raw warehouse
tables. Today it picks among them by **recency or text match**:

- `search_dashboards` matches title/description/data-source name by regex and
  sorts by `updatedAt` (`agent-lib/tools/dashboard-search-tools.ts`).
- `search_consoles` ranks by embedding score (`console-search-tools.ts`).
- Skills rank by a keyword score (`services/skills.service.ts`).

None of these has a notion of **"this one is the canonical answer."** A
half-finished scratch console that mentions "revenue" competes equally with the
one the finance team reviews. The agent cannot be told "only use vetted
sources" either, which is what a non-technical or customer-facing surface
needs.

Hex solves this with two controls: **endorsement** (an admin marks an asset
canonical; agents prioritise it) and **Endorsed Mode** (agents may use *only*
endorsed assets). Their Threads agent "heavily prioritizes endorsed and
semantically modeled data."

## Goals / non-goals

**Goals**

1. A single, explicit trust signal an admin can set on the things the agent
   reads.
2. Ranking: endorsed beats unendorsed in every discovery tool.
3. A workspace-level strict mode that restricts the agent to endorsed assets.
4. The signal is reviewable and revertible, like everything else we keep in git.

**Non-goals**

- Automatic endorsement. Trust is a human decision. (Published apps get a
  *ranking tier*, not endorsement — see the apps RFC.)
- A full semantic layer. Endorsement says "trust this"; it does not define
  metrics. That is a separate, larger RFC.
- Row/column-level security. Endorsement is about preference, not access;
  `app-authorization` and workspace roles still decide who may read what.

## What already exists

- **Git is the source of truth for the file-shaped entities** (consoles
  apps.md §16, apps via `mako.json`, skills, flows, dbt). Mongo holds a derived,
  disposable index, rebuilt per push (`apps/app-index.service.ts`).
  `SavedConsole` already carries an "authored in front-matter vs generated"
  distinction for its description.
- **Dashboards are Mongo-native** (`Dashboard`, `workspace-schema.ts`), not
  files.
- **Warehouse tables are not Mako entities at all.** They are discovered live
  through `list_tables` / `inspect_table`.
- **Tool tiers are enforced.** A new tool must be classified core / mode /
  deferred, and MCP exposure is classified in `mcp/bridge-policy.ts`; tests fail
  on anything unclassified. Any new tool in this RFC must go through both.

## Design

### 1. One concept, two homes

Where the signal lives follows where the entity lives. This is the whole
design.

| Entity | Home of `endorsed` | Why |
|---|---|---|
| Console, app, skill, flow, dbt model | **File front-matter / manifest** (`endorsed: true`, plus `endorsedBy`, `endorsedAt` stamped by the API on merge) | Git is authoritative; the index row is derived. A review on the diff *is* the approval workflow. |
| Dashboard | **Mongo field** on `Dashboard` | No file to put it in today. Revisit if dashboards move to git. |
| Warehouse table / dbt model output | **`context/endorsements.yml`** in the workspace repo, keyed by `connectionId` + qualified name | Tables have no row or file of their own; this gives them one without inventing a collection. |

Endorsement is **not** self-service: setting it requires an admin/manager role.
For file-based entities this means the API rejects (or strips) an `endorsed`
change from a non-privileged pusher, the same way flow sync already uses a
fail-closed assertion for destructive changes. A contributor can *propose* it
in a PR; it does not take effect until a privileged merge.

### 2. Ranking

Every discovery tool gets the same ordering rule:

```
endorsed  >  published (on main)  >  saved  >  draft / branch / scratch
```

then the existing relevance score within a tier. Concretely:

- `search_dashboards`: add `endorsed` as a sort key before `updatedAt`.
- `search_consoles`: multiply or tier the vector score; do not let a strong
  semantic match on a scratch console outrank a decent match on an endorsed one
  without the user being told.
- `get_relevant_skills`: add the endorsement boost to `keywordScore`.
- Result objects gain `endorsed: boolean` so the model can say so in its answer
  ("from the endorsed *Finance — MRR* console").

### 3. Endorsed Mode

A workspace setting `agentSourcePolicy: "any" | "prefer-endorsed" | "endorsed-only"`.

- `any` — today's behaviour.
- `prefer-endorsed` — ranking only. **Proposed default**, since it is free and
  strictly improves answers.
- `endorsed-only` — discovery tools filter to endorsed; `sql_execute_query`
  against an unendorsed table is refused with a message that names the
  endorsed alternatives, not a bare error.

The mode can be narrowed per surface (e.g. a future Q&A mode or a Slack
integration forced to `endorsed-only` while the analyst chat stays `any`),
because the policy is read at tool-construction time from the execution
context, next to `workspaceId`.

### 4. Enforcement point

The risk in "only use endorsed" is a hole: the agent writes SQL by hand against
a raw table and nothing checks it. Two layers:

1. **Discovery filtering** — the cheap, always-on layer above.
2. **Query gating** — in `endorsed-only`, `sql_execute_query` /
   `run_console` parse the referenced tables and refuse unendorsed ones. This
   is advisory-strong, not a security boundary (a determined user can still
   open the UI console); it must be documented as governance, not access
   control.

### 5. UI and MCP

- A small "Endorse" action and badge wherever the entity already appears
  (console list, dashboard list, schema tree). The tree badge matters most: the
  agent and the human both see which table is canonical.
- MCP gets the ranking for free (shared tool factories). Setting endorsement
  over MCP is **excluded** in `bridge-policy.ts` (`security`) initially — an
  external agent should not be able to bless its own output.

## Sequencing

1. **Schema + ranking, no enforcement.** Field on the file entities and
   dashboards, `endorsed` in search results, tiered sort. Ships behind no flag;
   it only reorders.
2. **UI badge + admin action.** Without this nobody sets it, and step 1 does
   nothing.
3. **`context/endorsements.yml` for tables**, and the schema-tree badge.
4. **`agentSourcePolicy` setting** with `prefer-endorsed` default.
5. **`endorsed-only` query gating**, last, because it is the only step that can
   break a working flow and needs the interaction records from the context improvement loop RFC to debug.

## Open questions

- **Granularity for tables.** Endorse a table, a column, or a dbt model? Start
  with table; columns are where a semantic layer takes over.
- **Staleness.** An endorsed console whose underlying table was dropped is
  worse than an unendorsed one. Should the index mark endorsement
  `suspect` when a referenced table disappears or the file's blob changes after
  endorsement? (Leaning yes: endorsement binds to a blob SHA and lapses on edit
  unless re-confirmed.)
- **Who may endorse?** Workspace admin only, or a `data-steward` role? Mako's
  current role set decides how much this costs.
- **Does `endorsed-only` apply to the user's *own* private consoles?** Likely
  yes for the agent, no for the human typing SQL themselves.
- **Is front-matter a good home for per-user private-scope apps?** An endorsed
  private app is a contradiction; endorsement should be rejected outside
  `workspace` scope.

## Risks

- **A trust signal nobody maintains is worse than none.** If 80% of assets are
  endorsed on day one, the ranking carries no information. Ship the UI so
  endorsement is a deliberate act, and let the improvement loop surface unendorsed
  assets being used so admins know what to endorse next.
- **False confidence.** "Endorsed" must not read as "correct." The agent should
  say *which* source it used, not that the answer is verified.
