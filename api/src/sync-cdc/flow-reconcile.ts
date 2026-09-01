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
export interface PlannedFlow {
  slug: string;
  file: FlowFile;
  /**
   * The row this file corresponds to, when one exists yet. Optional because
   * the useful moment to ask "what would this do?" is BEFORE anything has
   * been created — an agent about to push has a file and no row.
   */
  flowId?: string;
  /**
   * True when this file has NOT been written onto its row yet, so the row's
   * entity selection is still the old one.
   *
   * The live caller applies every changed definition before reconciling, so
   * the row IS the file and reading the row is right. A pre-push dry-run has
   * applied nothing: reading the row there would answer "what would happen if
   * I pushed nothing", which for the one failure mode this exists to catch —
   * an entity silently dropped from the selection — is always "nothing". The
   * push would run `applyDefinition` first (it writes `entityFilter` and
   * `entityLayouts` straight from the file), so for a file whose contents
   * differ from the tree the FILE's selection is the honest prediction.
   *
   * Defaults to false, i.e. the live behaviour. A file identical to the one
   * already in the tree must leave this false: the sync path short-circuits
   * on a matching blob sha and applies nothing, so the row's own selection
   * still stands.
   */
  pendingApply?: boolean;
}

/** A {@link PlannedFlow} the caller has already applied to a row. */
export interface DesiredFlow extends PlannedFlow {
  flowId: string;
}

/**
 * What a tree would do to the streams. Every field is a slug, so a caller can
 * print it without another lookup.
 */
export interface ReconcilePlan {
  /** Files with no matching row — the caller would create these. */
  wouldCreate: string[];
  /** Flows whose selection has entities still running that it no longer wants. */
  wouldReconfigure: Array<{ slug: string; entities: string[] }>;
  /** Flows whose file is gone: teardown, and their checkpoints with it. */
  wouldTeardown: string[];
  /**
   * Whether the fail-closed guard is engaged, and what it says. "would-defer"
   * is as real an answer as a teardown list — it means the destructive work
   * waits for a push where the tree can be verified.
   *
   * "unevaluated" is the pre-push answer and the only honest one there: the
   * guard compares the commit the files were read at against the mirror's
   * main, and files that have not been pushed are not a commit. Reporting
   * "verified" for them — by handing the guard the mirror's current main —
   * would be a true statement about the mirror dressed up as a promise about
   * the caller's working tree.
   */
  guard: {
    required: boolean;
    verdict: "not-needed" | "verified" | "would-defer" | "unevaluated";
    reason?: string;
  };
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
async function staleEntitiesFor(
  flow: IFlow,
  /**
   * Where the selection is read from. The row, normally — see
   * {@link PlannedFlow.pendingApply} for the one case where the file is the
   * honest source instead.
   */
  selection: Pick<IFlow, "entityFilter" | "entityLayouts">,
): Promise<string[]> {
  const { entities, hasExplicitSelection } =
    resolveConfiguredEntities(selection);
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
/**
 * What a tree WOULD do, decided once and used twice.
 *
 * The dry-run and the real reconcile share this function rather than each
 * deciding for itself, because a predictor that drifts from the thing it
 * predicts is worse than no predictor: it earns trust and then spends it on a
 * wrong answer. Same lesson as `syncRepoBackedResources` — one list, both
 * callers — applied to a decision rather than a list.
 *
 * Reads only. The destructive half lives in {@link reconcileFlowsFromRepo},
 * which calls this first and then acts on what it says.
 */
async function computePlan(input: {
  workspaceId: string;
  desired: PlannedFlow[];
  /**
   * The commit `desired` was read at. Omitted only by a pre-push dry-run,
   * where there is no such commit — see {@link ReconcilePlan.guard}.
   */
  treeSha?: string;
}): Promise<{
  plan: ReconcilePlan;
  removals: IFlow[];
  perFlowStale: Map<string, { flow: IFlow; stale: string[] }>;
}> {
  const { workspaceId, desired, treeSha } = input;
  const empty = {
    plan: {
      wouldCreate: [],
      wouldReconfigure: [],
      wouldTeardown: [],
      guard: { required: false, verdict: "not-needed" as const },
    },
    removals: [] as IFlow[],
    perFlowStale: new Map<string, { flow: IFlow; stale: string[] }>(),
  };

  // An empty tree is not a mass deletion. Defence in depth: the caller returns
  // early on an empty `flows/` too, and this is the layer that has to be right
  // even if a future caller forgets.
  if (desired.length === 0) return empty;

  const workspaceOid = new Types.ObjectId(workspaceId);
  const existing = await Flow.find({
    workspaceId: workspaceOid,
    slug: { $exists: true },
  });

  // Identity is the SLUG, because the slug is the file name and "the file is
  // gone" is the condition being tested. Matching only on the row id would be
  // right for the live path — the caller has applied rows by then — and wrong
  // for a dry-run performed BEFORE anything is applied, where no id exists yet
  // and every flow would look like a removal. The id is still honoured when
  // present, so a rename in flight cannot tear down the row it renamed.
  const desiredSlugs = new Set(desired.map(d => d.slug));
  const desiredIds = new Set(
    desired.map(d => d.flowId).filter((id): id is string => Boolean(id)),
  );
  const removals = existing.filter(flow => {
    const id = (flow._id as Types.ObjectId).toString();
    if (desiredIds.has(id)) return false;
    return !(flow.slug && desiredSlugs.has(flow.slug));
  });

  const bySlug = new Map<string, IFlow>();
  for (const flow of existing) {
    if (flow.slug) bySlug.set(flow.slug, flow);
  }
  const wouldCreate = desired
    .filter(d => !bySlug.has(d.slug))
    .map(d => d.slug)
    .sort();

  // Dropping an entity disposes its checkpoint exactly as a teardown does, so
  // both sit behind the same guard and both belong in the same plan.
  const perFlowStale = new Map<string, { flow: IFlow; stale: string[] }>();
  for (const item of desired) {
    const flow = bySlug.get(item.slug);
    if (!flow) continue;
    const stale = await staleEntitiesFor(
      flow,
      item.pendingApply
        ? ({
            entityFilter: item.file.entityFilter,
            entityLayouts: item.file.entityLayouts,
          } as unknown as Pick<IFlow, "entityFilter" | "entityLayouts">)
        : flow,
    );
    if (stale.length > 0) perFlowStale.set(item.slug, { flow, stale });
  }

  const required = removals.length > 0 || perFlowStale.size > 0;
  let guard: ReconcilePlan["guard"] = {
    required: false,
    verdict: "not-needed",
  };
  if (required && treeSha === undefined) {
    // Nothing to verify against: these files are not a commit. Saying so is
    // the whole point — the alternative (hand the guard the mirror's current
    // main, which of course matches itself) would report "verified" about a
    // tree that does not contain the files being judged.
    guard = {
      required: true,
      verdict: "unevaluated",
      reason:
        "The fail-closed mirror check runs at push time against the pushed commit. These files have not been pushed, so nothing can be verified yet: whether the destructive work above actually runs is decided when the push lands.",
    };
  } else if (required) {
    try {
      await assertTreeAtMirrorMain(workspaceId, treeSha as string);
      guard = { required: true, verdict: "verified" };
    } catch (error) {
      if (!(error instanceof TreeNotVerifiedError)) throw error;
      guard = {
        required: true,
        verdict: "would-defer",
        reason: error.message,
      };
    }
  }

  return {
    plan: {
      wouldCreate,
      wouldReconfigure: [...perFlowStale.entries()]
        .map(([slug, { stale }]) => ({ slug, entities: stale }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
      wouldTeardown: removals.map(f => f.slug ?? String(f._id)).sort(),
      guard,
    },
    removals,
    perFlowStale,
  };
}

/**
 * Say what a tree would do to the streams, and do nothing.
 *
 * The agent-authored case (RFC: agent-authored flows) is why this exists. A
 * model's failure mode is not a typo — a typo fails to parse. It is OMITTING
 * a file, or an entity, with complete confidence. Both of those are the
 * destructive path: a missing file is a teardown, a missing entity disposes
 * that entity's checkpoint. `assertTreeAtMirrorMain` does not help there,
 * because a confidently wrong file pushes successfully and verifies fine. The
 * guard protects against reading the WRONG tree; this protects against the
 * tree being wrong.
 *
 * Takes `flowId` optionally, so it answers before any row has been created —
 * which is the moment worth asking, i.e. before the push.
 *
 * `treeSha` is optional for the same reason. Omit it when the files are not a
 * pushed commit, and the guard reports "unevaluated" rather than a verdict
 * about some other tree.
 */
export async function dryRunFlowReconcile(input: {
  workspaceId: string;
  desired: PlannedFlow[];
  treeSha?: string;
}): Promise<ReconcilePlan> {
  const { plan } = await computePlan(input);
  return plan;
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
  const { workspaceId, treeSha } = input;
  const result: ReconcileResult = {
    reconfigured: [],
    removed: [],
    entitiesDropped: [],
    deferred: null,
  };

  const { plan, removals, perFlowStale } = await computePlan(input);
  const workspaceOid = new Types.ObjectId(workspaceId);

  // Fail closed on ANY verdict that is not an affirmative "verified": the
  // live path always passes a treeSha, so "unevaluated" cannot occur here —
  // and if a future caller stops passing one, deferring is the safe way to
  // find out rather than tearing streams down against an unchecked tree.
  if (plan.guard.required && plan.guard.verdict !== "verified") {
    result.deferred = {
      removals: plan.wouldTeardown,
      reason: plan.guard.reason ?? "the tree could not be verified",
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
        reason: result.deferred.reason,
      },
    );
    return result;
  }

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

  if (result.reconfigured.length > 0 || result.removed.length > 0) {
    log.info("Flow stream reconcile complete", {
      workspaceId,
      treeSha,
      reconfigured: result.reconfigured.length,
      removed: result.removed.length,
    });
  }
  return result;
}
