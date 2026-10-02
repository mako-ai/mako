# RFC: Context improvement loop — the agent's context gets better from how it is used

**Status:** draft
**Written from:** the code as it stands at `f0ab587`, plus Hex's Context Studio
(usage observability, a Review Agent that suggests context fixes, evals before
shipping a change). Not yet validated against production data.
**Depends on:** `rfcs/endorsements.md` (a thing to promote and a trust signal to
read). **Complements:** `rfcs/apps-as-agent-context.md` (a source of context to
improve).

## The problem

Mako's agent quality is bounded by its context: skills, workspace prompt,
saved-console descriptions, endorsements, published apps. That context is
written once, by whoever had the time, and then **nothing tells its owners where
it is failing.**

- When the agent flails ("I couldn't find a table for X", three failed queries,
  the user rewrites its SQL), the evidence is buried in a chat transcript nobody
  reads. MCP and API-key clients leave no transcript in Mako at all.
- Fixing it is a manual loop: someone notices, guesses which skill or
  description to change, edits it, and hopes. There is no way to know the edit
  helped or hurt the questions that already worked.
- The context we *do* maintain automatically (generated console descriptions,
  `descriptionSource: "generated"`) is derived from the artifact alone, never
  from how people actually ask about it.

Hex closes this loop explicitly. Context Studio watches usage across Slack,
Claude, Cursor and Hex; a **Review Agent** reads interactions, finds gaps and
proposes concrete fixes so admins do not have to audit conversations; and
**evals** test a change before it ships ("improve context with evidence, not
instinct"). The result, in their words, is accuracy that improves with every
answer.

## Goals / non-goals

**Goals**

1. Capture, for every agent interaction on every surface, enough structure to
   tell whether context helped or failed.
2. Turn those interactions into a **queue of concrete, reviewable
   suggestions** ("add this description", "write a skill for this metric",
   "endorse this console") rather than a dashboard of charts.
3. Suggestions land as **ordinary diffs to git-backed context**, reviewed and
   revertible like everything else we keep in the workspace repo.
4. A change can be tested against known-good questions before it ships.

**Non-goals**

- Autonomous self-modification. A human accepts every suggestion. The agent
  never edits the context that governs itself without review.
- Training or fine-tuning on customer data. Suggestions are derived within the
  workspace and applied to the workspace's own files.
- Judging answer correctness in the abstract. We use observable signals and
  user-supplied expected results, not a model's opinion of the answer.

## What already exists

- **Context is already files in git.** Workspace skills (`services/skills.service.ts`:
  `saveSkill`, pinned/suppressed state), the workspace prompt and self-directive
  (`apps/workspace-prompt.ts`, `routes/custom-prompt.ts` — committed to the repo),
  console descriptions with an `authored | generated` split, and soon
  `context/endorsements.yml`. So "a suggestion" can be a normal commit or PR.
- **System skills ship in the repo** (`api/src/agent-skills/**`) and reach MCP
  clients through `list_skills` / `load_skill`, so a fix to shared knowledge is a
  PR to this repo, not a per-workspace edit. The loop must distinguish the two
  targets (see below).
- **Skill retrieval is observable.** `retrieveRelevantSkills` returns hits with
  scores; "nothing matched" is a first-class result, not an inference.
- **Background work has a home.** Inngest functions (`inngest/functions/*`) run
  durable, retryable jobs; the finalization queue
  (`routes/chat-finalization-queue.ts`) already defers post-turn work off the
  streaming path, with a test that it must stay non-blocking.
- **Tool classification discipline** (`agents/modes/registry.ts`,
  `mcp/bridge-policy.ts`) means any tool this adds is deliberately placed, and
  excluded from MCP by default.
- **Langfuse** (`observability/langfuse.ts`) traces LLM calls for operators. It
  is not tenant-scoped or shaped for this and stays the operator's tool.

## Design

The loop has four stages: **capture → detect → propose → verify.** Each is
separable and useful alone.

### 1. Capture: an interaction record per answer

A new collection, `AgentInteraction`, one document per assistant turn on any
surface. It is deliberately a *record of context use*, not a transcript copy:

```ts
interface IAgentInteraction {
  workspaceId: ObjectId;
  channel: "chat" | "desktop-acp" | "mcp" | "api-key" | "slack";
  clientName?: string;                // e.g. "claude-code" from MCP initialize
  principal: { userId?: string; apiKeyId?: string };
  chatId?: ObjectId; messageId?: string;   // absent for MCP
  startedAt: Date; finishedAt?: Date;
  question?: string;                  // truncated, admin-only, redactable
  contextUsed: Array<{
    kind: "skill" | "console" | "dashboard" | "app" | "flow" | "table" | "prompt";
    ref: string;                      // id, or connectionId + qualified name
    via: string;                      // tool that surfaced it
    endorsed?: boolean; blobSha?: string;
  }>;
  signals: Array<{ code: SignalCode; detail?: string }>;
  outcome?: "accepted" | "edited" | "abandoned" | "thumbs-up" | "thumbs-down";
}
```

Capture is opt-in per tool at the existing tool-execution seam
(`registerAgentExecution` in `agent-lib/tools/shared/truncation.ts`), flushed
through the finalization queue so the stream is never blocked. The seam is
shared with MCP because tool factories are shared.
**To verify before building:** that every tool, including those wired directly
in `mako-mcp-server.ts` and the ChatGPT `search`/`fetch` pair, reaches it.

`outcome` is the weak spot and the most valuable field. Cheap, honest signals
only: explicit thumbs; the user re-running or rewriting the agent's SQL; the
user abandoning after a query error. Where nothing observable exists, leave it
empty rather than guess.

Signals of doubt, derived at capture time:

| Code | When |
|---|---|
| `no-source-match` | a discovery tool returned nothing and the agent proceeded anyway |
| `ambiguous-match` | top results within a small margin, none endorsed |
| `skill-missing` | `get_relevant_skills` returned nothing for a domain term |
| `query-retry` | SQL errored, was rewritten, re-ran |
| `unendorsed-used` / `endorsed-bypassed` | needs endorsements |
| `user-corrected` | the user edited or replaced the agent's query |

### 2. Detect: cluster failures into gaps

A scheduled Inngest job reads recent interactions per workspace and groups the
ones with failure signals into **gaps**. A gap is a *recurring* situation, not a
single bad answer:

- "Questions mentioning *MRR* hit `no-source-match` 9 times this month."
- "`orders_v2` is used unendorsed in 14 answers; `orders` (endorsed) was
  bypassed in 11."
- "Console *Weekly signups* is found often but its description does not mention
  the *trial* filter users keep correcting."

Detection is mostly counting and grouping on structured fields — no model needed
for the first version. A model is used only to **label and merge** near-duplicate
gaps. A minimum-occurrence threshold keeps one bad day from creating work.

### 3. Propose: a Review Agent writes concrete fixes

For each gap above threshold, a **Review Agent** — a normal agent run in a
restricted mode with read-only tools plus one write tool — drafts a *specific*
suggestion with its evidence:

| Fix | Lands as |
|---|---|
| Better console/binding description (add the missing term, filter, grain) | front-matter diff on the console/app file (`descriptionSource: "authored"`) |
| New or amended workspace skill | `saveSkill` diff in the workspace repo |
| Add a glossary line to the workspace prompt | diff to the committed workspace prompt file |
| Endorse a canonical console/table | `endorsed: true` / `context/endorsements.yml` diff |
| Deprecate a stale source the agent keeps picking | description note and/or un-endorse |
| Gap in **shared** knowledge (dialect quirk, vendor behaviour) | *not* applied; surfaced to Mako maintainers as a candidate for `api/src/agent-skills/**` |

Each suggestion stores: the diff, the interactions that motivated it (links, not
copies), the expected effect, and a status (`open | accepted | dismissed |
shipped`). Presentation is a **review queue**, not a dashboard: accept / edit /
dismiss, with the evidence one click away.

Hard rules:

- **Review, always.** Accepting opens a branch/PR against the workspace repo
  through the existing repo plumbing, or commits directly only where the
  workspace already allows an admin to. Nothing is applied silently.
- **Respect prompt hygiene** (`.cursor/rules/35-agent-prompts.mdc`): suggestions
  default to *skills and descriptions*, not additions to always-on prompt text.
  The prompt target exists but is the last resort and is size-checked against
  `agents/prompt-size.test.ts`'s budget.
- **The Review Agent reads interaction records and context files, not result
  data.** Questions can contain customer text and cell values can carry prompt
  injection; its output is a *proposed diff for a human*, which bounds the blast
  radius, and its write tool can only create a suggestion row.
- **The Review Agent is excluded from MCP** in `bridge-policy.ts`
  (`in-product-only`).

### 4. Verify: evals before and after

A suggestion is stronger with evidence than with a model's confidence. A
workspace keeps an **eval set**: question → expected outcome. Expected outcomes
are one of:

- an expected source (this console / table should be used),
- an expected result (a saved query or value the answer must reproduce), or
- an expected *absence* (must not use this deprecated table).

Where eval items come from, cheapest first: (a) the admin pins an answer they
trust ("turn this into a test"); (b) interactions with positive outcomes are
*offered* as candidates, never auto-added; (c) the Review Agent proposes
questions alongside a fix, for approval.

Running the set before a context change ships is optional in v1 (it needs
cost limits and a way to execute the agent deterministically enough to compare
runs). The plumbing, however, should be designed in from the start: a
suggestion records which eval items it should flip and which must not regress.
Stable pass/fail on those is what lets us eventually auto-queue low-risk fixes
with confidence.

### 5. Surface and access

- **Admin only**, workspace-scoped, every query filtered by `workspaceId`
  (project principle 1). A member sees only the effect: better answers.
- A **Context** settings page: review queue first, then gaps, then an
  interaction browser filterable by channel / source / signal. The interaction
  browser doubles as the per-answer "what did it use" view for debugging.
- A per-answer **Sources** footer in chat is a natural by-product (the record is
  the citation) and the point where thumbs capture is added, but it is a
  separate piece of UI and may ship independently.
- Retention: TTL on interactions (default 90 days); suggestions and eval items
  are kept until resolved. `question` is truncated and admin-only; no result rows
  or credentials are ever stored — `contextUsed` holds references.

## Sequencing

1. **Capture, no UI.** Model + opt-in capture for a handful of tools
   (`search_consoles`, `search_dashboards`, `sql_execute_query`, `load_skill`,
   `get_relevant_skills`) via the finalization queue. Check MCP and chat emit
   the same shape. This is the prerequisite for everything and is useful alone
   to the operator.
2. **Interaction browser + Sources footer.** First visible value, and it
   exercises the data for real.
3. **Gap detection (no model).** Counting and grouping job; admin sees "gaps"
   with evidence. A useful product even if nothing is ever auto-suggested.
4. **Review Agent and suggestion queue**, starting with the two lowest-risk fix
   types: console descriptions and endorsement proposals.
5. **Skills and prompt-glossary suggestions** and the maintainer-facing "shared
   knowledge" channel.
6. **Eval sets**, then gating suggestions on them.

## Open questions

- **MCP turn boundaries.** There is no "message" on that surface. Group by
  (session, quiet period) or require a client hint? Wrong grouping makes gaps
  noisy.
- **Is an interaction record for MCP appropriate at all?** An external agent's
  tool arguments are not necessarily the user's question and may be sensitive.
  Possibly record only tool-derived intent and context references there.
- **How do we get `outcome` honestly?** Thumbs are sparse; "the user rewrote my
  SQL" is richer but needs the console and chat to be linked. Decide how much
  instrumentation is worth it.
- **Cost.** A Review Agent run per gap, plus eval runs, is real spend. Per-workspace
  budget and a "run on demand" default before any schedule?
- **Who is the reviewer?** The workspace admin today; is there a need for a
  data-steward role, shared with the endorsements RFC?
- **Cross-workspace learning.** Gaps that recur across many workspaces point at
  shared system skills. Aggregating that is valuable and a privacy decision;
  out of scope here, but the "shared knowledge" suggestion type should not
  assume it either way.
- **Where does the shared tag/SQL parser live?** `tablesReferenced` extraction is
  needed here, by endorsements gating, and by the apps RFC. Build it once.

## Risks

- **Suggestion fatigue.** A queue that proposes weak fixes gets ignored, and
  then the whole loop is dead weight. Thresholds, evidence-first presentation
  and a visible accept-rate metric are part of the design, not polish.
- **Reinforcing a wrong consensus.** If many users repeat the same
  misconception the loop will faithfully encode it. Human review and
  endorsement-as-explicit-act are the counterweight.
- **Prompt creep.** The easy suggestion is "add a line to the prompt." The
  routing above (skills/descriptions first, prompt last, size budget enforced)
  exists to prevent the loop from quietly bloating the always-on context.
- **Instrumentation drift.** Opt-in capture means a new tool silently records
  nothing. Add a test that lists tools without a capture decision, as the tier
  policy test does, so skipping is deliberate.
- **Blocking the stream.** All writes go through the finalization queue; any
  synchronous work on the streaming path breaks the invariant
  `chat-finalization-queue.test.ts` guards.
