/**
 * CDC backfill orchestration. The operations live in `./backfill/*` by
 * concern; `cdcBackfillService` is the facade every caller has always used,
 * and this path stays the import for it and the completion helpers.
 *
 *   execution-guard     may a backfill start? (stale runs, cancels in flight)
 *   lifecycle           start / pause / cancel / resume; stream pause / resume
 *   resync              full or per-entity resync
 *   repartition         rebuild an entity table under a new layout
 *   recovery            operator recovery (materialization, stream, stale events)
 *   webhook-maintenance shared webhook-event + staging housekeeping
 *   completion          mark complete, purge soft deletes, force-drain
 */
import { assertCanStartBackfill } from "./backfill/execution-guard";
import {
  cancelBackfill,
  pauseBackfill,
  pauseStream,
  resumeBackfill,
  resumeStream,
  startBackfill,
} from "./backfill/lifecycle";
import {
  recoverFlow,
  recoverStream,
  reprocessStaleEvents,
  retryFailedMaterialization,
} from "./backfill/recovery";
import {
  backfillMissingEntities,
  pauseStreamForRepartition,
  recoverRepartition,
  recoverStaleRepartitionPauses,
  repartitionEntity,
  resumeStreamForRepartition,
  triggerEntityMaterialization,
} from "./backfill/repartition";
import { resyncEntities, resyncFlow } from "./backfill/resync";

export {
  forceDrainCdcFlow,
  markCdcBackfillCompletedForFlow,
  purgeSoftDeletesAfterBackfill,
} from "./backfill/completion";

export class CdcBackfillService {
  assertCanStartBackfill = assertCanStartBackfill;
  startBackfill = startBackfill;
  resyncFlow = resyncFlow;
  resyncEntities = resyncEntities;
  pauseStreamForRepartition = pauseStreamForRepartition;
  resumeStreamForRepartition = resumeStreamForRepartition;
  repartitionEntity = repartitionEntity;
  triggerEntityMaterialization = triggerEntityMaterialization;
  recoverRepartition = recoverRepartition;
  recoverStaleRepartitionPauses = recoverStaleRepartitionPauses;
  backfillMissingEntities = backfillMissingEntities;
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
