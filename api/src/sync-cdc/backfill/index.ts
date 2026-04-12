/**
 * CDC Backfill module — facade and re-exports.
 *
 * This is the public API for the backfill subsystem. External code
 * (routes, Inngest functions) should import from `./backfill` — the
 * barrel re-exports everything they need.
 *
 * Internal implementation is split across:
 * - `orchestration.ts` — start/pause/resume/cancel lifecycle
 * - `recovery.ts` — recover streams, reprocess stale events, retry failures
 * - `webhook-ops.ts` — webhook event drain/reset/reconcile
 * - `destination-ops.ts` — table deletion, staging cleanup, soft-delete purge
 */
export {
  startBackfill,
  resyncFlow,
  pauseBackfill,
  cancelBackfill,
  resumeBackfill,
  pauseStream,
  resumeStream,
  assertCanStartBackfill,
  abandonStaleExecutions,
  cancelInngestFlowRuns,
} from "./orchestration";

export {
  retryFailedMaterialization,
  recoverStream,
  reprocessStaleEvents,
  recoverFlow,
} from "./recovery";

export {
  resetFailedWebhookEvents,
  reconcileWebhookApplyStatus,
  resolveOrphanedWebhookApplyStatus,
  drainPendingWebhookEvents,
} from "./webhook-ops";

export {
  deleteDestinationTables,
  cleanupOrphanStagingTables,
  purgeSoftDeletesAfterBackfill,
  markCdcBackfillCompletedForFlow,
  forceDrainCdcFlow,
} from "./destination-ops";

// ---------------------------------------------------------------------------
// CdcBackfillService class — thin facade kept for backward compatibility.
// All methods delegate to the standalone functions above so external callers
// that use `cdcBackfillService.startBackfill(...)` continue to work.
// ---------------------------------------------------------------------------
import {
  startBackfill,
  resyncFlow,
  pauseBackfill,
  cancelBackfill,
  resumeBackfill,
  pauseStream,
  resumeStream,
  assertCanStartBackfill,
} from "./orchestration";

import {
  retryFailedMaterialization,
  recoverStream,
  reprocessStaleEvents,
  recoverFlow,
} from "./recovery";

export class CdcBackfillService {
  assertCanStartBackfill = assertCanStartBackfill;
  startBackfill = startBackfill;
  resyncFlow = resyncFlow;
  retryFailedMaterialization = retryFailedMaterialization;
  recoverStream = recoverStream;
  reprocessStaleEvents = reprocessStaleEvents;
  recoverFlow = recoverFlow;
  pauseBackfill = pauseBackfill;
  cancelBackfill = cancelBackfill;
  resumeBackfill = resumeBackfill;
  pauseStream = pauseStream;
  resumeStream = resumeStream;
}

export const cdcBackfillService = new CdcBackfillService();
