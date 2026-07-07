# Sync modes hardening plan

Status: proposal (2026-07-07). Companion to `docs/unified-sync-flow-proposal.md`
and PR #676 (migrated-flow trigger/observability fixes).

## Problem statement

The Airbyte-style mode matrix (`syncMode: full|incremental` ×
`writeMode: append_dedup|append|overwrite`) is exposed for every connector and
destination, but three of its axes are not actually guaranteed by the backend:

1. **Source capability** — "Incremental" requires the connector to pull
   changes-since-X. Audit result (chunked path, `fetchEntityChunk({ since })`):

   | Connector         | `since` handling                                                                                                    | Effective incremental                    |
   | ----------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
   | pandadoc          | `modified_from` (documents); client filter (templates/members); none (contacts)                                     | native / client-filter / none per entity |
   | stripe            | `created[gte]` on all entities                                                                                      | **created-anchor: misses updates**       |
   | claap             | `createdAfter` (recordings); none (workspace)                                                                       | created-anchor / none                    |
   | calendly          | `min_start_time` (events); client `updated_at` filter (others); none (organizations)                                | partial                                  |
   | close             | Search-API path (leads/contacts/opportunities/activities) ignores `since`; offset fallback uses `date_updated__gte` | **none for primary entities**            |
   | rest              | injects `updated_after` + client filter; keeps records without timestamps                                           | depends on API                           |
   | graphql           | client-side filter after full paginated fetch                                                                       | none (full re-pull)                      |
   | posthog           | `since` unused                                                                                                      | none                                     |
   | bigquery (source) | `since` unused                                                                                                      | none                                     |

   "Client-filter" is _correct but not cheaper_ (full API scan);
   "created-anchor" is _cheaper but incorrect_ (updates to old records are
   never re-fetched by polls — only webhooks catch them).

2. **Write-path correctness** — three concrete bugs:

   - **B1 (data loss)**: `Full Refresh | Overwrite` on staging destinations
     (BigQuery): every bulk flush cycle calls `performPrepareStaging`, which
     re-truncates the live table (`sync-orchestrator.ts`), wiping rows loaded
     by earlier flushes of the same run. Entities > flush threshold (10k rows)
     end up with only the last flush's rows.
   - **B2 (silent regression)**: `Full Refresh | Deduped` never removes rows
     deleted at the source. The CDC MERGE is upsert-only and
     `purgeSoftDeletesAfterBackfill` only purges webhook-tombstoned rows. The
     legacy engine's staging **swap** dropped deleted rows by construction, so
     migrated flows silently stopped propagating deletions. The reconcile
     trigger's UI copy ("reconcile drift and deletions") is currently false
     for dedup mode.
   - **B3 (mixed semantics)**: the streaming consumer (`sync-cdc/consumer.ts`)
     builds the entity layout **without** `writeMode`, so webhook events are
     always MERGE-deduped even on `Incremental | Append` flows whose
     poll/backfill rows append history.

3. **Validation is scattered** — the UI filters combos in `SyncFlowForm`,
   `validateWriteMode` covers a partially-overlapping subset server-side, the
   legacy engine accepts-and-ignores `append`/`overwrite`, and nothing gates
   `syncMode: "incremental"` on source capability.

---

## Phase 1 — Fix `Full Refresh | Overwrite` data loss (B1)

**Change**

- `api/src/sync/sync-orchestrator.ts`: remove the `truncateLiveTable` call from
  `performPrepareStaging`; add an explicit `performOverwriteTruncate(options)`.
- `api/src/inngest/functions/sync-entity.ts`: call `performOverwriteTruncate`
  exactly once, inside the initial `prepare-staging-*` step (durable — reruns
  of later steps never re-truncate). Mid-loop `flush-merge-*` and
  `flush-final-*` keep calling `performPrepareStaging` (staging-only reset).
- Keep the existing non-bulk truncate (`!state` first chunk) in
  `performSyncChunk` — it is already once-per-run.

**Tests**

- Unit (offline, `test:destinations`): new
  `sync-orchestrator.overwrite.test.ts` — `performPrepareStaging` never calls
  `truncateLiveTable`; `performOverwriteTruncate` calls it only for
  `writeMode: "overwrite"` (adapter mocked).
- Integration (gated, `RUN_DB_INTEGRATION=1`, bigquery-emulator harness in
  `api/src/databases/test-support/`): overwrite backfill with
  `SYNC_BULK_FLUSH_BATCH_SIZE` / flush threshold lowered so ≥2 flush cycles
  happen; assert final live row count == source row count (today it equals the
  last flush only). Re-run the same backfill; assert count unchanged
  (truncate-then-load idempotency).

## Phase 2 — Real deletion reconcile for Deduped full runs (B2)

**Design**: a completed CDC **full** backfill has, by definition, touched every
live record — anything with `_syncedAt < runStartedAt` no longer exists at the
source. Sweep it.

**Change**

- `CdcDestinationAdapter` (registry): new optional
  `softDeleteRowsNotSyncedSince(layout, cutoff: Date): Promise<{ marked: number }>`
  — SQL adapters: `UPDATE live SET is_deleted=true, deleted_at=now() WHERE
_syncedAt < cutoff AND is_deleted IS NOT TRUE`; Mongo: `updateMany`.
- `api/src/inngest/functions/flow.ts` post-backfill block: new step
  `reconcile-deletes-after-backfill`, before `purge-soft-deletes-after-backfill`.
  Guards: only when `isCdcBackfill`, `writeMode` is `append_dedup` (append =
  history mode, overwrite already exact), run completed all entities in scope,
  and cutoff = `backfillState.startedAt` captured at run start. Scope subset
  runs sweep only the entities in scope. Existing purge step then hard-deletes
  when `deleteMode: "hard"`; soft mode keeps tombstones.
- Races: rows updated mid-run get fresh `_syncedAt` (webhook or later chunk) —
  never swept. A source update after its page was fetched but with no webhook
  can be swept one cycle early; the next reconcile restores it (same guarantee
  the legacy swap gave).
- Update UI copy only if this phase ships; otherwise change the reconcile
  description to "reconciles drift; deletions require Overwrite mode or
  delete webhooks".

**Tests**

- Unit (offline): per-adapter SQL builder tests in the destination-contract
  style — exact UPDATE statement, identifier quoting for `_syncedAt`
  (Postgres case-folding!), tombstone columns.
- Unit: `flow.ts` step guards — no sweep for `append`/`overwrite`, no sweep on
  failed/partial runs, subset scope sweeps only scoped entities (mock adapter,
  assert calls).
- Integration (gated testcontainers Postgres): seed live table with rows A,B,C
  (stale `_syncedAt`); run a full backfill whose source returns only A,B →
  assert C `is_deleted=true` (soft) and physically gone after purge (hard).
  Run again → idempotent. Webhook-updated row during the run is not swept.

## Phase 3 — Webhook stream honors `writeMode` (B3)

**Change**: `api/src/sync-cdc/consumer.ts` — pass
`writeMode: flow.writeMode` into `buildCdcEntityLayout` (one line), so
`applyEvents` takes the existing append branch (insert + tombstone rows).

**Tests**

- Unit: consumer layout construction test (extract/export the layout builder or
  assert via mocked adapter) — layout carries the flow's `writeMode`.
- Extend existing adapter `applyEvents` tests: append-mode delete event lands
  as a tombstone **row**, not an in-place update (already partially covered by
  the `synced-at`/write-sql suites; add the append-path case).

## Phase 4 — Source incremental capability (the user-visible gap)

**Design**: mirror the webhook-capability pipeline
(`getWebhookCapabilities()` → registry `metadata.webhook` →
`GET /api/connectors/types` → `connectorCatalogStore` → `SyncFlowForm`).

**Change**

- `BaseConnector`: `getIncrementalCapabilities(): IncrementalCapabilities`
  ```ts
  interface IncrementalCapabilities {
    supported: boolean;                 // any entity better than "none"
    // worst-case honest declaration; perEntity overrides
    mode: "native" | "client-filter" | "created-anchor" | "none";
    perEntity?: Record<string, { mode: ...; anchorField?: string }>;
  }
  ```
  Default implementation returns `{ supported: false, mode: "none" }` so every
  connector must opt in honestly. Declarations per the audit table above
  (stripe → `created-anchor`, close → `none` for search-API entities +
  `native` for offset fallback entities, pandadoc → perEntity, graphql/posthog/
  bigquery → `none`, rest → `client-filter`).
- Registry + `/api/connectors/types`: expose `incremental` next to `webhook`.
- **Backend validation** (`flows.ts` — extend `validateWriteMode` into
  `validateSyncConfig`):
  - reject `syncMode: "incremental"` when capability is `none` for every
    selected entity (error tells the user to use Full Refresh or webhooks);
  - reject `writeMode` ≠ `append_dedup` on the legacy engine (accepted-and-
    ignored today);
  - warning surface (response `warnings[]`) for `created-anchor` connectors:
    "polls fetch new records only; updates require the webhook trigger or a
    periodic full reconcile".
- **UI** (`SyncFlowForm`):
  - hide `Incremental | *` combos when the connector can't do incremental for
    any selected entity; show the created-anchor warning otherwise;
  - per-entity indicator in the Entities table (native / filter / full-repull)
    so partial connectors (pandadoc contacts, calendly organizations) are
    visible;
  - auto-suggest enabling the periodic reconcile when any selected entity is
    `none`/`created-anchor` (this is exactly what reconcile exists for).
- **Single capability matrix**: put the pure combo logic
  (`allowedModes({incrementalCap, destinationType, triggers, engine})`) in
  `packages/schemas` (already shared FE/BE for the DB-flow form) so the
  dropdown and validator cannot drift.

**Tests**

- Contract test `api/src/connectors/incremental-capability.test.ts`
  (node:assert, wired into `pnpm --filter api test`): every registered
  connector returns a well-formed declaration; connectors declaring `native`
  for an entity are spot-checked by asserting the request their
  `fetchEntityChunk` builds contains the anchor param when `since` is passed
  (mock the HTTP layer, as the existing stripe/close connector tests already
  do) — e.g. pandadoc documents → `modified_from`, stripe → `created[gte]`,
  posthog → no param + declared `none`.
- Matrix unit tests in `packages/schemas`: table-driven — every
  (capability × destination × trigger × engine) → expected allowed combos +
  warnings; includes the ClickHouse dedup-only and overwrite/webhook rules that
  today live only in `validateWriteMode`.
- Route test: POST/PUT flow with incremental + `none` connector → 400 with the
  explanatory error.
- Manual (dev VM, computerUse): PostHog-style connector shows only Full
  Refresh combos; Close shows the reconcile suggestion; screenshot/video
  artifacts.

## Phase 5 — Trigger/mode UI consolidation (design)

- When `syncMode` is Full Refresh, "Scheduled" and "Periodic full reconcile"
  are the same thing (the legacy→CDC migration literally converts one to the
  other). Collapse to **one cron** for full-refresh flows; keep reconcile as an
  add-on trigger only for Incremental/Webhook flows.
- Disable (or warn on) reconcile for `Incremental | Append` — a reconcile
  appends a complete duplicate snapshot into a history table.
- Copy fixes per Phase 2 outcome.
- Tests: `SyncFlowForm` behavior is covered by the matrix tests (logic lives in
  `packages/schemas`) + a computerUse walkthrough for each mode selection.

## Phase 6 — Per-connector incremental upgrades (backlog, independent)

| Connector                    | Upgrade                                                                                                                | Effort                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| close                        | use `date_updated` moment_range in the Search-API path when `since` is set                                             | contained in `fetchViaSearchApi` |
| stripe                       | Events-API top-up for updated objects (or rely on webhook hybrid; keep `created-anchor` declaration until then)        | medium                           |
| graphql / posthog / bigquery | optional `$since` / `{since}` variable injection into flow-level queries; declare `native` only when the query uses it | small, per connector             |
| rest                         | drop the `return true` (keep-on-missing-timestamp) leak; make the injected param name configurable                     | small                            |

Each ships with a connector test asserting the request contains the anchor and
that the capability declaration flips accordingly.

## Rollout order & risk

1. **Phase 1** first (data-loss, small diff, fully testable offline+emulator).
2. **Phase 3** (one-liner + tests).
3. **Phase 2** (needs the integration suite; changes destination data — soft
   sweep + existing purge keeps it reversible for soft-delete mode).
4. **Phase 4** (additive metadata; validation initially warning-only for
   existing flows, hard-reject only for new/edited flows to avoid breaking
   currently-running incremental flows that silently full-repull).
5. **Phases 5–6** independent follow-ups.

Acceptance: `pnpm --filter api run test:destinations` (extended),
`pnpm --filter api test` (capability contract), gated
`RUN_DB_INTEGRATION=1` suite green, plus computerUse walkthroughs for the UI
phases.
