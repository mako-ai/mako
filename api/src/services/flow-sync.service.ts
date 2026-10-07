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
  ensureCommitLocally,
  ensureLocalRepo,
  freshenBeforeMainWrite,
  freshenForServe,
} from "../apps/cloud-repo.service";
import { boundRepoDirIfExists } from "../apps/workspace-repo-required";
import { getWorkspaceRepo } from "./workspace-repos.service";
import { Flow, type IFlow } from "../database/workspace-schema";
import { generateWebhookEndpoint } from "../utils/webhook.utils";
import {
  flowFilePath,
  flowRenameTarget,
  flowToFile,
  parseFlowFile,
  serializeFlowFile,
  slugFromFlowFilePath,
  type FlowFile,
} from "./flow-config-files";
import {
  reconcileFlowsFromRepo,
  type DesiredFlow,
} from "../sync-cdc/flow-reconcile";
import {
  currentTreeCheck,
  detectGitRenames,
  isAncestorCommit,
  mergedAliases,
  pairRenamedSlugs,
  pairingBaseBlob,
  type RemovedSlug,
  type SlugRenamePair,
} from "../rename/flow-dbt-job-pairing";

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
 * On renames: this module matches rows to files by slug, so a new slug finds
 * no row and would mint its own endpoint — EXCEPT that `syncFlowsFromRepo`
 * first pairs a vanished slug with an appeared one (`rekeyRenamedFlows`: the
 * file's `aliases:`, git rename detection, or identical content) and re-keys
 * the row in place. A paired file is then an update of the existing row, so
 * `isNew` is false and the endpoint stays exactly where it was. Changing a
 * flow's `name:` does not move the file, so that row and its endpoint are
 * untouched either way.
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

/**
 * Mongoose materialises an unset nested path as `{}` on a hydrated doc, so
 * the marker's presence is its `reason`, never the object's truthiness —
 * `if (row.definitionInvalid)` read every healthy flow as invalid, which is
 * how a bound workspace's runs came to re-parse their file on every fire and
 * an unbound one's runs were refused outright.
 */
export function isFlowMarkedInvalid(row: {
  definitionInvalid?: { reason?: string } | null;
}): boolean {
  return typeof row.definitionInvalid?.reason === "string";
}

/** The row's marker when it is a real one (see isFlowMarkedInvalid). */
function rowInvalidMarker(
  row: IFlow | null,
): IFlow["definitionInvalid"] | undefined {
  return row && isFlowMarkedInvalid(row) ? row.definitionInvalid : undefined;
}

/** Assigning `undefined` to a nested path persists `{}`; unset it instead. */
async function clearFlowInvalid(id: Types.ObjectId): Promise<void> {
  await Flow.updateOne({ _id: id }, { $unset: { definitionInvalid: 1 } });
}

/**
 * Stamp the marker (and pause the schedules) with a targeted update, never
 * a `save()`: a legacy row that no longer passes the schema would throw out
 * of the push-sync loop and skip every file after it. Idempotent, so a list
 * call does not rewrite the marker on every read.
 */
async function markFlowInvalid(
  doc: IFlow,
  reason: string,
  path: string,
  /**
   * The blob at main that was found invalid, when there is one (a missing
   * file has none). Recorded as `lastSeenBlobSha` so the write-through may
   * overwrite exactly this version from the UI — the recovery path for a
   * broken laptop push — and nothing newer. Two broken versions with the
   * same reason are two different blobs: the marker is "unchanged" only
   * when the blob is too.
   */
  blobSha?: string,
): Promise<void> {
  if (
    doc.definitionInvalid?.reason === reason &&
    doc.definitionInvalid?.path === path &&
    (blobSha === undefined || doc.lastSeenBlobSha === blobSha)
  ) {
    return;
  }
  const definitionInvalid = { reason, at: new Date(), path };
  const set: Record<string, unknown> = { definitionInvalid };
  if (blobSha !== undefined) set.lastSeenBlobSha = blobSha;
  if (doc.schedule) set["schedule.enabled"] = false;
  if (doc.backfillSchedule) set["backfillSchedule.enabled"] = false;
  try {
    await Flow.updateOne({ _id: doc._id }, { $set: set });
    doc.definitionInvalid = definitionInvalid;
    if (blobSha !== undefined) doc.lastSeenBlobSha = blobSha;
    if (doc.schedule) doc.schedule.enabled = false;
    if (doc.backfillSchedule) doc.backfillSchedule.enabled = false;
  } catch (error) {
    logger.warn("Failed to mark flow invalid", {
      flowId: doc._id.toString(),
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Stable id for a flow that exists as `flows/<slug>.yml` but has no index
 * row yet (same contract as `derivedConsoleId` / `derivedAppId`).
 */
export function derivedFlowId(
  workspaceId: string,
  slug: string,
  /**
   * 1 is the id every git-only file has always had. A higher generation is
   * used only when that id is already held by a row of ANOTHER slug — a
   * git-born flow that was renamed keeps its id, so a new file later pushed
   * at its old name must not collide with it (see `freeDerivedFlowId`).
   */
  generation = 1,
): Types.ObjectId {
  const digest = createHash("sha1")
    .update(
      `flows:${workspaceId}:${slug}${generation > 1 ? `#${generation}` : ""}`,
    )
    .digest("hex");
  return new Types.ObjectId(digest.slice(0, 24));
}

/**
 * The stable id for a file with no row: the first derivation not held by a
 * row of a different slug. Deterministic over the same rows, so GET/list
 * (which hands it out) and push-sync (which creates the row under it)
 * agree, and a tab opened before the push keeps resolving after it.
 */
export function freeDerivedFlowId(
  workspaceId: string,
  slug: string,
  rows: Array<{ _id: Types.ObjectId; slug?: string }>,
): Types.ObjectId {
  for (let generation = 1; generation <= 32; generation++) {
    const id = derivedFlowId(workspaceId, slug, generation);
    const holder = rows.find(row => row._id.equals(id));
    if (!holder || holder.slug === slug) return id;
  }
  return new Types.ObjectId();
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
  for (const { path, contents, oid } of files) {
    const slug = slugFromFlowFilePath(path);
    if (!slug) continue;
    defs.push({
      path,
      slug,
      oid,
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
    // Level means BOTH shas agree with the blob: `lastSeenBlobSha` is what
    // the write-through's compare-and-swap checks, and a failed push-sync
    // save can leave it pointing at a blob the file has since moved away
    // from (reverted) while `sourceBlobSha` still matches.
    if (row.lastSeenBlobSha !== def.oid) return true;
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
  let defs = await listFlowDefinitionsAtMain(workspaceId);
  let rows = await Flow.find({ workspaceId });
  // Rows whose file is not at main on THIS instance: a cache that predates
  // a rename made elsewhere (fetch once, throttled), or a rename whose
  // commit never landed (settle it, as the push-sync would).
  const orphaned = (defs: FlowDefinitionAtMain[], rows: IFlow[]) => {
    const slugs = new Set(defs.map(def => def.slug));
    return rows.filter(row => row.slug && !slugs.has(row.slug));
  };
  let changed = false;
  const orphans = orphaned(defs, rows);
  if (
    orphans.length > 0 &&
    (await freshenForOrphans(workspaceId, repoDir, orphans))
  ) {
    defs = await listFlowDefinitionsAtMain(workspaceId);
    changed = true;
  }
  if (orphaned(defs, rows).length > 0) {
    if (await settleLostRenamesForRead({ workspaceId, repoDir, defs })) {
      rows = await Flow.find({ workspaceId });
      changed = true;
    }
  }
  if (!flowIndexDrift(defs, rows)) return changed ? "resynced" : "ok";
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
  /** Rows whose new name another file holds (`foreignHeldFlowIds`). */
  foreignHeld: ReadonlySet<string> = new Set(),
): LiveFlow[] {
  const bySlug = new Map<string, IFlow>();
  for (const row of rows) {
    if (row.slug && !foreignHeld.has(String(row._id))) {
      bySlug.set(row.slug, row);
    }
  }
  // A row whose own file is not here (this instance's cache predates its
  // rename, or another file took its new name first) and whose old name IS:
  // that file is the row, not a git-only stranger — listed and opened as
  // the row, under the name this tree has.
  const defSlugs = new Set(defs.map(def => def.slug));
  const byAliasOfOrphan = new Map<string, IFlow>();
  for (const row of rows) {
    if (!row.slug) continue;
    if (defSlugs.has(row.slug) && !foreignHeld.has(String(row._id))) continue;
    for (const alias of row.aliases ?? []) {
      if (!bySlug.has(alias)) byAliasOfOrphan.set(alias, row);
    }
  }
  return defs.map(def => {
    const row = bySlug.get(def.slug) ?? byAliasOfOrphan.get(def.slug) ?? null;
    return {
      def,
      row,
      id: row?._id ?? freeDerivedFlowId(workspaceId, def.slug, rows),
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
  return joinLiveFlows(
    workspaceId,
    defs,
    rows,
    await foreignHeldFlowIds(workspaceId, defs, rows),
  );
}

/**
 * Rows (by id) whose new name another file holds while their rename has not
 * landed here — what is left of that race on a tree the read path could not
 * verify (on a verified one it has been settled away by now). Their slug's
 * file is listed as what it is, a file of its own; the row is listed under
 * its old-name file, as on any instance whose view predates its rename.
 */
async function foreignHeldFlowIds(
  workspaceId: string,
  defs: FlowDefinitionAtMain[],
  rows: IFlow[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const guarded = rows.filter(row => row.lastRenameCommit && row.slug);
  if (guarded.length === 0) return out;
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return out;
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!head) return out;
  const bySlug = new Map(defs.map(def => [def.slug, def] as const));
  for (const row of guarded) {
    const def = bySlug.get(row.slug as string);
    if (
      def &&
      (await foreignFileAtRenamedSlug(repoDir, head, row, def.parsed))
    ) {
      out.add(String(row._id));
    }
  }
  return out;
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
    let defs = await listFlowDefinitionsAtMain(workspaceId);
    let current: IFlow = row;
    let def = defs.find(item => item.slug === current.slug);
    if (!def && (await freshenForOrphans(workspaceId, repoDir, [current]))) {
      // This instance's cache may predate a rename made elsewhere.
      defs = await listFlowDefinitionsAtMain(workspaceId);
      def = defs.find(item => item.slug === current.slug);
    }
    if (!def && current.lastRenameCommit) {
      // A rename whose commit never landed: the file is under an old name.
      if (
        await settleLostRenamesForRead({
          workspaceId,
          repoDir,
          defs,
          rows: [current],
        })
      ) {
        const fresh = await Flow.findById(current._id);
        if (fresh) current = fresh;
        def = defs.find(item => item.slug === current.slug);
      }
    }
    if (def && current.lastRenameCommit) {
      // Another file holding the row's new name is not its file (see
      // foreignFileAtRenamedSlug): settled away from it on a verified tree,
      // else the row is served as if its file were missing here.
      const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
      if (
        head &&
        (await foreignFileAtRenamedSlug(repoDir, head, current, def.parsed))
      ) {
        const settled = await settleLostRenamesForRead({
          workspaceId,
          repoDir,
          defs,
          rows: [current],
        });
        const fresh = settled ? await Flow.findById(current._id) : null;
        if (fresh) current = fresh;
        def = settled
          ? defs.find(item => item.slug === current.slug)
          : undefined;
      }
    }
    if (!def) {
      // This instance's cache predates the row's rename and has its file
      // under an OLD name: that file is the row (as the list shows it).
      // Served as is — no resync against a file the row has moved on from.
      const aliasDef = (current.aliases ?? [])
        .map(alias => defs.find(item => item.slug === alias))
        .find(item => item !== undefined);
      if (aliasDef) return { def: aliasDef, row: current, id: current._id };
      return null;
    }
    if (
      current.sourceBlobSha !== def.oid ||
      current.lastSeenBlobSha !== def.oid ||
      isFlowMarkedInvalid(current)
    ) {
      await ensureFlowDerivedCache(current);
    }
    return { def, row: current, id: current._id };
  }

  const live = await loadLiveFlows(workspaceId);
  return (
    live.find(item => item.id.toString() === flowId) ??
    // A tab opened on a git-only file before its push was synced holds
    // `derivedFlowId(slug)`. When that push turned out to be a rename, the
    // slug now belongs to a row that kept its OLD id, so the derived id
    // matches no row — but it still names exactly that file.
    live.find(
      item =>
        item.row !== null &&
        derivedFlowId(workspaceId, item.def.slug).toString() === flowId,
    ) ??
    null
  );
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
        aliases: live.def.parsed?.aliases,
        // A file with no row yet: not runnable, not renameable until synced.
        gitOnly: true,
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
  if (applyFailure) {
    base.definitionInvalid = rowInvalidMarker(live.row) ?? {
      reason: applyFailure,
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
export async function ensureFlowDerivedCache(flow: {
  _id: { toString(): string };
  workspaceId: { toString(): string };
  slug?: string;
  sourceBlobSha?: string;
  lastSeenBlobSha?: string;
  definitionInvalid?: { reason: string } | null;
}): Promise<"ok" | "invalid" | "missing" | "resynced"> {
  if (!flow.slug) return "ok";
  const workspaceId = flow.workspaceId.toString();
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) {
    return isFlowMarkedInvalid(flow) ? "invalid" : "ok";
  }
  const path = `flows/${flow.slug}.yml`;
  // The commit the file was last read at (set inside readAtMain).
  const read: { head: string | null } = { head: null };
  const readAtMain = async () => {
    const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
    read.head = head ?? null;
    if (!head) return null;
    try {
      return await readBlob(repoDir, head, path);
    } catch {
      return null;
    }
  };
  let blob = await readAtMain();
  if (blob === null) {
    // "Missing" on THIS instance's cache is not "deleted": a run or a CDC
    // consumer lands here on whichever instance picks it up, and that
    // instance's local main may predate a rename made elsewhere (the file
    // now lives under the new slug). Fetch once (throttled) and look again
    // before concluding anything.
    const guarded = await Flow.findById(flow._id)
      .select("lastRenameCommit")
      .lean();
    if (
      await freshenForOrphans(workspaceId, repoDir, guarded ? [guarded] : [])
    ) {
      blob = await readAtMain();
    }
  }
  if (blob === null) {
    // Or a rename whose commit never reached main, with no push since to
    // run the sync's settle step: the file is under an old name. Settle it
    // here exactly as the sync would (verified tree, expired guard, same
    // target) and judge the re-keyed row.
    const fresh = await Flow.findById(flow._id);
    if (fresh?.lastRenameCommit) {
      const defs = await listFlowDefinitionsAtMain(workspaceId);
      const rekeyed = await settleLostRenamesForRead({
        workspaceId,
        repoDir,
        defs,
        rows: [fresh],
      });
      if (rekeyed) {
        const settled = await Flow.findById(flow._id);
        if (settled && settled.slug !== flow.slug) {
          return ensureFlowDerivedCache(settled);
        }
      }
    }
  }
  if (blob === null) {
    // Still not here: refuse THIS run (the callers skip on "missing") and
    // change nothing on the row. Marking it invalid used to switch its
    // schedules off, which nothing switched back on when the cache caught
    // up — a scheduled-only flow nobody opened stayed off. A flow whose file
    // is really gone from main is torn down by the push sync; a stale cache
    // is not a reason to disable anything.
    return "missing";
  }
  if (blob.isBinary) {
    const row = await Flow.findById(flow._id);
    if (row) await markFlowInvalid(row, "binary flow file", path, blob.oid);
    return "invalid";
  }
  const contents = blob.contents;
  // Git's id from the raw bytes, never a hash of the decoded text.
  const sha = blob.oid;
  const wasMarked = isFlowMarkedInvalid(flow);
  // Level only when BOTH shas agree (see flowIndexDrift).
  if (
    flow.sourceBlobSha === sha &&
    flow.lastSeenBlobSha === sha &&
    !wasMarked
  ) {
    return "ok";
  }
  const parsed = parseFlowFile(contents);
  const row = await Flow.findById(flow._id);
  if (!row) return "missing";
  // Re-keyed since the caller read it (a settle step moved it, possibly in
  // this very pass): `path` is no longer its file. Judged where it is now.
  if (row.slug !== flow.slug) return ensureFlowDerivedCache(row);
  if (!parsed) {
    await markFlowInvalid(row, "unparseable flow file", path, sha);
    return "invalid";
  }
  if (
    read.head &&
    (await foreignFileAtRenamedSlug(repoDir, read.head, row, parsed))
  ) {
    // Another file took this row's new name before its rename landed: not
    // this row's definition (see foreignFileAtRenamedSlug). Settled as the
    // sync would — on a verified tree the row goes back to an old name —
    // and the settled row judged; otherwise this run is refused and nothing
    // changes, as for a missing file.
    const defs = await listFlowDefinitionsAtMain(workspaceId);
    if (
      await settleLostRenamesForRead({
        workspaceId,
        repoDir,
        defs,
        rows: [row],
      })
    ) {
      const settled = await Flow.findById(flow._id);
      if (settled && settled.slug !== flow.slug) {
        return ensureFlowDerivedCache(settled);
      }
    }
    return "missing";
  }
  let refusal: string | null;
  try {
    refusal = applyDefinition(row, parsed);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  if (refusal) {
    await markFlowInvalid(row, refusal, path, sha);
    return "invalid";
  }
  await dropAliasesClaimedElsewhere(workspaceId, row);
  row.sourceBlobSha = sha;
  row.lastSeenBlobSha = sha;
  try {
    await row.save();
  } catch (error) {
    // applyDefinition already mutated `row`. Saving that document again
    // (via markFlowInvalid) would re-raise the same ValidationError and
    // 500 GET/list. Reload the persisted row, then stamp invalid.
    const reason = error instanceof Error ? error.message : String(error);
    const fresh = await Flow.findById(flow._id);
    if (fresh) await markFlowInvalid(fresh, reason, path, sha);
    return "invalid";
  }
  if (wasMarked) await clearFlowInvalid(row._id);
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

/**
 * Apply the definition half of a parsed file onto a row. Runtime untouched.
 *
 * Returns a reason when the file cannot be applied, so the caller keeps the
 * current row rather than half-writing one.
 */
function applyDefinition(doc: IFlow, file: FlowFile): string | null {
  doc.name = file.name;
  doc.type = file.type;
  // Aliases only ever grow (see `mergedAliases`); the row's own slug is
  // never one of them.
  const aliases = mergedAliases(doc.aliases, file.aliases, doc.slug);
  if (aliases.length > 0 || doc.aliases?.length) {
    doc.aliases = aliases.length > 0 ? aliases : undefined;
  }

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
    entities: file.backfillSchedule?.entities,
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

/**
 * Move a row to a new slug IN PLACE: same `_id`, so everything keyed by the
 * id (CDC checkpoints, executions, webhook events, the inbound webhook URL,
 * notification rules, open tabs) is untouched, and the old slug becomes an
 * alias so old names keep resolving. Two targeted updates, no `save()`: a
 * legacy row that no longer passes the schema must still be re-keyable.
 *
 * `$pull` first: renaming BACK to a slug the row already lists as an alias
 * must not leave the current slug among its own aliases.
 */
export async function rekeyFlowSlug(
  flowId: Types.ObjectId,
  from: string,
  to: string,
  /** The commit that carries the move; see `IFlow.lastRenameCommit`. */
  commit?: string,
  options: {
    /**
     * Default true: `from` becomes an alias so old links keep resolving.
     * False when `from` is a name that never existed on main (a rename
     * whose commit was lost, now being undone): nothing ever linked to it.
     */
    recordOldAsAlias?: boolean;
  } = {},
): Promise<void> {
  const recordOldAsAlias = options.recordOldAsAlias ?? true;
  await Flow.updateOne({ _id: flowId }, { $pull: { aliases: to } });
  const moved = await Flow.findOneAndUpdate(
    { _id: flowId, slug: from },
    {
      $set: {
        slug: to,
        ...(commit
          ? { lastRenameCommit: commit, lastRenameAt: new Date() }
          : {}),
      },
      ...(recordOldAsAlias ? { $addToSet: { aliases: from } } : {}),
      // A new guard is a move the tree already holds: the blob an earlier,
      // unlanded rename started from no longer describes anything.
      ...(commit ? { $unset: { renameFromBlobSha: 1 } } : {}),
    },
  )
    .select("workspaceId")
    .lean();
  if (!moved) return;
  // Current always wins (as for a new flow at the name, see the sync): a
  // row that held `to` as an OLD name stops answering to it. Otherwise it
  // kept it on the row, and once this flow moved on, `to` resolved to that
  // older flow behind the newer one's back — or to neither.
  await Flow.updateMany(
    { workspaceId: moved.workspaceId, _id: { $ne: flowId }, aliases: to },
    { $pull: { aliases: to } },
  );
}

/**
 * How long a rename commit is trusted to be "on its way to main". Within it,
 * a tree that does not contain the commit is read as older than the rename
 * (a push reaction that read the files before the commit landed and the rows
 * after): it must neither recreate the old slug nor rename back. After it, a
 * commit still absent from main never landed — the tree is the truth again.
 */
export const RENAME_GUARD_MS = 10 * 60 * 1000;

/**
 * A row whose file is not at THIS instance's main is as likely a stale
 * cache (a rename made elsewhere moved the file) as a deleted flow. Before
 * believing it, fetch — at most once per workspace per 30 s, on its own
 * clock, so a push-sync's freshen a moment earlier does not suppress it
 * and a storm of refused runs does not hammer the mirror.
 */
export const FRESHEN_ON_MISS_MS = 30 * 1000;
const lastMissFreshenAt = new Map<string, number>();
async function freshenOnMiss(workspaceId: string): Promise<boolean> {
  const last = lastMissFreshenAt.get(workspaceId) ?? 0;
  if (Date.now() - last < FRESHEN_ON_MISS_MS) return false;
  lastMissFreshenAt.set(workspaceId, Date.now());
  try {
    await freshenForServe(workspaceId, 0);
    return true;
  } catch (error) {
    logger.warn("Could not freshen after a missing flow file", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
/** Test seam: forget the on-miss throttle for a workspace. */
export function resetFreshenOnMissThrottle(workspaceId?: string): void {
  if (workspaceId) lastMissFreshenAt.delete(workspaceId);
  else lastMissFreshenAt.clear();
  lastCommitFetchAt.clear();
}

/**
 * A miss for a row that was RENAMED is more specific than a miss: the row
 * names the commit it needs (`lastRenameCommit`). When that commit is not
 * in this instance's repo, fetch for it now — coalesced per (workspace,
 * sha) by `ensureCommitLocally`, with a short backoff of its own so a miss
 * before the mirror has the commit does not burn the 30 s throttle for
 * the miss that comes after the push lands. Returns true when the commit
 * is local afterwards.
 */
const COMMIT_FETCH_BACKOFF_MS = 5 * 1000;
const lastCommitFetchAt = new Map<string, number>();
async function fetchRenameCommit(
  workspaceId: string,
  repoDir: string,
  sha: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/.test(sha)) return false;
  const present = () =>
    runGitQuiet(["-C", repoDir, "cat-file", "-e", `${sha}^{commit}`]);
  // Present but not on main (this instance made the rename, or fetched it
  // once and main was then reset) is not this helper's case: nothing to
  // fetch FOR; the caller's throttled freshen decides.
  if (await present()) return false;
  const key = `${workspaceId}#${sha}`;
  const last = lastCommitFetchAt.get(key) ?? 0;
  if (Date.now() - last < COMMIT_FETCH_BACKOFF_MS) return false;
  lastCommitFetchAt.set(key, Date.now());
  await ensureCommitLocally(workspaceId, sha);
  return present();
}

async function runGitQuiet(args: string[]): Promise<boolean> {
  const { runGit } = await import("../apps/git");
  try {
    await runGit(args);
    return true;
  } catch {
    return false;
  }
}

/**
 * The read paths' answer to a row whose file is not at main here: the
 * rename commit it names if it has one (not throttled), else a plain
 * freshen (throttled). True when anything was fetched.
 */
async function freshenForOrphans(
  workspaceId: string,
  repoDir: string,
  orphans: Array<Pick<IFlow, "lastRenameCommit">>,
): Promise<boolean> {
  let fetched = false;
  for (const row of orphans) {
    if (row.lastRenameCommit) {
      if (await fetchRenameCommit(workspaceId, repoDir, row.lastRenameCommit)) {
        fetched = true;
      }
    }
  }
  if (!fetched) fetched = await freshenOnMiss(workspaceId);
  return fetched;
}

/**
 * Whether the row's last rename is recorded, recent, and NOT in `head`'s
 * history — the one situation in which the tree must not be believed about
 * this row. No recorded commit means no guard: a row that merely carries
 * aliases is judged on the tree like any other.
 */
async function renameGuardActive(
  repoDir: string,
  head: string,
  row: Pick<IFlow, "lastRenameCommit" | "lastRenameAt">,
): Promise<boolean> {
  if (!row.lastRenameCommit || !row.lastRenameAt) return false;
  if (Date.now() - row.lastRenameAt.getTime() > RENAME_GUARD_MS) return false;
  return !(await isAncestorCommit(repoDir, row.lastRenameCommit, head));
}

/**
 * Whether the file under a renamed row's NEW name is that row's: the same
 * stream (source and destination), or a file that says it used to be one of
 * the row's old names. Anything else there is another file that took the
 * name first — a laptop push that won the mirror — and is not this row's
 * definition, whatever its slug.
 */
function renamedRowOwnsFile(row: IFlow, file: FlowFile): boolean {
  if (sameFlowTarget(row, file)) return true;
  const aliases = row.aliases ?? [];
  return (file.aliases ?? []).some(alias => aliases.includes(alias));
}

/**
 * The row's recorded rename is not in `head`'s history (whatever its age)
 * and the parsed file under its current slug is someone else's (see
 * `renamedRowOwnsFile`). Such a file is never applied to the row — not by
 * the push-sync, not by a read path: it would hand the row's checkpoints and
 * webhook URL to an unrelated stream. A file that does not parse is never
 * applied anyway and is not judged here.
 */
async function foreignFileAtRenamedSlug(
  repoDir: string,
  head: string,
  row: IFlow,
  file: FlowFile | null,
): Promise<boolean> {
  if (!row.lastRenameCommit || file === null) return false;
  if (renamedRowOwnsFile(row, file)) return false;
  return !(await isAncestorCommit(repoDir, row.lastRenameCommit, head));
}

/** What the settle step needs to know about the tree it judges. */
interface RenameSettleContext {
  workspaceId: string;
  repoDir: string;
  head: string;
  fileSlugs: ReadonlySet<string>;
  /** The parsed file under `slug` in this tree, when it is there and parses. */
  parsedFileAt: (slug: string) => FlowFile | null;
}

/**
 * Retire one row's rename guard when the tree has caught up with it, or
 * resolve it when the tree never will. Called only for a tree verified to
 * be the mirror's main (see `currentTreeCheck`).
 *
 *  - The commit is in `head`'s history, or the file at the row's current
 *    slug is in the tree under some other commit (a history rewrite kept
 *    the tree) AND is the row's own (`renamedRowOwnsFile`: same stream, or
 *    it lists one of the row's old names): the rename landed. The guard is
 *    cleared.
 *  - The file at the row's current slug is SOMEONE ELSE's (another source or
 *    destination, no shared old name — a laptop push that took the name
 *    first): the rename can never land (the mirror refuses its push, and
 *    the name is taken), so it is lost now, whatever the guard's age. The
 *    row must vacate the name — that file is a flow of its own — and goes
 *    back as below; failing a same-stream file, to the name it had before
 *    the rename (one with no file in this tree first), as if the rename had
 *    never been made, and is then judged on this tree like any other row.
 *  - The guard has expired and the tree still has the file under one of
 *    the row's OLD names: the rename commit never reached main, and the
 *    tree is the truth. The row is re-keyed back — to the most recent old
 *    name whose file points at the SAME source and destination (the
 *    aliases are in rename order, newest last); a file under an old name
 *    that reads from or writes to something else is another stream and
 *    must not inherit this row's checkpoints. Said loudly: a rename was lost.
 *  - Expired with no such file: the guard is cleared; the row is a removal
 *    candidate like any other.
 *  - Recent and absent: kept; the callers honour it.
 *
 * A LOST rename also hands the row back the blob it started from
 * (`renameFromBlobSha` → `sourceBlobSha`): the rename never happened on
 * main, so that is what main last had for this row, and it is the blob a
 * laptop move is paired against afterwards — one every instance has.
 *
 * The clears are scoped to the guard that was judged (`lastRenameCommit:
 * <commit>`), so a newer guard written concurrently by another rename
 * survives.
 */
async function settleFlowRenameGuard(
  row: IFlow,
  ctx: RenameSettleContext,
): Promise<"kept" | "cleared" | "rekeyed"> {
  const { workspaceId, repoDir, head, fileSlugs, parsedFileAt } = ctx;
  const commit = row.lastRenameCommit as string;
  const guard = { _id: row._id, lastRenameCommit: commit };
  const unsetGuard = {
    lastRenameCommit: 1,
    lastRenameAt: 1,
    renameFromBlobSha: 1,
  } as const;
  const clearLanded = () => Flow.updateOne(guard, { $unset: unsetGuard });
  const clearLost = () =>
    Flow.updateOne(guard, {
      $unset: unsetGuard,
      ...(row.renameFromBlobSha
        ? { $set: { sourceBlobSha: row.renameFromBlobSha } }
        : {}),
    });
  if (await isAncestorCommit(repoDir, commit, head)) {
    await clearLanded();
    return "cleared";
  }
  const sameStreamOldSlug = [...(row.aliases ?? [])].reverse().find(alias => {
    if (!fileSlugs.has(alias)) return false;
    const parsed = parsedFileAt(alias);
    return parsed !== null && sameFlowTarget(row, parsed);
  });
  let lostNow = false;
  if (row.slug && fileSlugs.has(row.slug)) {
    const atSlug = parsedFileAt(row.slug);
    // A file that does not parse is never applied, so it cannot hand this
    // row someone else's definition: it counts as landed (marked invalid
    // by the loop) unless the row's stream is still under an old name.
    const landed =
      atSlug === null
        ? sameStreamOldSlug === undefined
        : renamedRowOwnsFile(row, atSlug);
    if (landed) {
      logger.info("Flow rename present in the tree under another commit", {
        workspaceId,
        slug: row.slug,
        lastRenameCommit: commit,
      });
      await clearLanded();
      return "cleared";
    }
    lostNow = true;
  }
  const age = row.lastRenameAt
    ? Date.now() - row.lastRenameAt.getTime()
    : Infinity;
  if (!lostNow && age <= RENAME_GUARD_MS) return "kept";
  let back = sameStreamOldSlug;
  if (back === undefined && lostNow) {
    const newestFirst = [...(row.aliases ?? [])].reverse();
    const free: string[] = [];
    for (const alias of newestFirst) {
      const held = await Flow.exists({
        workspaceId,
        slug: alias,
        _id: { $ne: row._id },
      });
      if (!held) free.push(alias);
    }
    back = free.find(alias => !fileSlugs.has(alias)) ?? free[0];
  }
  if (row.slug && back !== undefined) {
    logger.error(
      lostNow
        ? "Flow rename lost its new name to another file on main; re-keying the row back so that file can be a flow of its own"
        : "Flow rename commit never reached main; re-keying the row back to the file the tree has",
      {
        workspaceId,
        flowId: String(row._id),
        renamedTo: row.slug,
        revertedTo: back,
        sameStream: back === sameStreamOldSlug,
        lastRenameCommit: commit,
      },
    );
    await rekeyFlowSlug(row._id as Types.ObjectId, row.slug, back, undefined, {
      recordOldAsAlias: false,
    });
    await clearLost();
    return "rekeyed";
  }
  if (lostNow) {
    // No old name to go back to (none recorded, or every one held by
    // another row): kept as it is. The sync and the read paths still never
    // apply the other file to it (`foreignFileAtRenamedSlug`).
    logger.error(
      "Flow rename lost its new name to another file on main, and the row has no free old name to go back to; keeping it",
      { workspaceId, flowId: String(row._id), slug: row.slug },
    );
    return "kept";
  }
  logger.warn("Flow rename commit never reached main; trusting the tree", {
    workspaceId,
    flowId: String(row._id),
    slug: row.slug,
    lastRenameCommit: commit,
  });
  await clearLost();
  return "cleared";
}

/**
 * The push-sync's settle step: every guarded row, on a verified tree.
 *
 * The renaming instance's own main contains its rename commit before the
 * mirror does: judged there, every guard would be retired on the spot and
 * the other instances — still on the mirror's main — would see no guard,
 * no commit, and a flow to create and tear down. Only a tree every
 * instance agrees on may retire a guard; anything else keeps them all.
 */
async function settleRenameGuards(args: {
  workspaceId: string;
  repoDir: string;
  head: string;
  fileSlugs: ReadonlySet<string>;
  parsedFileAt: (slug: string) => FlowFile | null;
  /** See `currentTreeCheck`: only the mirror's main may retire a guard. */
  treeIsCurrent: () => Promise<boolean>;
}): Promise<void> {
  const { workspaceId, head, treeIsCurrent } = args;
  const guarded = await Flow.find({
    workspaceId,
    lastRenameCommit: { $exists: true },
  });
  if (guarded.length === 0) return;
  if (!(await treeIsCurrent())) {
    logger.info(
      "Tree not verified as the mirror's main; keeping rename guards",
      { workspaceId, head, guarded: guarded.map(row => row.slug) },
    );
    return;
  }
  for (const row of guarded) await settleFlowRenameGuard(row, args);
}

/**
 * The READ paths' settle step (GET/list, the run and consumer freshness
 * check): a rename whose commit never reached main, with no push after the
 * guard expired, would otherwise stay wedged — the row's file is nowhere,
 * so runs are refused, the list shows the old name as a placeholder and
 * the row 404s — until some unrelated push ran the sync. Rows that carry a
 * guard and whose file is missing from `defs` — or whose new name another
 * file holds — are settled here exactly as the sync would, on a verified
 * tree. Returns true when a row was re-keyed (the caller re-reads).
 */
export async function settleLostRenamesForRead(args: {
  workspaceId: string;
  repoDir: string;
  defs: FlowDefinitionAtMain[];
  /** Only these rows, when the caller has one in hand. */
  rows?: IFlow[];
}): Promise<boolean> {
  const { workspaceId, repoDir, defs } = args;
  const fileSlugs = new Set(defs.map(def => def.slug));
  const bySlug = new Map(defs.map(def => [def.slug, def] as const));
  // Its file is missing — or another file holds its new name (a rename
  // that lost that name: settled the same way, see settleFlowRenameGuard).
  const candidates = (
    args.rows ??
    (await Flow.find({ workspaceId, lastRenameCommit: { $exists: true } }))
  ).filter(row => {
    if (!row.lastRenameCommit || !row.slug) return false;
    if (!fileSlugs.has(row.slug)) return true;
    const parsed = bySlug.get(row.slug)?.parsed ?? null;
    return parsed !== null && !renamedRowOwnsFile(row, parsed);
  });
  if (candidates.length === 0) return false;
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!head) return false;
  const treeIsCurrent = currentTreeCheck(workspaceId, head);
  if (!(await treeIsCurrent())) return false;
  let rekeyed = false;
  for (const row of candidates) {
    const outcome = await settleFlowRenameGuard(row, {
      workspaceId,
      repoDir,
      head,
      fileSlugs,
      parsedFileAt: slug => bySlug.get(slug)?.parsed ?? null,
    });
    if (outcome === "rekeyed") rekeyed = true;
  }
  return rekeyed;
}

/**
 * An alias two rows claim resolves to neither, so a file whose `aliases:`
 * names something another row already answers to — by slug or by alias; a
 * copied file is the usual way — loses that entry rather than poisoning
 * the other row's old links. Returns what was dropped, for the log.
 */
async function dropAliasesClaimedElsewhere(
  workspaceId: string,
  doc: Pick<IFlow, "_id" | "aliases">,
): Promise<string[]> {
  const aliases = doc.aliases ?? [];
  if (aliases.length === 0) return [];
  const claimants = await Flow.find({
    workspaceId,
    _id: { $ne: doc._id },
    $or: [{ slug: { $in: aliases } }, { aliases: { $in: aliases } }],
  })
    .select("slug aliases")
    .lean();
  const claimed = new Set<string>();
  for (const claimant of claimants) {
    for (const name of [claimant.slug, ...(claimant.aliases ?? [])]) {
      if (name && aliases.includes(name)) claimed.add(name);
    }
  }
  if (claimed.size === 0) return [];
  const kept = aliases.filter(alias => !claimed.has(alias));
  doc.aliases = kept.length > 0 ? kept : undefined;
  return [...claimed];
}

/**
 * Give rows back the aliases their files still list, once nothing current
 * claims them. A new flow pushed under an old name takes that name (current
 * wins) and the renamed row drops the alias — but its FILE keeps listing
 * it, and the file is the record. When the newcomer is gone, the old name
 * should answer to the old flow again, and `resolve` (which reads files)
 * and the row (which the routes read) must agree. Runs after the
 * reconcile, so a row torn down in this very sync no longer claims
 * anything. Names still held by another row (slug or alias) or by a file
 * at main stay out.
 */
async function reacquireFileAliases(
  workspaceId: string,
  files: Array<{ path: string; contents: string }>,
  fileSlugs: ReadonlySet<string>,
): Promise<void> {
  for (const file of files) {
    const slug = slugFromFlowFilePath(file.path);
    if (!slug) continue;
    const wanted = parseFlowFile(file.contents)?.aliases ?? [];
    if (wanted.length === 0) continue;
    const row = await Flow.findOne({ workspaceId, slug })
      .select("_id aliases")
      .lean();
    if (!row) continue;
    const missing = wanted.filter(
      alias =>
        alias !== slug &&
        !fileSlugs.has(alias) &&
        !(row.aliases ?? []).includes(alias),
    );
    if (missing.length === 0) continue;
    const claimants = await Flow.find({
      workspaceId,
      _id: { $ne: row._id },
      $or: [{ slug: { $in: missing } }, { aliases: { $in: missing } }],
    })
      .select("slug aliases")
      .lean();
    const claimed = new Set(
      claimants.flatMap(c => [c.slug, ...(c.aliases ?? [])]).filter(Boolean),
    );
    const free = missing.filter(alias => !claimed.has(alias));
    if (free.length === 0) continue;
    await Flow.updateOne(
      { _id: row._id },
      { $addToSet: { aliases: { $each: free } } },
    );
    logger.info("Flow re-acquired aliases its file lists", {
      workspaceId,
      slug,
      aliases: free,
    });
  }
}

/** Whether a row and a file point at the same source and destination. */
function sameFlowTarget(row: IFlow, file: FlowFile): boolean {
  try {
    const rowTarget = flowRenameTarget(flowToFile(row));
    return rowTarget !== null && rowTarget === flowRenameTarget(file);
  } catch {
    return false;
  }
}

/**
 * Laptop rename detection (graceful rename, rule 3 of api/src/rename): pair
 * every row whose file is gone with a file that has no row, and re-key the
 * pairs before the per-file loop runs — so the moved file is an UPDATE of
 * its row rather than a teardown plus a create. Returns what was re-keyed.
 *
 * Never throws into the sync: a failure here falls back to today's
 * behaviour for the files it could not judge, and says so in the log.
 */
export async function rekeyRenamedFlows(args: {
  workspaceId: string;
  repoDir: string;
  /** The commit `files` were read at. */
  head: string;
  files: Array<{ path: string; contents: string; oid: string }>;
  /**
   * See `currentTreeCheck`. A pair that would move a row BACK to one of its
   * own old names is honoured only on the mirror's main: on any other tree
   * it is far likelier a view that predates the rename than a real move
   * back, and the row is left as it is. Absent → every tree counts.
   */
  treeIsCurrent?: () => Promise<boolean>;
}): Promise<SlugRenamePair[]> {
  const { workspaceId, repoDir, head, files, treeIsCurrent } = args;
  const fileBySlug = new Map<
    string,
    { path: string; contents: string; oid: string }
  >();
  for (const file of files) {
    const slug = slugFromFlowFilePath(file.path);
    if (slug) fileBySlug.set(slug, file);
  }
  const rows = await Flow.find({ workspaceId, slug: { $exists: true } });
  const rowBySlug = new Map<string, IFlow>();
  for (const row of rows) {
    if (row.slug) rowBySlug.set(row.slug, row);
  }
  const addedFiles = [...fileBySlug.entries()].filter(
    ([slug]) => !rowBySlug.has(slug),
  );
  const removedRows: IFlow[] = [];
  for (const row of rows) {
    if (row.slug === undefined || fileBySlug.has(row.slug)) continue;
    // A row renamed by a recent commit this tree does not contain, whose
    // OLD file is still in this tree, is not "gone": the tree is older than
    // the rename. Leave it out of the pairing — that old file is not a
    // candidate for anything. But a guarded row whose old name is gone
    // too has lost a race (a laptop `git mv` or another rename won the
    // mirror): it must pair like any other, or the winner's file becomes
    // a new flow and this row is torn down.
    const oldNamePresent = (row.aliases ?? []).some(alias =>
      fileBySlug.has(alias),
    );
    if (oldNamePresent && (await renameGuardActive(repoDir, head, row))) {
      logger.info("Tree predates a flow rename; not pairing its old slug", {
        workspaceId,
        slug: row.slug,
        lastRenameCommit: row.lastRenameCommit,
        head,
      });
      continue;
    }
    removedRows.push(row);
  }
  if (removedRows.length === 0 || addedFiles.length === 0) return [];

  const removed: RemovedSlug[] = [];
  const baseOids: Array<string | undefined> = [];
  for (const row of removedRows) {
    const slug = row.slug as string;
    // The file as main last had it: git still has the blob — the one the
    // rename started from when the tree does not hold the row's rename
    // (`pairingBaseBlob`). When neither is here (a row stamped before blobs
    // were recorded), the row's own projection stands in — the same bytes
    // the write-through would commit.
    const base = await pairingBaseBlob(repoDir, head, row);
    baseOids.push(base?.oid);
    let contents = base?.contents ?? null;
    if (contents === null) {
      try {
        contents = serializeFlowFile(flowToFile(row));
      } catch {
        contents = null;
      }
    }
    const parsedOld = contents === null ? null : parseFlowFile(contents);
    removed.push({
      slug,
      aliases: row.aliases ?? [],
      contents: contents ?? undefined,
      target: parsedOld ? flowRenameTarget(parsedOld) : null,
    });
  }
  const added = addedFiles.map(([slug, file]) => {
    const parsed = parseFlowFile(file.contents);
    return {
      slug,
      contents: file.contents,
      aliases: parsed?.aliases ?? [],
      target: parsed ? flowRenameTarget(parsed) : null,
    };
  });
  const gitRenames = new Map<string, string>();
  for (const [from, to] of await detectGitRenames(
    repoDir,
    removedRows.map((row, i) => ({
      path: flowFilePath(row.slug as string),
      oid: baseOids[i],
    })),
    addedFiles.map(([slug, file]) => ({
      path: flowFilePath(slug),
      oid: file.oid,
    })),
  )) {
    const fromSlug = slugFromFlowFilePath(from);
    const toSlug = slugFromFlowFilePath(to);
    if (fromSlug && toSlug) gitRenames.set(fromSlug, toSlug);
  }

  const pairing = pairRenamedSlugs({ removed, added, gitRenames });
  for (const entry of pairing.ambiguous) {
    // Not guessed: the removed slug is left to the reconciler (teardown, as
    // before), loud enough to explain why a rename was not recognised.
    logger.warn("Ambiguous flow rename; not pairing", {
      workspaceId,
      slug: entry.slug,
      rule: entry.rule,
      candidates: entry.candidates,
    });
  }
  for (const entry of pairing.targetMismatch) {
    // Honoured (the file says so), but the stream now points elsewhere
    // than its checkpoints were taken against.
    logger.warn(
      "Flow renamed by alias onto a different source/destination; its checkpoints carry over",
      { workspaceId, from: entry.from, to: entry.to },
    );
  }
  const done: SlugRenamePair[] = [];
  for (const pair of pairing.pairs) {
    const row = rowBySlug.get(pair.from);
    if (!row) continue;
    if (
      (row.aliases ?? []).includes(pair.to) &&
      treeIsCurrent &&
      !(await treeIsCurrent())
    ) {
      logger.info(
        "Flow would be renamed back to an old name on an unverified tree; keeping it",
        { workspaceId, from: pair.from, to: pair.to, via: pair.via },
      );
      continue;
    }
    try {
      await rekeyFlowSlug(row._id as Types.ObjectId, pair.from, pair.to, head);
      done.push(pair);
      logger.info("Flow renamed in place from a pushed file move", {
        workspaceId,
        flowId: String(row._id),
        from: pair.from,
        to: pair.to,
        via: pair.via,
      });
    } catch (error) {
      logger.warn("Could not re-key a renamed flow; leaving it as is", {
        workspaceId,
        from: pair.from,
        to: pair.to,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return done;
}

/** Why a parsed file cannot become a row — refusal or schema, same as save(). */
function flowFileApplyFailure(
  file: FlowFile,
  args: { workspaceId: string; slug: string; createdBy: string },
): string | null {
  const hydrated = hydrateFlowRow(file, args);
  if (hydrated.refusal) return hydrated.refusal;
  if (hydrated.schemaErrors.length === 0) return null;
  return hydrated.schemaErrors.map(e => `${e.path}: ${e.message}`).join("; ");
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

  let refusal: string | null;
  try {
    refusal = applyDefinition(doc, file);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
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
  /**
   * `oid` is git's blob id from the raw bytes — the only sha a row may
   * store, because the write-through's compare-and-swap checks it against
   * the repo (a file that is not valid UTF-8 hashes differently once
   * decoded, and a row holding that sha could never save again).
   */
  files: Array<{ path: string; contents: string; oid: string }>;
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
      oid: blobOid(buf),
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

  // A file that moved is the same flow: re-key its row to the new slug
  // BEFORE the loop below looks rows up by slug, so the moved file reads as
  // an update (same id, same endpoint, same checkpoints) and the reconciler
  // never sees the old slug as a removal. Must not abort the sync: an error
  // here means the files it could not judge get today's behaviour.
  const repoDir = repoDirFor(workspaceId);
  const fileSlugs = new Set<string>();
  for (const file of files) {
    const slug = slugFromFlowFilePath(file.path);
    if (slug) fileSlugs.add(slug);
  }
  // Ids for files with no row are derived from the slug; a row of another
  // slug may already hold one (a renamed git-born flow), so the free
  // derivation is decided against the rows as they stand.
  const treeIsCurrent = currentTreeCheck(workspaceId, head, reason => {
    logger.info("Flow sync tree is not the mirror's current main", {
      workspaceId,
      head,
      reason,
    });
  });
  const parsedCache = new Map<string, FlowFile | null>();
  const parsedFileAt = (slug: string): FlowFile | null => {
    if (!parsedCache.has(slug)) {
      const file = files.find(f => slugFromFlowFilePath(f.path) === slug);
      parsedCache.set(slug, file ? parseFlowFile(file.contents) : null);
    }
    return parsedCache.get(slug) ?? null;
  };
  try {
    await settleRenameGuards({
      workspaceId,
      repoDir,
      head,
      fileSlugs,
      parsedFileAt,
      treeIsCurrent,
    });
  } catch (error) {
    logger.warn("Flow rename guards could not be settled", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const idRows = await Flow.find({ workspaceId }).select("_id slug").lean();
  try {
    await rekeyRenamedFlows({
      workspaceId,
      repoDir,
      head,
      files,
      treeIsCurrent,
    });
  } catch (error) {
    logger.warn("Flow rename detection failed; syncing by slug only", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  for (const { path, contents, oid } of files) {
    const slug = slugFromFlowFilePath(path);
    if (!slug) continue;
    seen.add(slug);

    // Git's id from the raw bytes (see FlowFilesAtMain): what the row
    // stores must be what the repo answers to.
    const sha = oid;
    const parsedForDesired = parseFlowFile(contents);
    let row = await Flow.findOne({ workspaceId, slug });
    // Another file under the new name of a rename that has not landed here
    // (the settle step re-keys such a row away on a verified tree; this is
    // what is left on one it could not verify): never this row's
    // definition. The row is kept exactly as it is — its own definition
    // stands in for the reconciler — and the file waits for the name to be
    // free; it becomes a flow of its own then, not a takeover of this one.
    if (
      row &&
      (await foreignFileAtRenamedSlug(repoDir, head, row, parsedForDesired))
    ) {
      logger.warn(
        "Another file holds a renamed flow's new name; not applying it to that flow",
        {
          workspaceId,
          path,
          flowId: String(row._id),
          lastRenameCommit: row.lastRenameCommit,
        },
      );
      const flowId = String(row._id);
      if (!desired.some(d => d.flowId === flowId)) {
        desired.push({ slug, file: flowToFile(row), flowId });
      }
      result.unchanged++;
      continue;
    }
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
      row &&
      row.sourceBlobSha === sha &&
      row.lastSeenBlobSha === sha &&
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
        await markFlowInvalid(row, "unparseable flow file", path, sha);
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
      if (row) await markFlowInvalid(row, applyFailure, path, sha);
      result.invalid.push(slug);
      continue;
    }

    // A file at a slug some row holds as an ALIAS is either a new flow
    // taking an old name (legitimate: current wins, the old row loses the
    // alias below) or a tree read before that row's recent rename commit
    // landed (its old file is still here, its new one is not). The second
    // must create nothing and tear nothing down: the row is kept as it is
    // and the next push, which contains the rename, reconciles. Only a
    // recorded, recent, not-yet-landed rename says so (`renameGuardActive`).
    if (!row) {
      const claimant = await Flow.findOne({ workspaceId, aliases: slug });
      if (claimant?.slug) {
        const guarded = await renameGuardActive(repoDir, head, claimant);
        // The same stream under its old name: the file points at the same
        // source and destination as the row that used to be called this,
        // and the row's current file is not in this tree. Either this tree
        // predates the rename (a guard says so, or the guard was retired
        // early / expired / never recorded) or the file was really moved
        // back. The two are told apart by whether the tree is the mirror's
        // main — and when that cannot be known, the row is kept as it is:
        // a name flip is recoverable, a teardown (checkpoints, executions,
        // webhook URL) is not. An unrelated file that merely reuses the
        // name (a different target) is created normally.
        // ("Not in this tree" includes another file holding its new name:
        // that one is not its file — see foreignFileAtRenamedSlug.)
        const claimantFileHere =
          fileSlugs.has(claimant.slug) &&
          !(await foreignFileAtRenamedSlug(
            repoDir,
            head,
            claimant,
            parsedFileAt(claimant.slug),
          ));
        const sameStream =
          !claimantFileHere && sameFlowTarget(claimant, parsed);
        const keep = guarded || (sameStream && !(await treeIsCurrent()));
        if (keep) {
          logger.info("Tree predates a flow rename; keeping the renamed row", {
            workspaceId,
            path,
            renamedTo: claimant.slug,
            guarded,
          });
          desired.push({
            slug: claimant.slug,
            file: flowToFile(claimant),
            flowId: String(claimant._id),
          });
          result.unchanged++;
          continue;
        }
        if (sameStream) {
          // The mirror's main says the file lives under the old name again:
          // a rename back (a lost rename commit, or a laptop `git mv`). The
          // row follows its file — same id, same checkpoints.
          logger.warn(
            "Flow file is back under an old name; re-keying the row to it",
            { workspaceId, path, from: claimant.slug, to: slug },
          );
          await rekeyFlowSlug(claimant._id, claimant.slug, slug, head);
          row = await Flow.findById(claimant._id);
          if (row) {
            desired.push({ slug, file: parsed, flowId: String(row._id) });
          }
        }
      }
    }
    const isNew = !row;
    const wasInvalid = row ? isFlowMarkedInvalid(row) : false;
    const doc =
      row ??
      new Flow({
        _id: freeDerivedFlowId(workspaceId, slug, idRows),
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
        await markFlowInvalid(row, refusal, path, sha);
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
    const droppedAliases = await dropAliasesClaimedElsewhere(
      workspaceId,
      doc as IFlow,
    );
    if (droppedAliases.length > 0) {
      logger.warn("Flow file lists aliases another flow already claims", {
        workspaceId,
        path,
        dropped: droppedAliases,
      });
    }
    (doc as IFlow).sourceBlobSha = sha;
    (doc as IFlow).lastSeenBlobSha = sha;
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
      // The row is marked invalid with the blob it SAW, exactly as GET's
      // resync does: the schedules pause, the list says why, and a UI save
      // that fixes it may overwrite exactly this version. (The doc in hand
      // was mutated by applyDefinition; mark the persisted one.)
      if (row) {
        const fresh = await Flow.findById(row._id);
        if (fresh) {
          await markFlowInvalid(
            fresh,
            error instanceof Error ? error.message : String(error),
            path,
            sha,
          );
        }
      }
      result.invalid.push(slug);
      continue;
    }
    if (wasInvalid) await clearFlowInvalid((doc as IFlow)._id);
    if (isNew) {
      // Current always wins: a new flow at a name some renamed flow still
      // answered to takes that name; the old row drops the alias.
      const released = await Flow.updateMany(
        { workspaceId, aliases: slug, _id: { $ne: doc._id } },
        { $pull: { aliases: slug } },
      );
      if (released.modifiedCount > 0) {
        logger.info("A new flow took a name another flow held as an alias", {
          workspaceId,
          slug,
          releasedFrom: released.modifiedCount,
        });
      }
      result.created++;
      // A row created in this pass has no id until now, so its desired entry
      // is added here rather than above.
      desired.push({ slug, file: parsed, flowId: String(doc._id) });
    } else {
      result.updated++;
    }
    logger.info("Flow synced from repo", { workspaceId, slug, isNew });
  }

  // A row still under a rename guard whose file is in neither its new nor
  // any old name in this tree is not a removal: its rename commit may be
  // on its way to the mirror, or it lost a race nothing paired. Keep it,
  // as the dbt sweep keeps guarded rows — a teardown is not recoverable.
  const desiredIds = new Set(desired.map(d => d.flowId));
  for (const row of await Flow.find({
    workspaceId,
    lastRenameCommit: { $exists: true },
  })) {
    if (!row.slug || desiredIds.has(String(row._id))) continue;
    if (fileSlugs.has(row.slug)) continue;
    if (!(await renameGuardActive(repoDir, head, row))) continue;
    logger.info("Guarded flow has no file in this tree; keeping it", {
      workspaceId,
      slug: row.slug,
      lastRenameCommit: row.lastRenameCommit,
    });
    desired.push({
      slug: row.slug,
      file: flowToFile(row),
      flowId: String(row._id),
    });
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

  // After the destructive half: a name a torn-down newcomer held is free
  // again for the row whose file still lists it.
  try {
    await reacquireFileAliases(workspaceId, files, fileSlugs);
  } catch (error) {
    logger.warn("Could not re-acquire file aliases", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}
