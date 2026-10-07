/**
 * Flow definitions in the workspace repo (RFC #904 / issue #956).
 *
 * Git is the only definition store. Mongo holds a SHA-checked derived cache
 * plus runtime (cursors, webhook secret, sync state). This module is the
 * git-ward half: every in-product mutation commits `flows/<slug>.yml`
 * first. A failed commit fails the request; there is no Mongo-only success.
 *
 * The other direction — a push making the FILE authoritative — lives in
 * `flow-sync.service.ts`. Runtime reads the derived row after comparing
 * `sourceBlobSha` to the blob at main.
 */
import { RepoRequiredError } from "../apps/config";
import { loggers } from "../logging";
import { authorForUser } from "../apps/workspace-consoles.service";
import { requireWorkspaceRepo } from "../apps/workspace-repo-required";
import {
  connectedTierEnabled,
  freshenBeforeMainWrite,
  resolveMirrorTarget,
  mirrorPushNow,
  queueMirrorPush,
} from "../apps/cloud-repo.service";
import {
  BlobPreconditionError,
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  listTree,
  readBlob,
  readBlobsBatch,
  repoDirFor,
  resolveCommit,
  type GitAuthor,
} from "../apps/repository.service";
import { Flow, type IFlow } from "../database/workspace-schema";
import {
  flowFilePath,
  flowToFile,
  parseFlowFile,
  serializeFlowFile,
  slugFromFlowFilePath,
} from "./flow-config-files";
import { mergedAliases } from "../rename/flow-dbt-job-pairing";

const logger = loggers.api("flow-config");

/**
 * One commit on main for a flow config mutation. The rename service
 * (api/src/rename/flow-rename.ts) uses it so a `git mv` + alias write is ONE
 * commit through the same freshen/push path as every other write here.
 */
export async function commitFlowConfig(
  workspaceId: string,
  mutation: { writes?: Record<string, string>; deletes?: string[] },
  message: string,
  author?: GitAuthor,
  /** Compare-and-swap on content; see `commitBlobsOnBranch`. */
  expectBlobs?: Record<string, string | null>,
): Promise<{ commitOid: string; unchanged: boolean }> {
  const repoDir = await requireWorkspaceRepo(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  const result = await commitBlobsOnBranch(repoDir, DEFAULT_BRANCH, mutation, {
    message,
    author,
    expectBlobs,
  });
  if (!result.unchanged) queueMirrorPush(workspaceId);
  return { commitOid: result.commitOid, unchanged: result.unchanged };
}

async function commitConfig(
  workspaceId: string,
  mutation: { writes?: Record<string, string>; deletes?: string[] },
  message: string,
  author?: GitAuthor,
): Promise<void> {
  await commitFlowConfig(workspaceId, mutation, message, author);
}

/** Write-through: the file is committed first; the caller then updates the index. */
export interface FlowFileWriteResult {
  ok: boolean;
  /** True when a commit was actually made (an unchanged definition is a no-op). */
  changed: boolean;
  /** Blob sha of the committed (or unchanged) definition. */
  sourceBlobSha?: string;
  error?: string;
  /**
   * The write was refused because the file (or the row's slug) changed in
   * the repo since this row was loaded — a rename or another edit landed
   * first. A 409 for the caller to reload and retry, never an upstream
   * failure: the repo is fine, the edit is stale.
   */
  conflict?: true;
}

/**
 * Commit `flows/<slug>.yml` from the in-memory definition.
 * Does not touch Mongo — the caller stamps `sourceBlobSha` and saves after.
 */
export async function commitFlowFile(
  flow: IFlow,
  actorUserId?: string,
  messageOverride?: string,
): Promise<FlowFileWriteResult> {
  if (!flow.slug || !flow.name?.trim()) {
    return { ok: true, changed: false };
  }
  const workspaceId = flow.workspaceId.toString();
  const invalid = typeof flow.definitionInvalid?.reason === "string";
  // The file is the record of a flow's old names: an alias the ROW lost to
  // a newcomer (current wins) is still listed in the file, and a save that
  // regenerates the file from the row must not erase it — once the
  // newcomer is gone the old name must answer to this flow again. Read
  // what main lists and keep it.
  const fromMain = await flowAliasesAtMain(workspaceId, flow.slug);
  const projected = flowToFile(flow);
  const aliases = mergedAliases(projected.aliases, fromMain, flow.slug);
  const contents = serializeFlowFile({
    ...projected,
    ...(aliases.length > 0 ? { aliases } : {}),
  });
  const sha = blobOid(contents);
  // Nothing to write only when the row is healthy AND the repo already
  // holds this exact definition. An INVALID row holds its last valid
  // definition while main holds something broken: that definition is
  // exactly what must be committed, even unchanged — the caller then
  // clears the marker, and it must not do so over a file still broken.
  if (!invalid && (flow.lastSeenBlobSha ?? flow.sourceBlobSha) === sha) {
    return { ok: true, changed: false, sourceBlobSha: sha };
  }
  // A row marked invalid before `lastSeenBlobSha` existed does not know
  // what is on main; writing with no precondition could overwrite a fix
  // someone pushed meanwhile. The reload stamps the field (GET's resync
  // records the blob it sees), so ask for one rather than guess.
  if (invalid && !flow.lastSeenBlobSha) {
    return {
      ok: false,
      changed: false,
      conflict: true,
      error:
        "the flow was marked invalid before the repo state was recorded on it; reload the flow (which records it) and retry",
    };
  }
  try {
    // The row in hand may predate a rename that landed while the request
    // was in flight: writing `flows/<old slug>.yml` would resurrect the
    // moved file beside the new one — a second stream on the same source
    // and destination. Two checks, in the order the race can hit them:
    // the row's CURRENT slug, read AFTER the freshen that precedes every
    // main write (a rename landing during that freshen is seen); and a
    // compare-and-swap on the file itself (`expectBlobs`: the path must
    // still hold the blob this row was last synced from), which catches a
    // rename or edit landing between that read and the commit. Either
    // fails the request — the caller reloads and retries — rather than
    // guessing which of two files the definition belongs to.
    await requireWorkspaceRepo(workspaceId);
    await freshenBeforeMainWrite(workspaceId);
    const current = await Flow.findById(flow._id).select("slug").lean();
    if (current && current.slug && current.slug !== flow.slug) {
      return {
        ok: false,
        changed: false,
        conflict: true,
        error: `the flow was renamed to "${current.slug}" while this change was being made; reload and retry`,
      };
    }
    // What the path must still hold: the blob this row last SAW at main —
    // `lastSeenBlobSha`, which a broken file sets too, so a UI save that
    // fixes a bad laptop push is allowed through (that is the recovery
    // path), while an edit nobody has seen yet is refused. A healthy row
    // from before that field falls back to the last applied blob (equal to
    // what it saw); an invalid one was sent to reload above.
    const expected = flow.lastSeenBlobSha ?? flow.sourceBlobSha;
    await commitFlowConfig(
      workspaceId,
      { writes: { [flowFilePath(flow.slug)]: contents } },
      messageOverride ?? `flow: "${flow.name ?? flow.slug}" (${flow.slug})`,
      actorUserId ? await authorForUser(actorUserId) : undefined,
      // A row never synced from a blob has nothing to compare against.
      expected ? { [flowFilePath(flow.slug)]: expected } : undefined,
    );
    return { ok: true, changed: true, sourceBlobSha: sha };
  } catch (error) {
    if (error instanceof RepoRequiredError) throw error;
    if (error instanceof BlobPreconditionError) {
      return {
        ok: false,
        changed: false,
        conflict: true,
        error: `${error.path} changed in the workspace repo while this change was being made (a rename or another edit landed first); reload and retry`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Flow config write-through failed", {
      workspaceId: flow.workspaceId.toString(),
      slug: flow.slug,
      error: message,
    });
    return { ok: false, changed: false, error: message };
  }
}

/** The `aliases:` the flow's file at main lists, or none (no repo, no file). */
async function flowAliasesAtMain(
  workspaceId: string,
  slug: string,
): Promise<string[]> {
  try {
    const repoDir = repoDirFor(workspaceId);
    const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
    if (!head) return [];
    const blob = await readBlob(repoDir, head, flowFilePath(slug));
    return blob.isBinary ? [] : (parseFlowFile(blob.contents)?.aliases ?? []);
  } catch {
    return [];
  }
}

/**
 * A delete that would remove the wrong file, or none while the flow's file
 * lives on under another name: the flow was renamed while the delete was in
 * flight. The route answers 409 (reload and retry) and tears nothing down.
 */
export class FlowFileConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "FlowFileConflictError";
  }
}

/**
 * Remove a deleted flow's file. Throws {@link RepoRequiredError} without a
 * repo, {@link FlowFileConflictError} when a rename got in the way.
 *
 * The row in the caller's hand may predate a rename that landed while the
 * request was in flight. Deleting `flows/<that old slug>.yml` was then a
 * no-op, the caller tore the stream down, and the renamed file — still at
 * main with no row — came back on the next push sync as a NEW flow: a
 * deleted stream resurrected under a new id, re-backfilling into the same
 * destination. So the file deleted is the row's CURRENT one, read after the
 * freshen that precedes every main write, under a compare-and-swap; and a
 * row whose file is not at main while another file names its slug in
 * `aliases:` (a rename committed, its row update not yet) is refused.
 */
export async function deleteFlowFile(
  flow: Pick<IFlow, "workspaceId" | "slug" | "name"> & {
    _id?: IFlow["_id"];
  },
  actorUserId?: string,
): Promise<void> {
  if (!flow.slug) return;
  const workspaceId = flow.workspaceId.toString();
  const repoDir = await requireWorkspaceRepo(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  const current = flow._id
    ? await Flow.findById(flow._id).select("slug").lean()
    : null;
  const slug = current?.slug ?? flow.slug;
  const path = flowFilePath(slug);
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  let oid: string | null = null;
  if (head) {
    try {
      oid = (await readBlob(repoDir, head, path)).oid;
    } catch {
      oid = null;
    }
  }
  if (oid === null) {
    const movedTo = head
      ? await fileListingAlias(repoDir, head, workspaceId, slug)
      : null;
    if (movedTo) {
      throw new FlowFileConflictError(
        `the flow was renamed (its file is now ${movedTo}) while it was being deleted; nothing was deleted — reload and retry`,
      );
    }
    return; // No file to remove (a row whose file is already gone).
  }
  try {
    await commitFlowConfig(
      workspaceId,
      { deletes: [path] },
      `flow: delete "${flow.name ?? slug}" (${slug})`,
      actorUserId ? await authorForUser(actorUserId) : undefined,
      { [path]: oid },
    );
  } catch (error) {
    if (error instanceof BlobPreconditionError) {
      throw new FlowFileConflictError(
        `${error.path} changed while the flow was being deleted (a rename or another edit landed first); nothing was deleted — reload and retry`,
      );
    }
    throw error;
  }
}

/** A flow file at `head` (with no row of its own) listing `slug` as an old name. */
async function fileListingAlias(
  repoDir: string,
  head: string,
  workspaceId: string,
  slug: string,
): Promise<string | null> {
  // A file some row already owns is that row's (an old name it kept in its
  // file), not this flow moved.
  const owned = new Set(
    (await Flow.find({ workspaceId }).select("slug").lean()).map(r => r.slug),
  );
  const paths = (await listTree(repoDir, head))
    .map(entry => entry.path)
    .filter(p => {
      const fileSlug = slugFromFlowFilePath(p);
      return fileSlug !== null && !owned.has(fileSlug);
    });
  if (paths.length === 0) return null;
  for (const [p, buf] of await readBlobsBatch(repoDir, head, paths)) {
    if (parseFlowFile(buf.toString("utf8"))?.aliases?.includes(slug)) {
      return p;
    }
  }
  return null;
}

/**
 * Refuse to write when this process cannot reach the workspace's mirror.
 *
 * Without a resolvable mirror target the export resolves nothing, freshens
 * nothing, commits to a local-only repo and pushes nothing — a silent no-op
 * that prints success. That is what the first production run did, and it is
 * indistinguishable from a real export unless something checks. So check:
 * a bare repo that does not contain the mirror's current main is not a
 * cache of it, and committing on top of it would produce history that can
 * never be pushed.
 */
export async function assertMirrorReachable(
  workspaceId: string,
): Promise<{ ok: true; mainOid: string } | { ok: false; reason: string }> {
  if (!connectedTierEnabled()) {
    return {
      ok: false,
      reason:
        "connected-repo tier is disabled here (set APPS_CONNECTED_REPO_PUSH=allow); " +
        "an export would commit locally and push nothing",
    };
  }
  const target = await resolveMirrorTarget(workspaceId);
  if (!target) {
    return {
      ok: false,
      reason: `no connected repo resolves for workspace ${workspaceId}`,
    };
  }
  try {
    const repoDir = await requireWorkspaceRepo(workspaceId);
    await freshenBeforeMainWrite(workspaceId);
    const mainOid = await resolveCommit(
      repoDir,
      `refs/heads/${DEFAULT_BRANCH}`,
    );
    if (!mainOid) {
      return {
        ok: false,
        reason: `local ${DEFAULT_BRANCH} is missing after freshen — the local repo is not a clone of ${target.owner}/${target.repo}`,
      };
    }
    return { ok: true, mainOid };
  } catch (error) {
    if (error instanceof RepoRequiredError) {
      return { ok: false, reason: "no local repo after ensureLocalRepo" };
    }
    throw error;
  }
}

/**
 * One-shot operator export. Not a product write path — git is already the
 * store; this exists to recover a workspace whose files were never written.
 */
export async function exportWorkspaceFlows(
  workspaceId: string,
  actorUserId?: string,
): Promise<{
  written: number;
  skipped: number;
  failed: Array<{ slug: string; error: string }>;
  commitMade: boolean;
}> {
  const reachable = await assertMirrorReachable(workspaceId);
  if (!reachable.ok) {
    return {
      written: 0,
      skipped: 0,
      failed: [{ slug: "(workspace)", error: reachable.reason }],
      commitMade: false,
    };
  }

  const flows = await Flow.find({ workspaceId }).sort({ _id: 1 }).lean();

  const writes: Record<string, string> = {};
  const shaBySlug = new Map<string, { id: unknown; sha: string }>();
  const failed: Array<{ slug: string; error: string }> = [];
  let skipped = 0;

  for (const flow of flows as unknown as IFlow[]) {
    if (!flow.slug || !flow.name?.trim()) {
      skipped++;
      continue;
    }
    try {
      const contents = serializeFlowFile(flowToFile(flow));
      writes[flowFilePath(flow.slug)] = contents;
      shaBySlug.set(flow.slug, { id: flow._id, sha: blobOid(contents) });
    } catch (error) {
      failed.push({
        slug: flow.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let commitMade = false;
  if (Object.keys(writes).length > 0) {
    try {
      await commitConfig(
        workspaceId,
        { writes },
        `flows: export ${Object.keys(writes).length} definition(s)`,
        actorUserId ? await authorForUser(actorUserId) : undefined,
      );
      commitMade = true;
      for (const { id, sha } of shaBySlug.values()) {
        await Flow.updateOne(
          { _id: id },
          { $set: { sourceBlobSha: sha, lastSeenBlobSha: sha } },
        );
      }
      await mirrorPushNow(workspaceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const slug of shaBySlug.keys()) {
        failed.push({ slug, error: message });
      }
      return { written: 0, skipped, failed, commitMade: false };
    }
  }

  return { written: shaBySlug.size, skipped, failed, commitMade };
}
