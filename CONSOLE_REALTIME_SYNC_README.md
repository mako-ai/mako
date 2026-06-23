# Console realtime sync findings

This note captures the investigation into server-side agent console edits that
persisted correctly but did not always appear in an already-open browser tab
until refresh.

## Context

Console writes are now server-authoritative. Agent tools such as
`create_console`, `modify_console`, `set_console_connection`, and `run_console`
write `SavedConsole` documents on the API, bump `draftRevision`, and publish a
workspace realtime event. Browser clients treat realtime events as pokes, then
pull the full console payload through `POST /consoles/revisions-sync`.

Create felt more reliable than edit because `create_console` has two delivery
paths:

- `console.updated` poke followed by revision sync.
- `chat.ui-intent` / chat tool-output handling that opens the new tab.

Edits depend on the open tab receiving the poke, pulling the changed revision,
and then applying it or showing an Accept/Reject agent diff.

## Reproduced behavior

The original create-then-modify flow was tested locally in a browser. The
content edit path worked in the observed run: the server-side `modify_console`
write arrived in the open editor as an AI suggested changes diff without a page
refresh.

The deterministic bug reproduced during instrumentation was narrower:

1. An agent-origin server change bumped `draftRevision`.
2. The pulled server payload had the same SQL text as the open tab. This happens
   for run-artifact bumps, metadata-only changes, echoes, or stale re-syncs
   after a user already accepted a diff.
3. `beginAgentReview` saw there was no content diff and returned early.
4. Because it returned early, the tab did not fast-forward its `draftRevision`,
   title, version, connection metadata, or run artifact.
5. Later syncs kept sending the old local revision and repeatedly re-pulled the
   same "changed" entry. A refresh rebuilt state from the server and made the
   UI appear correct.

The key failure was not persistence or SSE delivery. It was a client-side
reconciliation branch that treated "nothing to review" as "nothing to apply",
even though the revision and metadata still needed to advance.

## Fix

`app/src/store/consoleStore.ts` now fast-forwards matching agent-origin entries
inside `beginAgentReview`:

- If there is no pending review and `tab.content === entry.content`, the store
  calls `fastForwardRemoteConsoleEntry(entry)` instead of returning early.
- This advances `draftRevision`, `version`, title, connection metadata, saved
  state, remote-update state, and `lastRun` without dispatching a Monaco diff.
- Content edits that actually differ still enter the existing Accept/Reject
  diff flow.

A focused regression test was added in `app/src/store/consoleStore.test.ts` to
assert that matching agent-origin entries fast-forward metadata/revision and do
not dispatch `console-agent-diff`.

## Verification performed

- `pnpm --filter app exec vitest run src/store/consoleStore.test.ts`
- `pnpm --filter app run typecheck`
- `pnpm --filter app run lint`
- Manual browser verification on the local app:
  - Hard refreshed the patched frontend.
  - Asked the agent to modify the open console.
  - Confirmed the editor showed the live AI suggested changes diff without
    refreshing after the modification.

## Why this architecture still feels fragile

The current model is "SSE poke + HTTP pull + local Zustand stores + imperative
Monaco events". It can work, but it has several reliability pressure points:

- Pokes are not replayed; reconnect repairs by pulling current revisions, not
  by replaying missed intent.
- Creation has an extra chat fallback, while edits mostly rely on realtime
  revision sync.
- Durable server state and client-only editor state meet through imperative
  browser events such as `console-agent-diff` and `console-remote-content`.
- Agent review state is partly local (`pendingAgentReviews`) while the accepted
  draft is already persisted on the server.
- Metadata changes, run artifacts, content changes, and reviewable changes all
  share the same `draftRevision` counter but have different UI handling.

The fixed bug came from one of those branches drifting from the core invariant:
if the server revision is newer, the open tab must either apply it, review it,
or explicitly record that it is blocked by user action.

## Suggested next steps

### 1. Add sync observability

Add lightweight client/server telemetry around console sync:

- Client tab revision, server revision, and lag duration.
- Number of repeated pulls for the same stale revision.
- Reason a sync entry was handled: `apply`, `fast-forward`, `agent-review`,
  `remote-banner`, `skip`, or `deleted`.
- Whether Monaco had a mounted ref when an imperative editor event fired.

This would make future "random" stale UI reports diagnosable from logs.

### 2. Make revision handling an explicit reducer

Move the revision reconciliation decision into a small pure reducer with a
single result shape:

- `applyContent`
- `fastForwardMetadata`
- `openAgentReview`
- `showConflictBanner`
- `ignore`

Keep the Monaco event dispatch as an effect after the reducer result. This would
make it harder for a branch to update UI without advancing revision, or advance
revision without updating UI.

### 3. Normalize agent edits as server events

Instead of encoding agent edits only as changed console documents plus
`lastDraftOrigin`, persist a first-class event record such as:

- `console.content_proposed`
- `console.metadata_updated`
- `console.run_updated`
- `console.deleted`

The console document remains the snapshot. Events explain why the snapshot
changed and how clients should render the change.

### 4. Consider resumable WebSocket/event-stream sessions

SSE poke/pull is acceptable for coarse invalidation, but collaboration features
would benefit from a replay cursor:

- Each workspace event has a monotonic sequence.
- Clients subscribe with `lastSeenSeq`.
- On reconnect, the server sends missed events or tells the client to refetch a
  snapshot if the gap is too large.
- Clients subscribe by scope, such as active tab, dashboard, or chat.

This is closer to how multiplayer apps and design tools stay reliable: events
are durable enough to replay, while snapshots remain available for compaction.

### 5. Define one ownership model per state category

Separate state by ownership:

- Server-owned: console content, metadata, draft revision, run artifacts,
  sharing state.
- Client-owned: active tab, panel layout, editor cursor/selection, transient UI
  affordances.
- Shared ephemeral: presence, active chat streaming state, pending review UI.

For shared ephemeral state, decide deliberately whether it should survive
refresh/reconnect. Agent review probably should: the server already contains the
proposed draft, but the client currently owns the review baseline.

### 6. Add end-to-end realtime tests

Extend the existing realtime E2E coverage to include:

- Agent creates a console and an attached browser opens it.
- Agent modifies an open console and the browser shows a diff.
- Agent produces a same-content revision bump and the browser fast-forwards the
  revision without a diff.
- Browser disconnects during an agent edit, reconnects, and converges without
  refresh.
- Two browser windows observe the same server-side agent edit.

The same-content revision test is the direct regression for this fix.

