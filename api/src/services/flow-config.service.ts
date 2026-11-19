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
import type { Types } from "mongoose";
import { RepoRequiredError } from "../apps/config";
import { loggers } from "../logging";
import { authorForUser } from "../apps/workspace-consoles.service";
import {
  boundRepoDirIfExists,
  requireWorkspaceRepo,
} from "../apps/workspace-repo-required";
import {
  commitToMainDurably,
  connectedTierEnabled,
  freshenBeforeMainWrite,
  resolveMirrorTarget,
  mirrorPushNow,
  type DurableMainCommit,
  type MainMutation,
} from "../apps/cloud-repo.service";
import {
  DEFAULT_BRANCH,
  blobOid,
  resolveCommit,
  readBlob,
  type GitAuthor,
} from "../apps/repository.service";
import { runGit } from "../apps/git";
import { Flow, type IFlow } from "../database/workspace-schema";
import {
  flowFilePath,
  flowToFile,
  serializeFlowFile,
  serializeFlowFileV1,
  parseFlowFile,
  flowMeaning,
  sameFlowMeaning,
} from "./flow-config-files";

const logger = loggers.api("flow-config");

/**
 * Commit whole-file writes/deletes onto main and land them on the mirror
 * before returning (`commitToMainDurably`): a definition the database then
 * follows must never exist only in this instance's cache. Throws when the
 * commit did not land; main is then as it was. Concurrent calls for one
 * workspace run one at a time. Shared by flow saves and history restores
 * (flows, workspace connectors).
 */
export async function commitConfigToMain(
  workspaceId: string,
  mutation: MainMutation,
  message: string,
  author?: GitAuthor,
): Promise<DurableMainCommit> {
  await requireWorkspaceRepo(workspaceId);
  return commitToMainDurably(workspaceId, mutation, { message, author });
}

/** Write-through: the file is committed first; the caller then updates the index. */
export interface FlowFileWriteResult {
  ok: boolean;
  /** True when a commit was actually made (an unchanged definition is a no-op). */
  changed: boolean;
  /** Blob sha of the committed (or unchanged) definition. */
  sourceBlobSha?: string;
  /**
   * The commit at main that holds this definition: the one written, or, for
   * an unchanged definition, main's head when it was checked.
   */
  commitSha?: string;
  error?: string;
  /** The file at main moved away from `expectBlobAtMain`; nothing written. */
  conflict?: boolean;
}

/**
 * `flows/<slug>.yml` on main moved away from the blob a write was based on:
 * someone else changed the definition first. The caller re-reads and retries.
 */
export class FlowFileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowFileConflictError";
  }
}

/** The blob id of `relPath` at `head`, or null when the path is absent. */
async function blobIdAt(
  repoDir: string,
  head: string,
  relPath: string,
): Promise<string | null> {
  const { stdout } = await runGit([
    "-C",
    repoDir,
    "rev-parse",
    "--verify",
    "--quiet",
    `${head}:${relPath}`,
  ]).catch(() => ({ stdout: "" }));
  return stdout.trim() || null;
}

/**
 * Commit `flows/<slug>.yml` from the in-memory definition and land it on the
 * mirror's main before returning. Does not touch Mongo: the caller stamps
 * `sourceBlobSha` and saves after, and only when `ok` — so a commit that did
 * not land never leaves a row that only the database knows about.
 *
 * "Unchanged" is judged against the file at main, never against the row's
 * `sourceBlobSha`: a row stamped by a commit that was later parked as
 * diverged still carries that commit's blob, and trusting it skipped the
 * write while main kept the old definition.
 *
 * The write is conditional (optimistic concurrency) on `expectBlobAtMain`,
 * which defaults to the row's `sourceBlobSha`: when the file at main is
 * neither that blob nor already this definition (in any format), nothing is
 * written and the result is a conflict.
 */
export async function commitFlowFile(
  flow: IFlow,
  actorUserId?: string,
  messageOverride?: string,
  options: { expectBlobAtMain?: string | null } = {},
): Promise<FlowFileWriteResult> {
  if (!flow.slug || !flow.name?.trim()) {
    return { ok: true, changed: false };
  }
  const slug = flow.slug;
  const file = flowToFile(flow);
  const contents = serializeFlowFile(file);
  const sha = blobOid(contents);
  const filePath = flowFilePath(slug);
  // Without an expectation from the caller, the row's own blob is it: a row
  // derived from an older file must not write that file over a newer one at
  // main (a merged PR the row has not followed yet). A row with no blob (a
  // new flow) writes unconditionally.
  const expectBlobAtMain =
    options.expectBlobAtMain !== undefined
      ? options.expectBlobAtMain
      : flow.sourceBlobSha || undefined;
  let blobAtMain = sha;
  try {
    const committed = await commitConfigToMain(
      flow.workspaceId.toString(),
      async ({ repoDir, head }) => {
        const current = await blobIdAt(repoDir, head, filePath);
        if (current === sha) return null;
        // The file on main may say the same thing in the older words
        // (format 1: `type`, `schedule`, `webhook`, `backfill_schedule`),
        // or with other comments. Then only the format differs: leave it,
        // so a save never rewrites a file for its format alone. It moves to
        // format 2 the first time its meaning changes.
        if (current) {
          if (current === blobOid(serializeFlowFileV1(file))) {
            blobAtMain = current;
            return null;
          }
          const atMain = await readBlob(repoDir, head, filePath).catch(
            () => null,
          );
          const parsed =
            atMain && !atMain.isBinary ? parseFlowFile(atMain.contents) : null;
          if (parsed && sameFlowMeaning(parsed, file)) {
            blobAtMain = current;
            return null;
          }
        }
        if (expectBlobAtMain !== undefined && current !== expectBlobAtMain) {
          throw new FlowFileConflictError(
            `${filePath} changed on main (${head.slice(0, 9)}) since this flow was read: expected blob ${expectBlobAtMain?.slice(0, 9) ?? "none"}, found ${current?.slice(0, 9) ?? "none"}`,
          );
        }
        blobAtMain = sha;
        return { writes: { [filePath]: contents } };
      },
      messageOverride ?? `flow: "${flow.name ?? slug}" (${slug})`,
      actorUserId ? await authorForUser(actorUserId) : undefined,
    );
    return {
      ok: true,
      changed: committed.changed,
      sourceBlobSha: blobAtMain,
      commitSha: committed.commitOid,
    };
  } catch (error) {
    if (error instanceof RepoRequiredError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Flow config write-through failed", {
      workspaceId: flow.workspaceId.toString(),
      slug,
      error: message,
    });
    return {
      ok: false,
      changed: false,
      error: message,
      ...(error instanceof FlowFileConflictError ? { conflict: true } : {}),
    };
  }
}

/** How a flow row compares with its `flows/<slug>.yml` on main. */
export interface FlowDefinitionDrift {
  /** The commit read (this instance's cache of main); null without a repo. */
  commit: string | null;
  /** True when the row means what the file at main says. */
  inSync: boolean;
  /** Blob of the file at main; null when the file is missing. */
  blobAtMain: string | null;
  /** The blob the row says it was derived from. */
  rowSourceBlob: string | null;
  /** Top-level definition keys whose values differ (row vs file). */
  differs: string[];
  /** Why the row is not in sync, in words; absent when it is. */
  reason?: string;
  /** Why nothing was compared (no bound repo, no main). */
  skippedReason?: string;
}

/**
 * Compare a row's definition with the file at main, read-only (no freshen,
 * no write). A row changed in the database whose file commit never landed —
 * the next push to main would revert it — shows here as `inSync: false`
 * with the keys that differ.
 */
export async function flowDefinitionDrift(
  flow: IFlow,
): Promise<FlowDefinitionDrift> {
  const rowSourceBlob = flow.sourceBlobSha ?? null;
  const none = {
    commit: null,
    inSync: true,
    blobAtMain: null,
    rowSourceBlob,
    differs: [],
  };
  if (!flow.slug) return none;
  const repoDir = await boundRepoDirIfExists(flow.workspaceId.toString());
  if (!repoDir) {
    // Read-only: no bound repo means no file to compare with.
    return { ...none, skippedReason: "no connected repo" };
  }
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!head) return { ...none, skippedReason: `no ${DEFAULT_BRANCH} branch` };
  const filePath = flowFilePath(flow.slug);
  const blobAtMain = await blobIdAt(repoDir, head, filePath);
  if (!blobAtMain) {
    return {
      commit: head,
      inSync: false,
      blobAtMain,
      rowSourceBlob,
      differs: [],
      reason: `${filePath} is missing at main`,
    };
  }
  const atMain = await readBlob(repoDir, head, filePath).catch(() => null);
  const parsed =
    atMain && !atMain.isBinary ? parseFlowFile(atMain.contents) : null;
  if (!parsed) {
    return {
      commit: head,
      inSync: false,
      blobAtMain,
      rowSourceBlob,
      differs: [],
      reason: `${filePath} at main does not parse`,
    };
  }
  // Round-trip the row's definition through the file format, so both sides
  // carry the parser's defaults and empty-field rules.
  const rowFile = flowToFile(flow);
  const fromRow = parseFlowFile(serializeFlowFile(rowFile)) ?? rowFile;
  if (sameFlowMeaning(parsed, fromRow)) {
    return {
      commit: head,
      inSync: true,
      blobAtMain,
      rowSourceBlob,
      differs: [],
    };
  }
  // The same normalisation as sameFlowMeaning, so `differs` never names a
  // key whose only difference is how it was stored (layout _id, sync.engine).
  const a = flowMeaning(parsed);
  const b = flowMeaning(fromRow);
  const differs = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort();
  return {
    commit: head,
    inSync: false,
    blobAtMain,
    rowSourceBlob,
    differs,
    reason:
      rowSourceBlob === blobAtMain
        ? "the database row changed without a commit to main; the next push to main reverts it"
        : "the file at main changed and the row has not followed yet (or the row changed without a commit)",
  };
}

/** Remove a deleted flow's file. Throws {@link RepoRequiredError} without a repo. */
export async function deleteFlowFile(
  flow: Pick<IFlow, "workspaceId" | "slug" | "name">,
  actorUserId?: string,
): Promise<void> {
  if (!flow.slug) return;
  await commitConfigToMain(
    flow.workspaceId.toString(),
    { deletes: [flowFilePath(flow.slug)] },
    `flow: delete "${flow.name ?? flow.slug}" (${flow.slug})`,
    actorUserId ? await authorForUser(actorUserId) : undefined,
  );
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
  const shaBySlug = new Map<string, { id: Types.ObjectId; sha: string }>();
  const failed: Array<{ slug: string; error: string }> = [];
  let skipped = 0;

  for (const flow of flows as unknown as IFlow[]) {
    if (!flow.slug || !flow.name?.trim()) {
      skipped++;
      continue;
    }
    try {
      const file = flowToFile(flow);
      const contents = serializeFlowFile(file);
      // Same meaning already on main, in either format: nothing to write.
      if (
        flow.sourceBlobSha &&
        (flow.sourceBlobSha === blobOid(contents) ||
          flow.sourceBlobSha === blobOid(serializeFlowFileV1(file)))
      ) {
        skipped++;
        continue;
      }
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
      await commitConfigToMain(
        workspaceId,
        { writes },
        `flows: export ${Object.keys(writes).length} definition(s)`,
        actorUserId ? await authorForUser(actorUserId) : undefined,
      );
      commitMade = true;
      for (const { id, sha } of shaBySlug.values()) {
        await Flow.updateOne({ _id: id }, { $set: { sourceBlobSha: sha } });
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
