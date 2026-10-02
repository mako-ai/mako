# RFC: Answer provenance — an audit trail for every agent answer

**Status:** draft
**Written from:** the code as it stands at `f0ab587`, plus Hex's Context Studio
(usage observability and answer audit trail). Not yet validated against
production data.
**Related:** `rfcs/endorsements.md`, `rfcs/apps-as-agent-context.md`

## The problem

When the agent gives a wrong or suspicious answer, nobody can answer the
question **"what did it actually use?"** without reading the raw transcript:

- `Chat.messages[].parts` and `toolCalls` hold the transcript
  (`workspace-schema.ts`, `IChat`). That is a log, not an index: you cannot ask
  "which chats used the *deprecated_orders* table?" or "which skill was loaded
  when this went wrong?"
- **MCP and API-key clients have no `Chat` at all.** Claude Code, Cursor and
  ChatGPT connectors reach Mako through `POST /api/mcp`
  (`mcp/mako-mcp-server.ts`); their tool calls are not persisted anywhere a
  workspace admin can see.
- Langfuse tracing exists (`observability/langfuse.ts`) but is an operator tool:
  not tenant-scoped, not exposed to workspace admins, not shaped around
  "which sources shaped this answer."

Hex's Context Studio treats this as a product surface: for each question it
shows *where it was asked* (Slack, Claude, Cursor, Hex), *which context sources
shaped the answer*, and *warnings when the agent was confused or missing
information*. We have the raw material and none of the surface.

## Goals / non-goals

**Goals**

1. For every agent answer, a structured, queryable record of the sources it
   touched, the skills it loaded, and the channel it came through.
2. The same record whether the answer came from the in-product chat, the
   desktop agent, or an MCP/API-key client.
3. Surface *signals of doubt* (no matching source, ambiguous match, unendorsed
   source used, query error then retry) so an admin can see where context is
   weak.
4. Cheap enough to be always on.

**Non-goals**

- Replacing Langfuse. Traces stay the operator's debugging tool; this is the
  workspace admin's product view.
- Storing result data. The record holds *references* (ids, table names, blob
  SHAs), never rows or credentials.
- Judging answer correctness. That is the evals RFC (not this one).

## What already exists

- **A common tool seam.** In-product tools and MCP share server-side tool
  factories; each tool brackets its work with `registerAgentExecution` /
  `release` (`agent-lib/tools/shared/truncation.ts`) and receives an
  `AgentToolExecutionContext`. That is the natural place to emit a trace
  event, and it already runs for both surfaces. **To verify before building:**
  that every tool, including those wired directly in `mako-mcp-server.ts` and
  the ChatGPT `search`/`fetch` pair, goes through it.
- **Post-stream finalization is already async and non-blocking**
  (`routes/chat-finalization-queue.ts`, with a test asserting it must stay
  non-blocking). A trace write belongs there, not on the streaming path.
- **Usage accounting** (`services/llm-usage.service.ts`, `IChat.usage`) already
  tracks tokens per chat, so a per-answer record can reuse its identifiers.
- **Skills load through tools** (`load_skill`, `get_relevant_skills`), so
  "which skills shaped this answer" is observable at the tool boundary rather
  than inferred from the prompt.

## Design

### 1. A separate collection, not more fields on `Chat`

`AnswerTrace`, one document per **assistant turn** (an MCP "turn" is one
session-scoped tool-call burst closed by inactivity or an explicit marker):

```ts
interface IAnswerTrace {
  workspaceId: ObjectId;
  channel: "chat" | "desktop-acp" | "mcp" | "api-key" | "slack"; // + client name
  clientName?: string;            // from MCP initialize.clientInfo, e.g. "claude-code"
  principal: { userId?: string; apiKeyId?: string };
  chatId?: ObjectId; messageId?: string;   // absent for MCP
  startedAt: Date; finishedAt?: Date;
  question?: string;              // first user message / first tool intent; redactable
  sources: Array<{
    kind: "console" | "dashboard" | "app" | "skill" | "flow" | "table" | "dbt-model";
    ref: string;                  // id, or connectionId + qualified table name
    via: string;                  // tool that touched it, e.g. "search_consoles", "inspect_table"
    endorsed?: boolean;           // stamped at touch time (see endorsements RFC)
    blobSha?: string;             // exact version of a git-backed source
  }>;
  signals: Array<{ code: SignalCode; detail?: string }>;
  toolSummary: { calls: number; errors: number; byTool: Record<string, number> };
}
```

Why separate: `Chat` embeds the whole message array, which is already large and
carries mid-turn checkpoints; adding a growing second structure to the hottest
document in the system is the wrong direction. A separate collection also
serves MCP, which has no chat, and can have its own retention.

### 2. Capture

A thin wrapper on tool execution appends `{kind, ref, via, endorsed, blobSha}`
to an in-memory accumulator on the `AgentToolExecutionContext`. Tools that
resolve an entity already know its id; the wrapper needs a per-tool
`describeSources(input, output)` hook, defaulting to nothing. Start with the
discovery and query tools (`search_*`, `list_tables`, `inspect_table`,
`sql_execute_query`, `run_console`, `load_skill`, `app_list_apps`); the long
tail can follow. The accumulator is flushed through the finalization queue.

This is deliberately **opt-in per tool** rather than a blanket wrapper: a
blanket wrapper records tool names, which is exactly the transcript we already
have. The value is the *resolved entity*.

### 3. Signals of doubt

Derived, cheap, and the point of the feature:

| Code | When |
|---|---|
| `no-source-match` | a discovery tool returned zero results and the agent proceeded anyway |
| `ambiguous-match` | top two results within a small score margin, neither endorsed |
| `unendorsed-used` | a query ran against a table/console that is not endorsed |
| `query-retry` | SQL errored, was rewritten, re-ran (agent flailing) |
| `skill-missing` | `get_relevant_skills` returned nothing for a domain term |
| `endorsed-bypassed` | an endorsed alternative existed in search results but was not used |

`endorsed-bypassed` and `unendorsed-used` only exist once endorsements ship,
which is why the sequencing below puts provenance *second*.

### 4. Surface

- **Per answer (user-visible):** a collapsed "Sources" footer on the message —
  the entities used, endorsed badges, clickable to open. This is the
  Threads-style citation and it is what builds trust with non-technical users.
  Data comes from the trace, not from re-parsing the transcript.
- **Admin view (workspace settings):** a table of recent traces filterable by
  channel, source, and signal; a "most-used unendorsed sources" and
  "most common signals" roll-up. This is the input to the endorse-next-thing
  workflow and to any future automated review agent.
- **MCP:** no new tool initially. Traces are written for MCP callers but only
  surfaced in the admin UI.

### 5. Privacy, access, retention

- Traces are **workspace-scoped** and visible to admins only; a user sees the
  Sources footer on their own answers. Every query filters on `workspaceId`
  (project principle 1).
- `question` can contain customer text. Make it truncated and
  admin-only, and give workspaces a retention setting (default 90 days) via a
  TTL index. Never store query results or credentials; `sources` are refs.
- An MCP trace records `apiKeyId`/`userId`, never the key.

## Sequencing

1. **Model + capture for four tools** (`search_consoles`, `search_dashboards`,
   `sql_execute_query`, `load_skill`) + finalization-queue write. No UI. Verify
   MCP and chat produce the same shape.
2. **Sources footer in chat.** First user-visible value, and it exercises the
   data for real.
3. **Admin view with signals**, once endorsements exist so the interesting
   signals can fire.
4. **Widen `describeSources` coverage** and add retention controls.

## Open questions

- **Turn boundaries for MCP.** There is no assistant "message" on that surface.
  Group by (session, quiet period)? By explicit `trace` hint from the client?
  Wrong grouping makes the admin view noisy.
- **Do we persist `question` at all for MCP clients?** An external agent's
  tool-call arguments are not the user's question, and may be sensitive.
  Possibly store only tool-derived intent for that channel.
- **Cost at volume.** One document per answer is small, but a busy MCP client
  could emit many. Needs a sampling or coalescing rule before launch.
- **Where do warehouse tables get a stable `ref`?** `connectionId` + qualified
  name works until a table is renamed; acceptable for a log.
- **Is a dedicated collection justified, or should this ride on Langfuse
  with a tenant-scoped export?** Leaning own collection: the admin UI and the
  signals need first-party queryability and tenant isolation.

## Risks

- **Instrumentation drift.** Opt-in per tool means a new tool silently produces
  no provenance. Mitigate like the existing tier policy: a test that lists tools
  with no `describeSources` decision, so skipping is deliberate.
- **Blocking the stream.** Any synchronous work on the streaming path breaks the
  invariant `chat-finalization-queue.test.ts` guards. All writes go through the
  queue.
- **Signals that cry wolf.** `ambiguous-match` thresholds need tuning against
  real traces; ship the signals as informational, not alerts.
