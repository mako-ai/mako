/**
 * `flows/<slug>.yml` → Mongo: the push reactor half of RFC #904 (block 3).
 *
 * Block 2 made the file a projection of the row. This makes the file
 * authoritative: a push that changes `flows/<slug>.yml` changes the flow.
 *
 * Structure mirrors `dbt/dbt-config.service.ts#syncDbtConfigNow` deliberately
 * — same tree read, same `sourceBlobSha` short-circuit. Invalid files are
 * marked on the row and never replaced by Mongo: a broken YAML must not be
 * "healed" from the derived cache.
 *
 * GET/list serves the files at main and overlays Mongo for slug, runtime,
 * SHA, cursors, webhook, and sync state (issue #956, same contract as
 * consoles). Leftover local git without a GitHub binding is not a read
 * surface — `boundRepoDirIfExists` / `getWorkspaceRepo` gate every walk.
 *
 *  1. A flow is a RUNNING STREAM. 31 of 31 production flows are CDC, so a
 *     definition change has to reconcile something live rather than change
 *     what the next run does. That reconciliation is deliberately NOT here —
 *     it is behind {@link FlowReconciler}, owned by the CDC lane — so this
 *     module stays a pure definition mapper that can be read and reviewed on
 *     its own.
 *  2. A file that disappears means a stream teardown plus checkpoint
 *     disposal, not just a deleted row. That is why the empty-tree guard
 *     below is a hard precondition rather than an optimisation.
 *
 * Runtime state is never written from a file. The cursor fields in
 * particular (`incrementalConfig.lastValue`, `paginationConfig.lastKeysetValue`,
 * `backfillSchedule.lastRunAt`) move on every sync, and `webhookConfig`
 * carries both a credential and the inbound URL identity that must survive a
 * rename. The file format already excludes all of them; this module must not
 * reintroduce them by writing whole nested objects.
 */
import mongoose, { Types, type Connection } from "mongoose";
import {
  flowFileConnectionRefusal,
  flowFilesConnectionRefusals,
} from "./flow-connection-scope";
import {
  applyDefinition,
  clearFlowInvalid,
  derivedFlowId,
  flowFileApplyFailure,
  isFlowMarkedInvalid,
  markFlowInvalid,
  mintedWebhookEndpoint,
  rowInvalidMarker,
  setLayoutWarnings,
} from "./flow-definition-apply";

import {
  ensureLocalRepo,
  freshenBeforeMainWrite,
} from "../apps/cloud-repo.service";
import {
  blobOid,
  DEFAULT_BRANCH,
  listTree,
  readBlob,
  readBlobsBatch,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "../apps/repository.service";
import { boundRepoDirIfExists } from "../apps/workspace-repo-required";
import { Flow, WebhookEvent, type IFlow } from "../database/workspace-schema";
import { commitIsAncestor } from "../apps/git";
import { randomUUID } from "node:crypto";
import { inngest } from "../inngest/client";
import { loggers } from "../logging";
import {
  formatLayoutMismatches,
  snapshotLayouts,
  splitLayoutMismatches,
  toLayoutWarnings,
} from "../sync-cdc/layout-table-check";
import { flowEntitySignature } from "../sync-cdc/entity-selection";
import {
  reconcileFlowsFromRepo,
  type DesiredFlow,
} from "../sync-cdc/flow-reconcile";
import {
  flowToFile,
  parseFlowFile,
  slugFromFlowFilePath,
  type FlowFile,
} from "./flow-config-files";
import { hasWebhookTrigger, isWebhookFlow } from "./flow-triggers.service";
import { getWorkspaceRepo } from "./workspace-repos.service";

// Moved to flow-definition-apply.ts; re-exported so importers keep this path.
export {
  derivedFlowId,
  hydrateFlowRow,
  isFlowMarkedInvalid,
  mintedWebhookEndpoint,
  type HydratedFlowRow,
} from "./flow-definition-apply";

const logger = loggers.api("flow-sync");

class GuardCandidateInvalid extends Error {}

/** Local prototype only. Both writers must opt in to its transaction. */
export interface InternalBindingGuard {
  afterCandidateRead?: (commit: string) => Promise<void>;
  afterRowRead?: (commit: string) => Promise<void>;
  afterLayoutPreflight?: () => Promise<void>;
  beforeFlowWrite?: () => Promise<void>;
  afterFlowWrite?: () => Promise<void>;
  connection?: Connection;
}

/**
 * Conditionally apply an existing row against the last observed Git commit.
 * The local retention seam writes this same Flow row in its transaction.
 */
async function applyGuardedCandidate(
  doc: IFlow,
  repoDir: string,
  commit: string,
  blob: string,
  definition: FlowFile,
  connection: Connection,
  guard: InternalBindingGuard,
): Promise<"applied" | "blocked" | "stale"> {
  const model =
    connection.models.Flow ?? connection.model<IFlow>("Flow", Flow.schema);
  const session = await connection.startSession();
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const basis = await model.findOne({
        _id: doc._id,
        workspaceId: doc.workspaceId,
      });
      if (!basis) return "stale";
      const snapshot = JSON.stringify(basis.toObject());
      const previousLayouts = snapshotLayouts(basis as never);
      const candidate = model.hydrate(basis.toObject());
      const refusal = applyDefinition(candidate, definition);
      if (refusal) throw new GuardCandidateInvalid(refusal);
      const { changed, untouched } = await splitLayoutMismatches(
        candidate as never,
        previousLayouts,
      );
      const layoutRefused = changed.length > 0;
      candidate.layoutWarnings = toLayoutWarnings(untouched, false);
      candidate.sourceBlobSha = blob;
      try {
        await candidate.validate();
      } catch (error) {
        if (error instanceof mongoose.Error.ValidationError) {
          throw new GuardCandidateInvalid(error.message);
        }
        throw error;
      }
      if (guard.afterLayoutPreflight) await guard.afterLayoutPreflight();
      const outcome = await session.withTransaction(async () => {
        const current = await model.collection.findOne(
          { _id: doc._id, workspaceId: doc.workspaceId },
          { session },
        );
        if (!current) return "stale";
        const state = (
          current as unknown as {
            bindingApply?: {
              token: string;
              commit: string;
              desiredBlobSha?: string;
            };
          }
        ).bindingApply;
        // Reject older and divergent commits. An unknown ancestry also throws.
        if (
          state?.commit &&
          state.commit !== commit &&
          !(await commitIsAncestor(repoDir, state.commit, commit))
        ) {
          return "stale";
        }
        const fresh = await model
          .findOne({ _id: doc._id, workspaceId: doc.workspaceId })
          .session(session);
        if (!fresh) return "stale";
        // The table check ran outside Mongo. Never use it for a different row.
        if (JSON.stringify(fresh.toObject()) !== snapshot) return "retry";
        const sourceChanged =
          current.sourceType !== candidate.sourceType ||
          String(current.dataSourceId ?? "") !==
            String(candidate.dataSourceId ?? "");
        if (!connection.db) throw new Error("MongoDB connection is not open");
        const blocked =
          !layoutRefused &&
          sourceChanged &&
          (await connection.db
            .collection(WebhookEvent.collection.collectionName)
            .findOne(
              {
                workspaceId: doc.workspaceId,
                flowId: doc._id,
                status: "dormant",
              },
              { session },
            )) !== null;
        const changes = candidate.$getChanges();
        const update = blocked || layoutRefused ? {} : changes;
        const set = {
          ...((update.$set ?? {}) as Record<string, unknown>),
          bindingApply: {
            ...(layoutRefused ? state : {}),
            token: randomUUID(),
            commit,
            ...(blocked ? { desiredBlobSha: blob } : {}),
            ...(layoutRefused ? { layoutRefusedBlobSha: blob } : {}),
          },
        };
        if (guard.beforeFlowWrite) await guard.beforeFlowWrite();
        const result = await model.collection.updateOne(
          {
            _id: doc._id,
            workspaceId: doc.workspaceId,
            ...(state
              ? { "bindingApply.token": state.token }
              : { bindingApply: { $exists: false } }),
          } as never,
          {
            ...update,
            $set: set,
            ...(!blocked && !layoutRefused
              ? {
                  $unset: {
                    ...((update.$unset ?? {}) as Record<string, unknown>),
                    definitionInvalid: 1,
                  },
                }
              : {}),
          } as never,
          { session },
        );
        if (!result.matchedCount) {
          throw new Error("Flow changed during guarded apply");
        }
        if (guard.afterFlowWrite) await guard.afterFlowWrite();
        return layoutRefused ? "stale" : blocked ? "blocked" : "applied";
      });
      if (outcome !== "retry") return outcome;
    }
    return "stale";
  } finally {
    await session.endSession();
  }
}

/** Record an invalid observation under the same ordering token as valid applies. */
async function markGuardedInvalid(
  doc: IFlow,
  repoDir: string,
  commit: string,
  reason: string,
  path: string,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await Flow.collection.findOne({
      _id: doc._id,
      workspaceId: doc.workspaceId,
    });
    if (!current) return;
    const state = (
      current as unknown as {
        bindingApply?: { token: string; commit: string };
      }
    ).bindingApply;
    if (
      state?.commit &&
      state.commit !== commit &&
      !(await commitIsAncestor(repoDir, state.commit, commit))
    ) {
      return;
    }
    const result = await Flow.collection.updateOne(
      {
        _id: doc._id,
        workspaceId: doc.workspaceId,
        ...(state
          ? { "bindingApply.token": state.token }
          : { bindingApply: { $exists: false } }),
      } as never,
      {
        $set: {
          bindingApply: { token: randomUUID(), commit },
          definitionInvalid: { reason, at: new Date(), path },
          ...(current.schedule ? { "schedule.enabled": false } : {}),
          ...(current.backfillSchedule
            ? { "backfillSchedule.enabled": false }
            : {}),
        },
      } as never,
    );
    if (result.matchedCount) return;
  }
}

export interface FlowDefinitionAtMain {
  path: string;
  slug: string;
  oid: string;
  contents: string;
  parsed: FlowFile | null;
}

export interface LiveFlow {
  def: FlowDefinitionAtMain;
  row: IFlow | null;
  id: Types.ObjectId;
  /**
   * Why the reactor would refuse this file's connections (another
   * workspace's, or missing), or null. GET/list shows such a flow invalid
   * and never overlays its ids (flow-connection-scope.ts).
   */
  connectionRefusal: string | null;
}

function rowAsPlain(row: IFlow): Record<string, unknown> {
  const maybeToObject = row as IFlow & {
    toObject?: () => Record<string, unknown>;
  };
  if (typeof maybeToObject.toObject === "function") {
    return maybeToObject.toObject();
  }
  return { ...(row as unknown as Record<string, unknown>) };
}

/**
 * Authored flow files at `main`. Empty when no GitHub repo is bound —
 * leftover local git is not a definition store (issue #956). Never throws
 * `RepoRequiredError`; a missing binding is an empty list, not 412.
 */
export async function listFlowDefinitionsAtMain(
  workspaceId: string,
): Promise<FlowDefinitionAtMain[]> {
  const { files } = await readFlowFilesAtMain(workspaceId, { freshen: false });
  const defs: FlowDefinitionAtMain[] = [];
  for (const { path, contents } of files) {
    const slug = slugFromFlowFilePath(path);
    if (!slug) continue;
    defs.push({
      path,
      slug,
      oid: blobOid(contents),
      contents,
      parsed: parseFlowFile(contents),
    });
  }
  return defs;
}

function flowIndexDrift(defs: FlowDefinitionAtMain[], rows: IFlow[]): boolean {
  const bySlug = new Map<string, IFlow>();
  for (const row of rows) {
    if (row.slug) bySlug.set(row.slug, row);
  }
  for (const def of defs) {
    const row = bySlug.get(def.slug);
    if (!row) continue;
    if (row.sourceBlobSha !== def.oid) return true;
    if (isFlowMarkedInvalid(row) && def.parsed) return true;
  }
  return false;
}

/**
 * SHA-check derived rows against blobs at main; resync matching rows on
 * mismatch. Does not create, delete, or CDC-reconcile — GET/list must not
 * tear down streams. Git-only files stay git-only until push-sync.
 */
export async function ensureFlowsDerivedCache(
  workspaceId: string,
): Promise<"ok" | "resynced" | "unbound"> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return "unbound";
  const defs = await listFlowDefinitionsAtMain(workspaceId);
  const rows = await Flow.find({ workspaceId });
  if (!flowIndexDrift(defs, rows)) return "ok";
  const bySlug = new Map<string, IFlow>();
  for (const row of rows) {
    if (row.slug) bySlug.set(row.slug, row);
  }
  for (const def of defs) {
    const row = bySlug.get(def.slug);
    if (row) await ensureFlowDerivedCache(row);
  }
  return "resynced";
}

async function joinLiveFlows(
  workspaceId: string,
  defs: FlowDefinitionAtMain[],
  rows: IFlow[],
): Promise<LiveFlow[]> {
  const bySlug = new Map<string, IFlow>();
  for (const row of rows) {
    if (row.slug) bySlug.set(row.slug, row);
  }
  const refusals = await flowFilesConnectionRefusals(
    workspaceId,
    defs.map(def => def.parsed),
  );
  return defs.map((def, i) => {
    const row = bySlug.get(def.slug) ?? null;
    return {
      def,
      row,
      id: row?._id ?? derivedFlowId(workspaceId, def.slug),
      connectionRefusal: refusals[i],
    };
  });
}

/**
 * Live flows: files at main, overlaying the Mongo index.
 *
 * Unbound workspace → `[]` (leftover Mongo rows and leftover local git do
 * not populate the list). Git-only files appear; Mongo-only rows do not.
 */
export async function loadLiveFlows(workspaceId: string): Promise<LiveFlow[]> {
  const status = await ensureFlowsDerivedCache(workspaceId);
  if (status === "unbound") return [];
  const defs = await listFlowDefinitionsAtMain(workspaceId);
  const rows = await Flow.find({ workspaceId });
  return joinLiveFlows(workspaceId, defs, rows);
}

/**
 * Resolve a flow id for GET. Live only when `flows/<slug>.yml` exists at
 * main. Unbound or Mongo-only → `null` (404).
 */
export async function loadLiveFlowById(
  workspaceId: string,
  flowId: string,
): Promise<LiveFlow | null> {
  if (!Types.ObjectId.isValid(flowId)) return null;
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return null;

  const row = await Flow.findOne({
    _id: new Types.ObjectId(flowId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (row?.slug) {
    const defs = await listFlowDefinitionsAtMain(workspaceId);
    const def = defs.find(item => item.slug === row.slug);
    if (!def) return null;
    if (row.sourceBlobSha !== def.oid || isFlowMarkedInvalid(row)) {
      await ensureFlowDerivedCache(row);
    }
    const [connectionRefusal] = await flowFilesConnectionRefusals(workspaceId, [
      def.parsed,
    ]);
    return { def, row, id: row._id, connectionRefusal };
  }

  const live = await loadLiveFlows(workspaceId);
  return live.find(item => item.id.toString() === flowId) ?? null;
}

/**
 * Git definition overlaid on the Mongo runtime row (or a stub when the
 * file has no row). The body comes from the file when it parses AND
 * applies; a file the reactor would refuse must not look valid in GET.
 */
export function liveFlowToPlain(
  live: LiveFlow,
  workspaceId: string,
): Record<string, unknown> {
  return withoutHalfDefinedConfigs(overlayFlow(live, workspaceId));
}

/**
 * Mongoose materialises unset nested paths: a row that never had incremental
 * or conflict settings reads back as `incrementalConfig: {}` and
 * `conflictConfig: { strategy: "update" }`. The client's flow schema requires
 * the keys inside those blocks, so one such row failed validation for the
 * whole persisted flow list and it was never cached. An incremental block
 * without its tracking column means "not incremental"; a conflict block
 * defaults its key columns to none.
 */
function withoutHalfDefinedConfigs(
  plain: Record<string, unknown>,
): Record<string, unknown> {
  const incremental = plain.incrementalConfig as
    { trackingColumn?: unknown; trackingType?: unknown } | null | undefined;
  if (
    incremental &&
    (!incremental.trackingColumn || !incremental.trackingType)
  ) {
    delete plain.incrementalConfig;
  }
  const conflict = plain.conflictConfig as
    { keyColumns?: unknown; strategy?: unknown } | null | undefined;
  if (conflict && !conflict.strategy) {
    delete plain.conflictConfig;
  } else if (conflict && !Array.isArray(conflict.keyColumns)) {
    plain.conflictConfig = { ...conflict, keyColumns: [] };
  }
  return plain;
}

function overlayFlow(
  live: LiveFlow,
  workspaceId: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = live.row
    ? rowAsPlain(live.row)
    : {
        _id: live.id,
        workspaceId: new Types.ObjectId(workspaceId),
        slug: live.def.slug,
        createdBy: "git",
        runCount: 0,
        sourceType: "connector",
        // Whole shape for a file with no row yet: the client's schema
        // requires these, and one half-defined item used to fail the whole
        // persisted flow list's validation (every reload cold-started).
        name: live.def.slug,
        syncMode: "full",
        enabled: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
  base._id = live.id;
  base.slug = live.def.slug;
  base.workspaceId = live.row?.workspaceId ?? new Types.ObjectId(workspaceId);
  const parsed = live.def.parsed;
  const createdBy =
    typeof live.row?.createdBy === "string" && live.row.createdBy
      ? live.row.createdBy
      : "git";
  if (!parsed) {
    base.definitionInvalid = rowInvalidMarker(live.row) ?? {
      reason: "unparseable flow file",
      at: new Date(),
      path: live.def.path,
    };
    base.sourceBlobSha = live.def.oid;
    return base;
  }
  const applyFailure = flowFileApplyFailure(parsed, {
    workspaceId,
    slug: live.def.slug,
    createdBy,
  });
  // A file naming another workspace's connection: invalid, and none of its
  // ids reach the view (the row keeps its last good definition).
  const refusal = applyFailure ?? live.connectionRefusal;
  if (refusal) {
    base.definitionInvalid = rowInvalidMarker(live.row) ?? {
      reason: refusal,
      at: new Date(),
      path: live.def.path,
    };
    base.sourceBlobSha = live.def.oid;
    return base;
  }
  applyDefinition(base as unknown as IFlow, parsed);
  base.sourceBlobSha = live.def.oid;
  delete base.definitionInvalid;
  return base;
}

/**
 * SHA-check the derived cache against `flows/<slug>.yml` at main.
 * Resyncs the row when the blob moved; never writes Mongo over an invalid file.
 * Leftover local git without a GitHub binding is ignored — runtime keeps
 * the SHA-checked Mongo cache (issue #956).
 */
export async function ensureFlowDerivedCache(
  flow: {
    _id: { toString(): string };
    workspaceId: { toString(): string };
    slug?: string;
    sourceBlobSha?: string;
    definitionInvalid?: { reason: string } | null;
  },
  guard?: InternalBindingGuard,
): Promise<"ok" | "invalid" | "missing" | "resynced"> {
  if (!flow.slug) return "ok";
  const workspaceId = flow.workspaceId.toString();
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) {
    return isFlowMarkedInvalid(flow) ? "invalid" : "ok";
  }
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!head) return isFlowMarkedInvalid(flow) ? "invalid" : "ok";
  const path = `flows/${flow.slug}.yml`;
  const mark = (row: IFlow, reason: string) =>
    guard
      ? markGuardedInvalid(row, repoDir, head, reason, path)
      : markFlowInvalid(row, reason, path);
  let contents: string;
  try {
    const blob = await readBlob(repoDir, head, path);
    if (blob.isBinary) {
      const row = await Flow.findById(flow._id);
      if (row) await mark(row, "binary flow file");
      return "invalid";
    }
    contents = blob.contents;
  } catch {
    const row = await Flow.findById(flow._id);
    if (row) await mark(row, "flow file missing at main");
    return "missing";
  }
  const sha = blobOid(contents);
  if (guard?.afterCandidateRead) await guard.afterCandidateRead(head);
  const wasMarked = isFlowMarkedInvalid(flow);
  if (!guard && flow.sourceBlobSha === sha && !wasMarked) return "ok";
  const parsed = parseFlowFile(contents);
  const row = await Flow.findById(flow._id);
  if (!row) return "missing";
  if (guard?.afterRowRead) await guard.afterRowRead(head);
  if (!parsed) {
    await mark(row, "unparseable flow file");
    return "invalid";
  }
  let refusal: string | null = await flowFileConnectionRefusal(
    workspaceId,
    parsed,
  );
  const previousLayouts = snapshotLayouts(row as never);
  if (!refusal) {
    try {
      refusal = applyDefinition(row, parsed);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
  }
  if (refusal) {
    await mark(row, refusal);
    return "invalid";
  }
  // A changed layout that disagrees with its table is not applied, and the
  // flow is neither paused nor flagged: it keeps running on the stored
  // definition (the same rule as the push in syncFlowsFromRepo).
  const { changed: layoutMismatches, untouched } = guard
    ? { changed: [], untouched: [] }
    : await splitLayoutMismatches(row as never, previousLayouts);
  if (layoutMismatches.length > 0) {
    logger.warn("Flow file layout does not match its table; not applied", {
      workspaceId,
      path,
      reason: formatLayoutMismatches(layoutMismatches),
    });
    await setLayoutWarnings(row._id, [
      ...toLayoutWarnings(layoutMismatches, true),
      ...toLayoutWarnings(untouched, false),
    ]);
    return wasMarked ? "invalid" : "ok";
  }
  row.layoutWarnings = toLayoutWarnings(untouched, false);
  row.sourceBlobSha = sha;
  try {
    if (guard) {
      const outcome = await applyGuardedCandidate(
        row,
        repoDir,
        head,
        sha,
        parsed,
        guard.connection ?? mongoose.connection,
        guard,
      );
      if (outcome !== "applied") return "ok";
    } else {
      await row.save();
    }
  } catch (error) {
    if (guard) {
      if (!(error instanceof GuardCandidateInvalid)) throw error;
      await mark(row, error.message);
      return "invalid";
    }
    // applyDefinition already mutated `row`. Saving that document again
    // (via markFlowInvalid) would re-raise the same ValidationError and
    // 500 GET/list. Reload the persisted row, then stamp invalid.
    const reason = error instanceof Error ? error.message : String(error);
    const fresh = await Flow.findById(flow._id);
    if (fresh) await mark(fresh, reason);
    return "invalid";
  }
  if (wasMarked && !guard) await clearFlowInvalid(row._id);
  return "resynced";
}

export type LiveFlowRowResolution =
  | { ok: true; live: LiveFlow; row: IFlow }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Resolve a flow id for a mutation or a run: the file must be live at main
 * AND the index row must exist. A file that only lives in git (the push has
 * not been reconciled yet) is a 409 with the reason, not a bare 404 — the
 * list just showed the flow. A row whose file was deleted is not live and
 * resolves to nothing, so it can no longer be run from the UI.
 */
export async function resolveLiveFlowRow(
  workspaceId: string,
  flowId: string,
): Promise<LiveFlowRowResolution> {
  const live = await loadLiveFlowById(workspaceId, flowId);
  if (!live) return { ok: false, status: 404, error: "Flow not found" };
  if (!live.row) {
    return {
      ok: false,
      status: 409,
      error: `Flow "${live.def.slug}" exists only in git so far (${live.def.path}); it becomes runnable and editable once the push is synced.`,
    };
  }
  return { ok: true, live, row: live.row };
}

export interface FlowSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  invalid: string[];
  /** Slugs whose destructive reconcile was refused; see ReconcileResult. */
  deferred: string[];
}

/** Every `flows/*.yml` in the workspace repo at main, with the commit read. */
export interface FlowFilesAtMain {
  /** The commit the files were read at; null when there is no repo/main. */
  commit: string | null;
  files: Array<{ path: string; contents: string }>;
}

/**
 * Read `flows/*.yml` from the workspace repo's main branch.
 *
 * Extracted so the push reactor below and the pre-push checker
 * (`agent-lib/tools/flow-file-tools.ts`) read the same set the same way. A
 * second copy of this walk is exactly the drift `syncRepoBackedResources`
 * exists to prevent — and here it would be worse than a missed sync: the
 * checker's whole job is to predict what the reactor will do, and a predictor
 * reading a different set of files predicts nothing.
 *
 * `freshen` is the difference between the two callers and is deliberately
 * explicit. The reactor is about to DELETE, so it must judge against the
 * mirror's main rather than this instance's cache (#894/#897). The checker
 * writes nothing and is not allowed to reset a shared local repo as a side
 * effect of a read, so it takes the cache as it finds it and reports the
 * commit it read.
 *
 * A GitHub binding is required. Leftover Cloud Storage git without a
 * binding is not a definition store (issue #956) — GET/list and the
 * checker both return empty rather than walking it.
 */
export async function readFlowFilesAtMain(
  workspaceId: string,
  options: { freshen: boolean },
): Promise<FlowFilesAtMain> {
  const none: FlowFilesAtMain = { commit: null, files: [] };

  if (!(await getWorkspaceRepo(workspaceId))) return none;
  if (options.freshen) {
    await ensureLocalRepo(workspaceId);
    await freshenBeforeMainWrite(workspaceId);
  }
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return none;

  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!head) return none;

  const paths = (await listTree(repoDir, head))
    .map(e => e.path)
    .filter(p => slugFromFlowFilePath(p) !== null);
  if (paths.length === 0) return { commit: head, files: [] };

  const blobs = await readBlobsBatch(repoDir, head, paths);
  return {
    commit: head,
    files: [...blobs.entries()].map(([path, buf]) => ({
      path,
      contents: buf.toString("utf8"),
    })),
  };
}

/**
 * Reconcile every flow row in a workspace against `flows/*.yml` at main.
 *
 * Idempotent: a file whose blob sha matches the row's `sourceBlobSha` costs a
 * read and nothing else.
 *
 * `actorUserId` is whoever pushed, when the push came through Mako's own git
 * endpoint; a push made directly on GitHub arrives as a webhook with no actor
 * and gets the same `"sync"` author the dbt job sync uses. It only matters on
 * CREATE: `createdBy` is required on the schema, and a new row without one
 * does not fail quietly — `save()` throws, and before this was threaded that
 * throw escaped the per-file loop, so a single new file aborted the rest of
 * the push's sync and the reconciler with it. Nothing anyone could see.
 */
export async function syncFlowsFromRepo(
  workspaceId: string,
  actorUserId?: string,
  guard?: InternalBindingGuard,
): Promise<FlowSyncResult> {
  const empty: FlowSyncResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    invalid: [],
    deferred: [],
  };

  // A reconcile that DELETES must be judged against the mirror's main, never
  // this instance's cache: `ensureLocalRepo` returns early once the directory
  // exists and never refreshes it.
  const { commit: head, files } = await readFlowFilesAtMain(workspaceId, {
    freshen: true,
  });
  if (!head) return empty;
  if (guard?.afterCandidateRead) await guard.afterCandidateRead(head);

  // No flows/ in the repo at all → this workspace has not adopted flows as
  // code. Leave Mongo alone. Without this an empty or partial tree would read
  // as "every flow was deleted" and tear down every running stream.
  if (files.length === 0) return empty;

  const result: FlowSyncResult = { ...empty, invalid: [] };
  const desired: DesiredFlow[] = [];
  const webhookResyncs: IFlow[] = [];
  const seen = new Set<string>();

  for (const { path, contents } of files) {
    const slug = slugFromFlowFilePath(path);
    if (!slug) continue;
    seen.add(slug);

    const sha = blobOid(contents);
    const parsedForDesired = parseFlowFile(contents);
    const row = await Flow.findOne({ workspaceId, slug });
    if (guard?.afterRowRead) await guard.afterRowRead(head);
    const mark = (candidate: IFlow, reason: string) =>
      guard
        ? markGuardedInvalid(
            candidate,
            repoDirFor(workspaceId),
            head,
            reason,
            path,
          )
        : markFlowInvalid(candidate, reason, path);
    // The desired set is EVERY file present, not only the changed ones: the
    // reconciler derives removals from it, so omitting an unchanged file would
    // read as "this flow was deleted" and tear down a live stream.
    //
    // That includes a file that does not PARSE. "Keeping the current row" has
    // to mean the reconciler sees the row too, or the definition half keeps
    // it while the stream half tears it down and disposes its checkpoints — a
    // YAML typo as a teardown. So the row's own current definition stands in
    // for the file: same slug, same selection, nothing stale, nothing removed.
    if (row) {
      desired.push({
        slug,
        file: parsedForDesired ?? flowToFile(row),
        flowId: String(row._id),
      });
    }

    // Level already — unless the row is still flagged from an earlier bad
    // version and the file was reverted to this exact content, in which
    // case the marker must clear.
    if (
      !guard &&
      row &&
      row.sourceBlobSha === sha &&
      !isFlowMarkedInvalid(row)
    ) {
      result.unchanged++;
      continue;
    }

    const parsed = parsedForDesired;
    if (!parsed) {
      logger.warn("Flow file is invalid; not overwriting from Mongo", {
        workspaceId,
        path,
      });
      if (row) {
        await mark(row, "unparseable flow file");
      }
      result.invalid.push(slug);
      continue;
    }

    // Same "applies" predicate GET/list uses: a file the list flags must
    // never be indexed here, and one the list shows as valid must not be
    // what throws below.
    const applyFailure = flowFileApplyFailure(parsed, {
      workspaceId,
      slug,
      createdBy: row?.createdBy || actorUserId || "sync",
    });
    if (applyFailure) {
      logger.warn("Flow file does not apply; not overwriting from Mongo", {
        workspaceId,
        path,
        reason: applyFailure,
      });
      if (row) await mark(row, applyFailure);
      result.invalid.push(slug);
      continue;
    }

    // A file may only name this workspace's connections.
    const foreign = await flowFileConnectionRefusal(workspaceId, parsed);
    if (foreign) {
      logger.warn("Flow file names another workspace's connection", {
        workspaceId,
        path,
        reason: foreign,
      });
      if (row) await mark(row, foreign);
      result.invalid.push(slug);
      continue;
    }

    const isNew = !row;
    const previousFile = guard && row ? flowToFile(row) : undefined;
    const wasInvalid = row ? isFlowMarkedInvalid(row) : false;
    const entitySignatureBefore = row ? flowEntitySignature(row as IFlow) : "";
    const doc =
      row ??
      new Flow({
        _id: derivedFlowId(workspaceId, slug),
        workspaceId,
        slug,
        createdBy: actorUserId ?? "sync",
      });
    // `applyDefinition` refuses with a reason, but it can also THROW: an id
    // that is not an ObjectId (`connector_id: close` — a name where an id
    // belongs, the likeliest agent mistake) fails inside `new ObjectId()`.
    // Same treatment as a refusal; see the save() catch below for why it
    // must not escape.
    const previousLayouts = row ? snapshotLayouts(row as never) : undefined;
    let refusal: string | null;
    try {
      refusal = applyDefinition(doc as IFlow, parsed);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    if (refusal) {
      logger.warn("Flow file cannot be applied; not overwriting from Mongo", {
        workspaceId,
        path,
        reason: refusal,
      });
      if (row) {
        await mark(row, refusal);
      }
      result.invalid.push(slug);
      continue;
    }
    // A layout that disagrees with the table it writes is refused for a NEW
    // flow and for a layout this push adds or edits. An existing flow is
    // never paused or flagged for it: a refused push leaves the row exactly
    // as it was, running, and an old mismatch it did not touch only warns.
    const { changed: layoutMismatches, untouched } =
      guard && row
        ? { changed: [], untouched: [] }
        : await splitLayoutMismatches(doc as never, previousLayouts);
    if (layoutMismatches.length > 0) {
      logger.warn("Flow file layout does not match its table; not applied", {
        workspaceId,
        path,
        reason: formatLayoutMismatches(layoutMismatches),
      });
      if (row) {
        await setLayoutWarnings(row._id, [
          ...toLayoutWarnings(layoutMismatches, true),
          ...toLayoutWarnings(untouched, false),
        ]);
      }
      result.invalid.push(slug);
      continue;
    }
    if (untouched.length > 0) {
      logger.warn("Flow layout does not match its table", {
        workspaceId,
        path,
        reason: formatLayoutMismatches(untouched),
      });
    }
    // Saved with the row, so a fixed layout clears the warnings.
    (doc as IFlow).layoutWarnings = toLayoutWarnings(untouched, false);
    // A file-born webhook flow needs an inbound URL, and this is the only
    // place one may be minted. `isNew` is the create/update distinction: an
    // update must leave the endpoint exactly where it is.
    const webhookOnBefore = !isNew && hasWebhookTrigger(doc as IFlow);
    const mintedEndpoint = mintedWebhookEndpoint({
      isNew,
      webhookEnabled: parsed.webhookEnabled,
      workspaceId,
      flowId: String((doc as IFlow)._id),
      existingEndpoint: (doc as IFlow).webhookConfig?.endpoint,
    });
    if (mintedEndpoint) {
      (doc as IFlow).webhookConfig = {
        ...((doc as IFlow).webhookConfig ?? {}),
        endpoint: mintedEndpoint,
      } as IFlow["webhookConfig"];
    }
    (doc as IFlow).sourceBlobSha = sha;
    // One file's failure is that file's problem. `save()` can still throw for
    // a file that parsed and applied — a value outside a schema enum, an id
    // that is not an ObjectId — and letting that escape would skip every file
    // after it AND the reconcile below, for the whole push. The row that
    // exists is kept (the failed save is not applied); a new one is simply
    // not created, and since it never reached `desired` there is nothing for
    // the reconciler to tear down either way.
    try {
      if (guard && row) {
        const outcome = await applyGuardedCandidate(
          doc,
          repoDirFor(workspaceId),
          head,
          sha,
          parsed,
          guard.connection ?? mongoose.connection,
          guard,
        );
        if (outcome !== "applied") {
          const desiredEntry = desired.find(entry => entry.slug === slug);
          if (desiredEntry && previousFile) desiredEntry.file = previousFile;
          continue;
        }
      } else {
        await doc.save();
      }
    } catch (error) {
      if (guard) {
        if (!(error instanceof GuardCandidateInvalid) || !row) throw error;
        await mark(row, error.message);
        result.invalid.push(slug);
        continue;
      }
      logger.warn("Flow file could not be saved; keeping current row", {
        workspaceId,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      result.invalid.push(slug);
      continue;
    }
    if (wasInvalid && !guard) await clearFlowInvalid((doc as IFlow)._id);
    if (isNew) {
      result.created++;
      // A row created in this pass has no id until now, so its desired entry
      // is added here rather than above.
      desired.push({ slug, file: parsed, flowId: String(doc._id) });
    } else {
      result.updated++;
      // Entities changed, or webhooks were just switched on: retarget or
      // provision the subscription (adopted by URL, never duplicated).
      if (
        isWebhookFlow(doc as IFlow) &&
        (flowEntitySignature(doc as IFlow) !== entitySignatureBefore ||
          !webhookOnBefore ||
          // Switched off by this push: pause the provider subscription.
          !hasWebhookTrigger(doc as IFlow))
      ) {
        webhookResyncs.push(doc as IFlow);
      }
    }
    logger.info("Flow synced from repo", { workspaceId, slug, isNew });
  }

  // A file that enables or disables entities changes which provider events
  // the flow needs: retarget its webhook subscription. Dispatched as an event
  // (inngest/functions/flow-webhook-subscription) so this module never loads
  // the connector registry, and so a provider error cannot stall the push.
  if (webhookResyncs.length > 0) {
    try {
      await inngest.send(
        webhookResyncs.map(flow => ({
          name: "flow.webhook.resubscribe",
          data: { flowId: String(flow._id) },
        })),
      );
    } catch (error) {
      logger.warn("Could not queue webhook retargeting for changed flows", {
        workspaceId,
        flowIds: webhookResyncs.map(flow => String(flow._id)),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Removal is the reconciler's, end to end. A flow is a running stream, so a
  // missing file means teardown plus checkpoint disposal — and unlike a dbt
  // row, that is not recoverable by recreating the flow: the stream position
  // is gone and the next sync re-backfills. `reconcileFlowsFromRepo` verifies
  // `treeSha` against the mirror's main and REFUSES rather than guessing, so a
  // stale or partial tree cannot reach the destructive path even though this
  // module already guards against an empty one.
  const reconciled = await reconcileFlowsFromRepo({
    workspaceId,
    desired,
    treeSha: head,
  });
  if (reconciled.deferred) {
    // Destructive work was refused, not skipped silently: report which flows
    // and why, so a deletion that has not happened yet is distinguishable
    // from one that quietly did nothing.
    result.deferred = reconciled.deferred.removals;
    logger.warn("Destructive flow reconcile refused; retrying on next push", {
      workspaceId,
      removals: reconciled.deferred.removals,
      reason: reconciled.deferred.reason,
    });
  }

  return result;
}
