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
import { createHash } from "node:crypto";
import { Types } from "mongoose";

import { loggers } from "../logging";
import {
  DEFAULT_BRANCH,
  listTree,
  readBlob,
  readBlobsBatch,
  repoDirFor,
  repoExists,
  resolveCommit,
  blobOid,
} from "../apps/repository.service";
import {
  ensureLocalRepo,
  freshenBeforeMainWrite,
} from "../apps/cloud-repo.service";
import { boundRepoDirIfExists } from "../apps/workspace-repo-required";
import { getWorkspaceRepo } from "./workspace-repos.service";
import { Flow, type IFlow } from "../database/workspace-schema";
import { generateWebhookEndpoint } from "../utils/webhook.utils";
import {
  flowToFile,
  parseFlowFile,
  slugFromFlowFilePath,
  type FlowFile,
} from "./flow-config-files";
import {
  reconcileFlowsFromRepo,
  type DesiredFlow,
} from "../sync-cdc/flow-reconcile";

const logger = loggers.api("flow-sync");

/**
 * The inbound URL a file-born webhook flow needs, or null when none should be
 * minted.
 *
 * `applyDefinition` writes only `webhookConfig.enabled`, because the endpoint
 * is inbound URL identity and the secret is a credential — neither belongs in
 * a file and an EDIT must move neither. That is right for an update and left a
 * CREATE broken: a file-born webhook flow saved with `enabled: true` and no
 * endpoint has nowhere for Stripe to POST. It looks configured and receives
 * nothing, and webhook is the majority case (17 of 31 production flows).
 *
 * So the endpoint is minted exactly once, when the row is first created, and
 * derived from `workspaceId` + the flow's `_id` — never from the slug, so
 * editing a file cannot move it.
 *
 * THE SECRET IS DELIBERATELY NOT MINTED. It is the provider's signing secret
 * (Stripe's `whsec_...`), handed to `connector.verifyWebhook` by
 * routes/webhooks.ts. A value invented here would fail signature verification
 * on every real delivery while the flow looked fully configured — strictly
 * worse than the empty string, which at least fails honestly. It arrives from
 * the user, or from the Stripe-managed path that stores `signingSecret`
 * returned by Stripe's own API.
 *
 * On renames: a renamed FILE is a different flow by construction — the slug is
 * identity and this module matches on it, so a new slug finds no row and mints
 * its own endpoint. Changing a flow's `name:` does not move the file, so that
 * row and its endpoint are untouched. Preserving an inbound URL across a file
 * rename would need identity inside the file, and is a separate change.
 */
export function mintedWebhookEndpoint(args: {
  isNew: boolean;
  type: string | undefined;
  workspaceId: string;
  flowId: string;
  existingEndpoint?: string;
}): string | null {
  if (!args.isNew) return null;
  if (args.type !== "webhook") return null;
  // Belt and braces: never overwrite one that somehow already exists.
  if (args.existingEndpoint) return null;
  return generateWebhookEndpoint(args.workspaceId, args.flowId);
}

async function markFlowInvalid(
  doc: IFlow,
  reason: string,
  path: string,
): Promise<void> {
  doc.definitionInvalid = { reason, at: new Date(), path };
  if (doc.schedule) doc.schedule.enabled = false;
  if (doc.backfillSchedule) doc.backfillSchedule.enabled = false;
  await doc.save();
}

/**
 * Stable id for a flow that exists as `flows/<slug>.yml` but has no index
 * row yet (same contract as `derivedConsoleId` / `derivedAppId`).
 */
export function derivedFlowId(
  workspaceId: string,
  slug: string,
): Types.ObjectId {
  const digest = createHash("sha1")
    .update(`flows:${workspaceId}:${slug}`)
    .digest("hex");
  return new Types.ObjectId(digest.slice(0, 24));
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
    if (row.definitionInvalid && def.parsed) return true;
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

function joinLiveFlows(
  workspaceId: string,
  defs: FlowDefinitionAtMain[],
  rows: IFlow[],
): LiveFlow[] {
  const bySlug = new Map<string, IFlow>();
  for (const row of rows) {
    if (row.slug) bySlug.set(row.slug, row);
  }
  return defs.map(def => {
    const row = bySlug.get(def.slug) ?? null;
    return {
      def,
      row,
      id: row?._id ?? derivedFlowId(workspaceId, def.slug),
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
    if (row.sourceBlobSha !== def.oid || row.definitionInvalid) {
      await ensureFlowDerivedCache(row);
    }
    return { def, row, id: row._id };
  }

  const live = await loadLiveFlows(workspaceId);
  return live.find(item => item.id.toString() === flowId) ?? null;
}

/**
 * Git definition overlaid on the Mongo runtime row (or a stub when the
 * file has no row). Never copies a Mongo-only definition into the
 * response: the body comes from the file when it parses.
 */
export function liveFlowToPlain(
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
      };
  base._id = live.id;
  base.slug = live.def.slug;
  base.workspaceId = live.row?.workspaceId ?? new Types.ObjectId(workspaceId);
  if (live.def.parsed) {
    applyDefinition(base as unknown as IFlow, live.def.parsed);
    base.sourceBlobSha = live.def.oid;
    delete base.definitionInvalid;
  } else {
    base.definitionInvalid = live.row?.definitionInvalid ?? {
      reason: "unparseable flow file",
      at: new Date(),
      path: live.def.path,
    };
    base.sourceBlobSha = live.def.oid;
  }
  return base;
}

/**
 * SHA-check the derived cache against `flows/<slug>.yml` at main.
 * Resyncs the row when the blob moved; never writes Mongo over an invalid file.
 * Leftover local git without a GitHub binding is ignored — runtime keeps
 * the SHA-checked Mongo cache (issue #956).
 */
export async function ensureFlowDerivedCache(flow: {
  _id: { toString(): string };
  workspaceId: { toString(): string };
  slug?: string;
  sourceBlobSha?: string;
  definitionInvalid?: { reason: string } | null;
}): Promise<"ok" | "invalid" | "missing" | "resynced"> {
  if (!flow.slug) return "ok";
  const workspaceId = flow.workspaceId.toString();
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) {
    return flow.definitionInvalid ? "invalid" : "ok";
  }
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!head) return flow.definitionInvalid ? "invalid" : "ok";
  const path = `flows/${flow.slug}.yml`;
  let contents: string;
  try {
    const blob = await readBlob(repoDir, head, path);
    if (blob.isBinary) {
      const row = await Flow.findById(flow._id);
      if (row) await markFlowInvalid(row, "binary flow file", path);
      return "invalid";
    }
    contents = blob.contents;
  } catch {
    const row = await Flow.findById(flow._id);
    if (row) await markFlowInvalid(row, "flow file missing at main", path);
    return "missing";
  }
  const sha = blobOid(contents);
  if (flow.sourceBlobSha === sha && !flow.definitionInvalid) return "ok";
  const parsed = parseFlowFile(contents);
  const row = await Flow.findById(flow._id);
  if (!row) return "missing";
  if (!parsed) {
    await markFlowInvalid(row, "unparseable flow file", path);
    return "invalid";
  }
  let refusal: string | null;
  try {
    refusal = applyDefinition(row, parsed);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  if (refusal) {
    await markFlowInvalid(row, refusal, path);
    return "invalid";
  }
  row.definitionInvalid = undefined;
  row.sourceBlobSha = sha;
  await row.save();
  return "resynced";
}

export interface FlowSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  invalid: string[];
  /** Slugs whose destructive reconcile was refused; see ReconcileResult. */
  deferred: string[];
}

/**
 * Apply the definition half of a parsed file onto a row. Runtime untouched.
 *
 * Returns a reason when the file cannot be applied, so the caller keeps the
 * current row rather than half-writing one.
 */
function applyDefinition(doc: IFlow, file: FlowFile): string | null {
  doc.name = file.name;
  doc.type = file.type;

  if (file.source.type === "database") {
    doc.sourceType = "database";
    doc.databaseSource = {
      ...(doc.databaseSource ?? {}),
      connectionId: file.source.connectionId
        ? new Types.ObjectId(file.source.connectionId)
        : undefined,
      database: file.source.database,
      query: file.source.query,
    } as IFlow["databaseSource"];
  } else {
    // `dataSourceId` is required on the schema, so a connector file without
    // one cannot produce a valid row. Refuse the file rather than write half
    // a flow — the row that exists is more trustworthy than a bad edit.
    if (!file.source.connectionId) {
      return "connector source has no connection_id";
    }
    doc.sourceType = "connector";
    doc.dataSourceId = new Types.ObjectId(file.source.connectionId);
  }

  // Required on the schema, same as `dataSourceId` above: refuse rather than
  // write a row with no destination.
  if (!file.destination.connectionId) {
    return "destination has no connection_id";
  }
  doc.destinationDatabaseId = new Types.ObjectId(file.destination.connectionId);
  doc.destinationDatabaseName = file.destination.databaseName;
  if (file.destination.table) {
    const t = file.destination.table;
    doc.tableDestination = {
      ...(doc.tableDestination ?? {}),
      connectionId: t.connectionId
        ? new Types.ObjectId(t.connectionId)
        : undefined,
      database: t.database,
      schema: t.schema,
      tableName: t.tableName,
      createIfNotExists: t.createIfNotExists,
      partitioning: t.partitioning,
      clustering: t.clustering,
    } as IFlow["tableDestination"];
  }

  // Schedules: cron + timezone only. `backfillSchedule.lastRunAt` is a
  // scheduler claim (`isCronDue` reads it) and must survive a file edit.
  doc.schedule = {
    ...(doc.schedule ?? {}),
    enabled: Boolean(file.schedule),
    cron: file.schedule?.cron,
    timezone: file.schedule?.timezone,
  } as IFlow["schedule"];
  doc.backfillSchedule = {
    ...(doc.backfillSchedule ?? {}),
    enabled: Boolean(file.backfillSchedule),
    cron: file.backfillSchedule?.cron,
    timezone: file.backfillSchedule?.timezone,
  } as IFlow["backfillSchedule"];

  // Enabled-ness only. The endpoint is inbound URL identity minted once in
  // Mongo (17 of 31 production flows have external systems POSTing to it) and
  // the secret is a credential; neither is in the file and neither may be
  // touched from here.
  if (file.type === "webhook") {
    doc.webhookConfig = {
      ...(doc.webhookConfig ?? {}),
      enabled: file.webhookEnabled !== false,
    } as IFlow["webhookConfig"];
  }

  doc.syncMode = file.sync.mode as IFlow["syncMode"];
  doc.writeMode = file.sync.writeMode as IFlow["writeMode"];
  doc.syncEngine = file.sync.engine as IFlow["syncEngine"];
  doc.deleteMode = file.sync.deleteMode as IFlow["deleteMode"];
  if (file.sync.batchSize !== undefined) doc.batchSize = file.sync.batchSize;

  doc.entityFilter = file.entityFilter as IFlow["entityFilter"];
  doc.entityLayouts = file.entityLayouts as unknown as IFlow["entityLayouts"];
  doc.typeCoercions = file.typeCoercions as unknown as IFlow["typeCoercions"];
  doc.queries = file.queries as unknown as IFlow["queries"];

  // Definition halves only — merge onto the existing object so the cursors
  // (`lastValue`, `lastKeysetValue`) are preserved rather than dropped.
  if (file.incremental) {
    doc.incrementalConfig = {
      ...(doc.incrementalConfig ?? {}),
      trackingColumn: file.incremental.trackingColumn,
      trackingType: file.incremental.trackingType,
    } as IFlow["incrementalConfig"];
  }
  if (file.pagination) {
    doc.paginationConfig = {
      ...(doc.paginationConfig ?? {}),
      mode: file.pagination.mode,
      keysetColumn: file.pagination.keysetColumn,
      keysetDirection: file.pagination.keysetDirection,
    } as IFlow["paginationConfig"];
  }
  if (file.conflict) {
    doc.conflictConfig = {
      ...(doc.conflictConfig ?? {}),
      keyColumns: file.conflict.keyColumns,
      strategy: file.conflict.strategy,
    } as IFlow["conflictConfig"];
  }
  return null;
}

/** What a file would produce if it were written onto a fresh row. */
export interface HydratedFlowRow {
  /** Set when `applyDefinition` refuses the file outright. */
  refusal: string | null;
  /** Field-level schema failures, as mongoose would raise them on save. */
  schemaErrors: Array<{ path: string; message: string }>;
}

/**
 * Build the row a file would produce and ask the model whether it is valid —
 * WITHOUT saving it.
 *
 * The third validation layer, and the one nothing else covers. Parsing and
 * referential resolution (`flow-validate.service.ts`) both pass for a file
 * whose `entities.layouts` entry has no `partition_field`, or whose
 * `sync.write_mode` is outside the schema's enum; `doc.save()` in the push
 * reactor then throws and the row is never written. A checker that certifies
 * a file the reactor refuses is the silent-no-op failure the RFC exists to
 * end, one layer further in.
 *
 * Uses the reactor's own `applyDefinition` rather than a second mapping, so
 * the check cannot disagree with what it is predicting.
 *
 * `createdBy` is required on the schema and is not in the file (it is the
 * acting user, supplied by the reactor); callers checking a file rather than
 * creating one pass a placeholder so the check reports the file's problems
 * and not that one.
 */
export function hydrateFlowRow(
  file: FlowFile,
  args: { workspaceId: string; slug: string; createdBy: string },
): HydratedFlowRow {
  const doc = new Flow({
    workspaceId: new Types.ObjectId(args.workspaceId),
    slug: args.slug,
    createdBy: args.createdBy,
  }) as unknown as IFlow;

  const refusal = applyDefinition(doc, file);
  if (refusal) return { refusal, schemaErrors: [] };

  // validateSync() runs the schema's own validators in-process and touches no
  // connection — the document is never saved and this function never writes.
  const error = (
    doc as unknown as {
      validateSync: () =>
        | { errors?: Record<string, { message?: string }> }
        | undefined;
    }
  ).validateSync();
  const errors = error?.errors ?? {};
  return {
    refusal: null,
    schemaErrors: Object.entries(errors).map(([path, err]) => ({
      path,
      message: err?.message ?? "is invalid",
    })),
  };
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

  // No flows/ in the repo at all → this workspace has not adopted flows as
  // code. Leave Mongo alone. Without this an empty or partial tree would read
  // as "every flow was deleted" and tear down every running stream.
  if (files.length === 0) return empty;

  const result: FlowSyncResult = { ...empty, invalid: [] };
  const desired: DesiredFlow[] = [];
  const seen = new Set<string>();

  for (const { path, contents } of files) {
    const slug = slugFromFlowFilePath(path);
    if (!slug) continue;
    seen.add(slug);

    const sha = blobOid(contents);
    const parsedForDesired = parseFlowFile(contents);
    const row = await Flow.findOne({ workspaceId, slug });
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

    if (row && row.sourceBlobSha === sha) {
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
        await markFlowInvalid(row, "unparseable flow file", path);
      }
      result.invalid.push(slug);
      continue;
    }

    const isNew = !row;
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
        await markFlowInvalid(row, refusal, path);
      }
      result.invalid.push(slug);
      continue;
    }
    // A file-born webhook flow needs an inbound URL, and this is the only
    // place one may be minted. `isNew` is the create/update distinction: an
    // update must leave the endpoint exactly where it is.
    const mintedEndpoint = mintedWebhookEndpoint({
      isNew,
      type: (doc as IFlow).type,
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
    (doc as IFlow).definitionInvalid = undefined;
    // One file's failure is that file's problem. `save()` can still throw for
    // a file that parsed and applied — a value outside a schema enum, an id
    // that is not an ObjectId — and letting that escape would skip every file
    // after it AND the reconcile below, for the whole push. The row that
    // exists is kept (the failed save is not applied); a new one is simply
    // not created, and since it never reached `desired` there is nothing for
    // the reconciler to tear down either way.
    try {
      await doc.save();
    } catch (error) {
      logger.warn("Flow file could not be saved; keeping current row", {
        workspaceId,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      result.invalid.push(slug);
      continue;
    }
    if (isNew) {
      result.created++;
      // A row created in this pass has no id until now, so its desired entry
      // is added here rather than above.
      desired.push({ slug, file: parsed, flowId: String(doc._id) });
    } else {
      result.updated++;
    }
    logger.info("Flow synced from repo", { workspaceId, slug, isNew });
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
