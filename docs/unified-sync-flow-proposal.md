# Proposal: Unify Scheduled ("Connector Sync") and Webhook CDC Flows

> Consolidate the two flow types into a single CDC-backed sync pipeline where the
> **trigger** (schedule / webhook / both) is a property, not a separate flow type.

## Summary

Mako currently exposes two conceptually-overlapping ways to sync a connector into
a destination:

1. **Scheduled flows** (`type: "scheduled"`) — cron-triggered batch pull with a
   `full | incremental` toggle. Built via `ScheduledFlowForm`.
2. **Webhook flows** (`type: "webhook"`) — push-triggered, hard-wired to
   `syncEngine: "cdc"`, with a periodic full-backfill reconcile. Built via
   `WebhookFlowForm`.

Underneath, **the ingestion + materialization engine is already shared and
source-agnostic**: the CDC pipeline ingests `CdcChangeEvent`s tagged with
`sourceKind: "webhook" | "backfill"`, and every connector already normalizes
polled rows into the same canonical CDC shape. The duplication users feel is at
the **trigger + form + scheduler** layer, not the engine.

This proposal unifies the two into one `Sync` concept:

- One engine: `syncEngine: "cdc"` (retire the legacy Mongo-replace path).
- Trigger becomes a config: `{ schedule?, webhook? }` — a sync can poll, receive
  pushes, or both.
- `backfill` (full reconcile) vs `incremental` (windowed `since` poll) become
  **backfill modes**, independent of the trigger.

---

## Motivation

### Current state (verified in code)

- Flow type is a hard enum discriminator: `type: "scheduled" | "webhook"`.
  - `api/src/database/workspace-schema.ts` — `IFlow.type` and the schema enum.
- CDC ingestion is already provenance-based, not webhook-specific:
  - `CdcChangeEvent.sourceKind` enum is `["webhook", "backfill"]`
    (`api/src/database/workspace-schema.ts`).
  - `api/src/sync-cdc/sync-state.ts` maps `sourceKind: "backfill"` → `mode:
    "backfill"` vs steady stream.
  - `api/src/sync-cdc/ingest.ts` ingests both kinds through the same path.
- Every connector already emits polled rows in the canonical CDC shape via
  `normalizeBackfillRecord(... source: "backfill")`
  (`api/src/connectors/base/BaseConnector.ts`, plus per-connector overrides in
  `close`, `stripe`, `calendly`, `pandadoc`, `claap`).
- The backfill/sync worker is shared: `performSyncChunk` →
  `connector.fetchEntityChunk` for both flow types
  (`api/src/sync/sync-orchestrator.ts`, `api/src/inngest/functions/sync-entity.ts`).
- `incremental` is derived generically: `isIncremental: syncMode ===
  "incremental"` → the SQL path anchors on `max(_syncedAt)` and passes it as
  `since` (`api/src/sync/sync-orchestrator.ts`).

### Duplication that actually exists

| Layer | Scheduled | Webhook | Verdict |
|---|---|---|---|
| Ingestion + materialization | shared CDC | shared CDC | Already unified |
| Flow `type` discriminator | `"scheduled"` | `"webhook"` | Duplicated |
| UI form | `ScheduledFlowForm` | `WebhookFlowForm` | Duplicated |
| Scheduler | `flowSchedulerFunction` (cron) | `cdcScheduledBackfillFunction` (backfill cron) | Overlapping |
| Engine exposure | legacy **or** cdc (UI hides cdc) | cdc only | Inconsistent |

### Known pain points

1. Users must decide "scheduled vs webhook" up front, even though many connectors
   want both (webhook for freshness, scheduled backfill for reconciliation).
2. Pull-only connectors that want CDC materialization (e.g. a Meta Ads connector
   writing to BigQuery/ClickHouse) have no clean UI path: `ScheduledFlowForm`
   does not expose `syncEngine: cdc`.
3. Two schedulers + two validation regimes (cron required for scheduled, skipped
   for webhook) create drift and edge cases.
4. The legacy Mongo-replace engine lingers only under scheduled flows, splitting
   the destination-writer code paths.

### Desired state

- A single "Sync" object with: source connector, destination (CDC-capable),
  entity selection, backfill mode, and a **trigger set**.
- Webhook is an optional freshness trigger, never required.
- One scheduler responsibility model; one materialization engine.

---

## Proposed model

### Data model

Replace the `type` discriminator with orthogonal properties. Target shape:

```ts
interface IFlow {
  // was: type: "scheduled" | "webhook"
  syncEngine: "cdc";                 // only engine going forward

  trigger: {
    schedule?: { enabled: boolean; cron: string; timezone: string };
    webhook?:  { enabled: boolean; secret?: string; providerWebhookId?: string };
  };

  backfill: {
    mode: "full" | "incremental";    // reconcile strategy
    schedule?: { enabled: boolean; cron: string; timezone: string };
  };

  // unchanged
  sourceType: "connector" | "database";
  dataSourceId: ObjectId;
  destinationDatabaseId: ObjectId;
  tableDestination: { connectionId; schema; tableName? };
  entityFilter / entityLayouts;
  deleteMode: "hard" | "soft";
}
```

Key invariants:

- At least one of `trigger.schedule.enabled` or `trigger.webhook.enabled` must be
  true.
- `webhook.enabled` requires the connector's `getWebhookCapabilities().supported`.
- `syncEngine: "cdc"` requires a CDC-capable destination
  (`hasCdcDestinationAdapter`).
- `sourceKind` stays `"webhook" | "backfill"` internally — this is lineage, not
  duplication, and diagnostics/materializer depend on it.

### Engine behavior (mostly already true)

- Webhook push → `WebhookEvent` → CDC ingest (`sourceKind: webhook`).
- Schedule tick → `performSyncChunk` → `fetchEntityChunk` → `normalizeBackfillRecord`
  → CDC ingest (`sourceKind: backfill`).
- Both MERGE into the same destination table via the CDC destination adapter.

### Scheduler consolidation

Collapse to one scheduler responsibility:

- A single cron sweep selects syncs with any enabled schedule
  (`trigger.schedule` for incremental polls, `backfill.schedule` for full
  reconciles) and emits the existing Inngest events.
- Keep the two *event handlers* if useful, but drive them from one flow model and
  one selection query rather than `type`-partitioned queries.

---

## Migration path (phased, non-breaking)

The migration is invasive at the model/UI/scheduler layer but low-risk at the
engine layer because ingestion is already unified. Recommend shipping behind a
`unifiedSyncFlows` feature flag.

### Phase 0 — Compatibility shims (no user-visible change)

- Add the new fields (`trigger`, `backfill.mode`) to the schema as **optional**,
  alongside the existing `type` / `schedule` / `syncMode` / `syncEngine`.
- Add read-side accessors that derive the new shape from legacy fields:
  - `type: "scheduled"` → `trigger.schedule = schedule`, `backfill.mode = syncMode`.
  - `type: "webhook"` → `trigger.webhook = webhookConfig`,
    `backfill = backfillSchedule`, `backfill.mode = "full"`.
- No writes change yet; everything continues to run on `type`.

### Phase 1 — Engine convergence

- Expose `syncEngine: cdc` for connector scheduled flows in the backend execution
  path (already supported by `cdcScheduledBackfillFunction` selection on
  `syncEngine: "cdc"`; just remove `type`-based gating in
  `flowSchedulerFunction` / `flow.ts`).
- Gate: a scheduled flow may only become CDC if it has a CDC-capable
  `tableDestination`. Leave legacy Mongo scheduled flows on the legacy path for
  now.

### Phase 2 — Backfill migration script

- Add a migration under `api/src/migrations/**` (see
  `.cursor/skills/create-migration`) that backfills `trigger` + `backfill` on all
  existing flows from their legacy fields. Idempotent, reversible.
- Validation: assert every migrated flow has at least one enabled trigger and,
  if CDC, a CDC-capable destination.

### Phase 3 — UI cutover

- Ship the unified `SyncFlowForm` (below) behind the flag; keep
  `ScheduledFlowForm` / `WebhookFlowForm` as fallbacks.
- New syncs are created in the unified shape (`type` still written for back-compat
  as a derived value: `webhook` if only webhook trigger, else `scheduled`).

### Phase 4 — Scheduler consolidation

- Replace the two `type`-partitioned scheduler queries with one selection over
  the trigger fields. Keep event names stable to avoid Inngest churn.

### Phase 5 — Legacy sunset (separate, opt-in)

- Migrate remaining `syncEngine: "legacy"` scheduled flows to CDC + a
  CDC-capable destination (requires a destination for Mongo-only users).
- Once drained, remove the legacy Mongo-replace destination path and the `type`
  discriminator entirely.

### Rollback

- Because Phase 0–3 keep legacy fields authoritative and only *derive* the new
  shape, disabling the flag reverts behavior. The Phase 2 migration is reversible
  (drop the added fields).

---

## UI proposal

### Single "Sync" builder

Replace two forms with one wizard. Steps:

1. **Source** — pick connector (or database). Unchanged.
2. **Destination** — pick a CDC-capable destination + schema/dataset. (Same field
   set `WebhookFlowForm` already enforces for CDC.)
3. **Triggers** — a multi-select, not an either/or:
   - `☑ Scheduled` → cron + timezone (incremental poll cadence).
   - `☑ Webhook` → shown only if `connector.getWebhookCapabilities().supported`;
     renders the existing secret / provisioning UI. Greyed out with a tooltip for
     pull-only connectors ("This connector does not provide webhooks — use a
     schedule").
   - Validation: at least one enabled.
4. **Backfill** — `full | incremental` reconcile mode + optional reconcile cron
   (the current "Scheduled full backfill" control).
5. **Entities** — entity selection + layout hints. Unchanged.

### Trigger matrix surfaced to the user

| Connector shape | Default triggers | Backfill mode |
|---|---|---|
| Push-capable (Close, Stripe, Calendly…) | Webhook + scheduled reconcile | full reconcile |
| Pull-only (Meta Ads, REST, GraphQL) | Scheduled | incremental (+ trailing-window for restated data) |
| Hybrid | Both | incremental poll + periodic full reconcile |

### Component plan

- New `SyncFlowForm.tsx` composed from the existing pieces (destination selector,
  entity layout editor, webhook secret/provisioning block, cron editor) so we
  reuse validated sub-components rather than rewriting them.
- Keep the schema-driven connector-agnostic rules: no `if (type === "meta-ads")`
  branching; the webhook step is gated purely on
  `getWebhookCapabilities().supported`.
- `BackfillPanel.tsx` already renders CDC status/stream/backfill for any
  `syncEngine: cdc` flow — it works unchanged once scheduled flows can be CDC.

### Wireframe (textual)

```
┌ New Sync ───────────────────────────────────────────────┐
│ 1 Source        [ Meta Ads ▼ ]                           │
│ 2 Destination   [ BigQuery ▼ ]  schema [ marketing ]     │
│ 3 Triggers      [x] Scheduled   cron [0 * * * *] TZ[UTC] │
│                 [ ] Webhook     (unavailable for Meta Ads)│
│ 4 Backfill      ( ) Full   (•) Incremental               │
│                 [ ] Periodic full reconcile  cron[0 3 * * *]│
│ 5 Entities      [x] campaigns [x] ads [x] ads_insights…  │
└──────────────────────────────────────────────────────────┘
```

---

## Risks & open questions

- **Legacy engine sunset** is the largest lift: Mongo-only scheduled flows need a
  CDC-capable destination before `type`/legacy removal (Phase 5). Until then, the
  two engines coexist.
- **Validation divergence**: cron is required for scheduled but skipped for
  webhook today; the unified schema must require cron only when
  `trigger.schedule.enabled`.
- **Provenance stays split**: do not collapse `sourceKind` — the materializer,
  lag metrics, and diagnostics (`cdc-pending-diagnostic`) rely on
  `webhook` vs `backfill`.
- **Insights-style restatement**: incremental-by-`since` is insufficient for
  connectors whose past rows are restated (e.g. Meta Ads insights). The connector
  must override/extend `since` internally and re-fetch a trailing window; the
  unified model does not change this connector responsibility.
- **Open question**: should `trigger` be a set on one flow, or should we keep the
  DB doc single-trigger and let a connector own multiple flows? Recommendation:
  single flow, trigger set — it matches the shared engine and avoids fan-out of
  destination config.

---

## Appendix: primary code references

- Flow type enum: `api/src/database/workspace-schema.ts` (`IFlow.type`, schema
  enum), `CdcChangeEvent.sourceKind` enum.
- Shared engine: `api/src/sync/sync-orchestrator.ts` (`performSyncChunk`,
  `performSyncChunkSql`), `api/src/inngest/functions/sync-entity.ts`.
- CDC ingest/state: `api/src/sync-cdc/ingest.ts`, `api/src/sync-cdc/sync-state.ts`,
  `api/src/sync-cdc/event-store.ts`.
- Backfill normalization: `api/src/connectors/base/BaseConnector.ts`
  (`normalizeBackfillRecord`).
- Schedulers: `api/src/inngest/functions/flow.ts`
  (`flowSchedulerFunction`, `cdcScheduledBackfillFunction`).
- Forms: `app/src/components/ScheduledFlowForm.tsx`,
  `app/src/components/WebhookFlowForm.tsx`, `app/src/components/BackfillPanel.tsx`.
