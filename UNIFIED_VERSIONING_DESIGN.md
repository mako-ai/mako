# Unified Draft / Published / Version-History Model (Apps + Dashboards)

Status: proposal · Owner: TBD · Relates to PR #595 (app version history)

## TL;DR

Once an entity has version history, it has three things: **committed versions**
(immutable snapshots), a **working draft** (what's being edited), and a
**published** definition (what viewers / public links render). The only
architecturally load-bearing decision is **where the working draft lives**, and
the answer — forced by the server-side + background-agent direction — is: **the
draft must be server-persisted, never client-only.**

Apps already embody this (the doc *is* the server draft, autosaved; the agent
mutates it server-side). The work is therefore:

1. Add an explicit **draft → published** split (so shares/viewers see a stable
   version while the editor + agent iterate).
2. Reuse `entity-version.service` for the immutable history (apps already do
   after PR #595).
3. Apply the **identical** model to dashboards — which also moves the dashboard
   draft off the client and unblocks **server-side dashboard agent tools**.

## Current state

| Concern | Apps (today) | Dashboards (today) |
| --- | --- | --- |
| Working def | `MakoApp` doc, **server-persisted**, autosaved via `persistApp` (PUT) | `dashboardStore` (**Zustand, client-only**) |
| Agent edits | **Server** tools (`server-app-tools.ts`) mutate the doc | **Client** tools (`clientDashboardTools` via `onToolCall`) — needs a browser |
| Realtime resync | `app.updated` → open tabs refetch | `dashboard.updated` exists (partial) |
| History | `EntityVersion` (PR #595) + restore | `EntityVersion` + legacy embedded `versionHistory[]` |
| Published/served | none — public share renders the **live** doc | none — renders live def |

Takeaway: **apps are ~80% of the model already.** The only missing piece for
apps is the published split. Dashboards are the real lift: their draft is in the
browser, which is exactly why their agent tools are client-side and a headless
agent "needs a browser."

## Target model (one shape for both entities)

```text
Entity {
  // working draft — the current editable definition. Autosaved server-side
  // (debounced PATCH; the app persistApp mechanism). User editor AND agent
  // both mutate this.
  draft: Definition

  // last committed/served definition. Viewers, public/shared links, and
  // snapshots render THIS, never the draft.
  published?: Definition

  // immutable committed snapshots (generic infra: entity-version.service
  // createVersion({ entityType })). Apps reuse it directly.
  versionHistory: EntityVersion[]   // separate collection, not embedded
}
```

Two operations:

- **Publish a version** = copy `draft → published`, append a snapshot to
  `versionHistory`, bump the committed version.
- **Restore** = copy `versionHistory[n] → draft` (then optionally publish).

## Preview & sharing semantics

- **Editor's open tab** renders `draft` and re-renders on the realtime
  `*.updated` event (the `handleAppUpdated` pattern). So when the background
  agent edits the draft, the user opens the tab and previews the working draft.
- **Viewers / public links / snapshots** render `published`. A half-edited or
  agent-in-progress draft is never exposed on a public share.

## Agent implications

- A server-side / background agent can only edit a **server-persisted draft**.
  Apps already satisfy this; dashboards do not. Moving the dashboard draft to the
  doc lets us port the dashboard tools to **server tools** (the issue-#475
  pattern), which is what makes the headless dashboard agent possible.
- The agent writes the shared server draft directly — the same thing apps do
  today — so the "dashboard concurrency" problem dissolves into the app model.

## Concurrency

- **v1:** single shared draft per entity, **last-writer-wins + realtime
  refetch** (the current app model).
- **Multi-editor surfaces (dashboards):** add an `editLock` to serialize human
  editors; the agent **respects/holds** the lock so a background run doesn't
  stomp someone actively editing.
- **Out of scope:** per-user draft branches / true merge / CRDT. One shared
  server draft is the right v1.

## Implementation refinements (important)

1. **Do not physically rename app top-level fields to `draft.*`.** The blast
   radius (routes, `serializeApp`, agent tools, store, UI, generated OpenAPI
   types) is huge. Treat the **existing top-level fields as the draft in place**
   and add a single `published` snapshot object. Backward compatible: if
   `published` is absent, fall back to the live def (today's behavior).
2. **Checkpoint vs publish.** PR #595 ships "Save version" = snapshot only (a WIP
   restore point) with **no** publish. The target model conflates save = publish.
   Decide whether we want a WIP-checkpoint action distinct from publish:
   - Simplest (user's model): every saved version is a publish.
   - Safer for WIP: keep "Save checkpoint" (snapshot only) **and** add an explicit
     "Publish" (draft → published + snapshot). Recommended once shares matter.
3. **Public-share behavior change.** Switching shares to render `published` is a
   real, user-visible change (today shares reflect live edits). It is the right
   call, but it is a product decision (see below) and should ship behind the
   published-fallback so un-published apps keep working.

## Phasing

- **Phase 0 — DONE (PR #595).** App `versionHistory` + restore + server agent
  tools (`app_save_version`, `app_restore_version`) + `browse_version_history`
  extended to apps + file-aware history UI. This is the `versionHistory[]` layer
  and is independent of the published split.
- **Phase 1 — Apps draft/published split.** Add `MakoApp.published`; add a
  Publish action (draft → published + snapshot); make public-share / viewers
  render `published` (fallback to draft); restore targets the draft. Contained to
  apps + public-share.
- **Phase 2 — Dashboard unification.** Generalize a shared
  draft/published/publish/restore service; migrate the dashboard draft off
  Zustand to the server doc; port `clientDashboardTools` → server tools; add
  `editLock`; wire `dashboard.updated` realtime refetch. Bigger and riskier;
  unblocks the server-side dashboard agent.

## Open product decision

**Do viewers / public links need a stable `published` version while the editor +
agent iterate on the draft?**

- **Yes (recommended):** implement the draft/published split above. You don't
  want a half-edited or agent-in-progress app/dashboard shown on a public share.
- **No:** skip `published`; the doc is just `draft` + history. Simpler, but public
  shares reflect in-progress edits (today's behavior).
