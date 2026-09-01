/**
 * The stream half of flows-as-files (RFC #904 block 3).
 *
 * A `flows/<slug>.yml` change reaches Mongo as a definition edit — that half
 * belongs to the caller. What a definition edit MEANS to a running CDC stream
 * is this module's job, and it is not a field assignment: 31 of 31 production
 * flows are CDC, an entity dropped from the selection has a live consumer and
 * a checkpoint behind it, and a half-applied reconfigure on a live stream is
 * worse than one that was refused.
 *
 * Three properties hold everything else up.
 *
 * ONE — an empty or partial tree is never a deletion. `notifyRepoPushed` fires
 * on ANY branch push and reconciles against main, so a tree read at the wrong
 * moment must not be read as "every flow was deleted". An empty `desired` set
 * returns early, changing nothing.
 *
 * TWO — nothing destructive happens against an unverified tree. Removing a
 * flow, or an entity from a flow's selection, disposes `CdcEntityState`, which
 * holds `lastIngestSeq` and `backfillCursor` — the stream's position. That is
 * not recoverable by re-adding the file: the flow comes back and re-backfills
 * from scratch. So every destructive branch goes behind
 * `assertTreeAtMirrorMain`, which FAILS CLOSED, unlike the best-effort freshen
 * that guards ordinary writes. When it refuses, the non-destructive work still
 * runs and the teardown waits for the next push.
 *
 * THREE — a pause we take is a pause we own. `syncStateMeta.lastEvent` marks
 * it, and resume only lifts our own, so a reconcile can never resume a stream
 * that a repartition (or a person) paused for its own reasons. That pattern is
 * borrowed verbatim from `pauseStreamForRepartition`, which learned it first.
 */
import { Types } from "mongoose";
import {
  CdcChangeEvent,
  CdcEntityState,
  CdcStateTransition,
  Flow,
  FlowExecution,
  WebhookEvent,
  type IFlow,
} from "../database/workspace-schema";
import { inngest } from "../inngest/client";
import { loggers } from "../logging";
import {
  TreeNotVerifiedError,
  assertTreeAtMirrorMain,
} from "../apps/cloud-repo.service";
import { resolveConfiguredEntities } from "./entity-selection";
import type { FlowFile } from "../services/flow-config-files";

const log = loggers.api("cdc-flow-reconcile");

/** Marks the pause this module takes, so it only ever resumes its own. */
const RECONCILE_PAUSE = "REPO_RECONCILE_PAUSE";
const RECONCILE_RESUME = "REPO_RECONCILE_RESUME";

/**
 * One flow as the repository describes it, handed over by the caller that
 * parsed the tree.
 *
 * `flowId` rather than the document: the row is the caller's to create and
 * update, and passing a live Mongoose document across that boundary invites
 * one side to save half of the other's work.
 */
export interface DesiredFlow {
  slug: string;
  file: FlowFile;
  flowId: string;
}

export interface ReconcileResult {
  /** Flows whose stream was paused, reconfigured and resumed. */
  reconfigured: string[];
  /** Flows torn down because their file is gone from the tree. */
  removed: string[];
  /** Entities dropped from a selection; their checkpoints were disposed. */
  entitiesDropped: Array<{ slug: string; entities: string[] }>;
  /**
   * Destructive work deferred because the tree could not be verified. Not an
   * error — the next push retries it — but the reason belongs in the result
   * so a caller can say why a deletion has not happened yet.
   */
  deferred: { removals: string[]; reason: string } | null;
}

/**
 * Tear a flow down: cancel its work, drop its runtime children, delete the row.
 *
 * Extracted from the DELETE route rather than reimplemented. A second copy of
 * a five-collection cascade would drift from the first, and this codebase has
 * already paid for exactly that — `syncRepoBackedResources` exists because the
 * webhook route kept its own copy of the sync list, so dbt and notebooks
 * silently stopped reaching Mongo. The same divergence here would leave a
 * stream's rows behind after a deletion, or delete some and not others.
 *
 * Deliberately does NOT touch git. The route deletes the file separately
 * (Mongo → git); when a reconcile calls this the file is already gone from the
 * tree, and writing a deletion commit would fight the push that triggered it.
 */
export async function teardownFlow(flow: IFlow): Promise<{
  webhookEvents: number;
  flowExecutions: number;
  cdcChangeEvents: number;
  cdcEntityStates: number;
  cdcStateTransitions: number;
}> {
  const flowOid = flow._id as Types.ObjectId;
  const workspaceOid = flow.workspaceId as Types.ObjectId;
  const flowId = flowOid.toString();

  await inngest.send({ name: "flow.cancel", data: { flowId } });

  const childFilter = { flowId: flowOid, workspaceId: workspaceOid };
  const [webhooks, executions, cdcEvents, entityStates, transitions] =
    await Promise.all([
      WebhookEvent.deleteMany(childFilter),
      FlowExecution.deleteMany(childFilter),
      CdcChangeEvent.deleteMany(childFilter),
      CdcEntityState.deleteMany(childFilter),
      CdcStateTransition.deleteMany(childFilter),
    ]);
  await Flow.deleteOne({ _id: flowOid, workspaceId: workspaceOid });

  const counts = {
    webhookEvents: webhooks.deletedCount ?? 0,
    flowExecutions: executions.deletedCount ?? 0,
    cdcChangeEvents: cdcEvents.deletedCount ?? 0,
    cdcEntityStates: entityStates.deletedCount ?? 0,
    cdcStateTransitions: transitions.deletedCount ?? 0,
  };
  log.info("Flow torn down with cascade cleanup", {
    flowId,
    workspaceId: workspaceOid.toString(),
    deleted: counts,
  });
  return counts;
}

/**
 * Take a pause this module owns, or recognise that we do not need one.
 *
 * A stream that is ALREADY paused is left completely alone — not re-paused,
 * and above all not re-marked. Overwriting `lastEvent` would make someone
 * else's pause look like ours, and the resume at the end of this reconcile
 * would then restart a stream that a repartition (or a person) still needs
 * stopped. Being already paused is not an obstacle here: the stream is not
 * moving, which is the only property the entity drop needs.
 */
async function pauseForReconcile(
  flow: IFlow,
): Promise<{ owned: boolean; previous: IFlow["streamState"] }> {
  if (flow.streamState === "paused") {
    return { owned: false, previous: "paused" };
  }
  const previous = flow.streamState || "idle";
  flow.streamState = "paused";
  flow.syncStateMeta = {
    ...(flow.syncStateMeta || {}),
    lastEvent: RECONCILE_PAUSE,
    lastReason: "Paused to apply a flows/<slug>.yml change",
  };
  flow.syncStateUpdatedAt = new Date();
  await flow.save();
  return { owned: true, previous };
}

/** Lift only OUR pause — never one taken by a repartition or a person. */
async function resumeAfterReconcile(
  flow: IFlow,
  taken: { owned: boolean; previous: IFlow["streamState"] },
): Promise<void> {
  if (!taken.owned) return; // Never lift a pause we did not take.
  if (
    flow.streamState !== "paused" ||
    flow.syncStateMeta?.lastEvent !== RECONCILE_PAUSE
  ) {
    return;
  }
  flow.streamState = taken.previous || "idle";
  flow.syncStateMeta = {
    ...(flow.syncStateMeta || {}),
    lastEvent: RECONCILE_RESUME,
    lastReason: "Resumed after applying a flows/<slug>.yml change",
  };
  flow.syncStateUpdatedAt = new Date();
  await flow.save();
}

/**
 * Entities that have runtime state but are no longer selected.
 *
 * Computed from what is RUNNING rather than from a before/after diff, so the
 * reconcile is idempotent and needs no memory of the previous definition: run
 * it twice and the second run finds nothing to do. A flow with no explicit
 * selection streams everything, so nothing is ever stale for it.
 */
async function staleEntitiesFor(flow: IFlow): Promise<string[]> {
  const { entities, hasExplicitSelection } = resolveConfiguredEntities(flow);
  if (!hasExplicitSelection) return [];
  const selected = new Set(entities);
  const live = await CdcEntityState.find({
    flowId: flow._id,
    workspaceId: flow.workspaceId,
  })
    .select("entity")
    .lean();
  return live
    .map(state => state.entity)
    .filter((entity): entity is string => typeof entity === "string")
    .filter(entity => !selected.has(entity));
}

/**
 * Bring streams in line with the flow files at `treeSha`.
 *
 * The caller owns the definition half: it resolves main, parses the tree, and
 * has already applied field changes to rows. It hands over what the repository
 * says should exist, and the commit it read that from. This module decides
 * what that means for the streams, and refuses anything destructive it cannot
 * justify against the mirror.
 */
export async function reconcileFlowsFromRepo(input: {
  workspaceId: string;
  desired: DesiredFlow[];
  /** The commit `desired` was read at — verified before any teardown. */
  treeSha: string;
  actorUserId?: string;
}): Promise<ReconcileResult> {
  const { workspaceId, desired, treeSha } = input;
  const result: ReconcileResult = {
    reconfigured: [],
    removed: [],
    entitiesDropped: [],
    deferred: null,
  };

  // An empty tree is not a mass deletion. Defence in depth: the caller returns
  // early on an empty `flows/` too, and this is the layer that has to be right
  // even if a future caller forgets.
  if (desired.length === 0) return result;

  const workspaceOid = new Types.ObjectId(workspaceId);
  const desiredIds = new Set(desired.map(d => d.flowId));
  const removals = (
    await Flow.find({ workspaceId: workspaceOid, slug: { $exists: true } })
  ).filter(flow => !desiredIds.has((flow._id as Types.ObjectId).toString()));

  // Is anything destructive on the table? Dropping an entity disposes its
  // checkpoint exactly as a teardown does, so both go behind the same guard.
  const perFlowStale = new Map<string, { flow: IFlow; stale: string[] }>();
  for (const item of desired) {
    const flow = await Flow.findOne({
      _id: new Types.ObjectId(item.flowId),
      workspaceId: workspaceOid,
    });
    if (!flow) continue;
    const stale = await staleEntitiesFor(flow);
    if (stale.length > 0) perFlowStale.set(item.slug, { flow, stale });
  }

  const destructive = removals.length > 0 || perFlowStale.size > 0;
  let verified = !destructive;
  if (destructive) {
    try {
      await assertTreeAtMirrorMain(workspaceId, treeSha);
      verified = true;
    } catch (error) {
      if (!(error instanceof TreeNotVerifiedError)) throw error;
      verified = false;
      result.deferred = {
        removals: removals.map(f => f.slug ?? String(f._id)),
        reason: error.message,
      };
      // Not an error-level event: refusing is the designed behaviour, and the
      // next push retries. Loud enough to explain a deletion that has not
      // happened yet, which is the question this will be asked.
      log.warn(
        "Deferred a destructive flow reconcile: the tree could not be verified against the mirror",
        {
          workspaceId,
          treeSha,
          flowsAwaitingTeardown: result.deferred.removals,
          entitiesAwaitingDrop: [...perFlowStale.keys()],
          reason: error.message,
        },
      );
    }
  }

  if (verified) {
    for (const [slug, { flow, stale }] of perFlowStale) {
      const taken = await pauseForReconcile(flow);
      try {
        await CdcEntityState.deleteMany({
          flowId: flow._id,
          workspaceId: workspaceOid,
          entity: { $in: stale },
        });
        await CdcChangeEvent.deleteMany({
          flowId: flow._id,
          workspaceId: workspaceOid,
          entity: { $in: stale },
        });
        result.entitiesDropped.push({ slug, entities: stale });
        log.info("Dropped entities removed from a flow's selection", {
          workspaceId,
          slug,
          entities: stale,
        });
      } finally {
        // Always resume, including when the drop threw: a stream left paused
        // by a failed reconcile stops moving and nothing else lifts it.
        await resumeAfterReconcile(flow, taken);
      }
      result.reconfigured.push(slug);
    }

    for (const flow of removals) {
      await teardownFlow(flow);
      result.removed.push(flow.slug ?? String(flow._id));
    }
  }

  if (
    result.reconfigured.length > 0 ||
    result.removed.length > 0 ||
    result.deferred
  ) {
    log.info("Flow stream reconcile complete", {
      workspaceId,
      treeSha,
      reconfigured: result.reconfigured.length,
      removed: result.removed.length,
      deferred: result.deferred ? result.deferred.removals.length : 0,
    });
  }
  return result;
}
