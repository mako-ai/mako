/**
 * Flow definitions mirrored into the workspace repo (RFC #904, block 2).
 *
 * **Direction, for now: Mongo → git only.** The rows stay authoritative;
 * every in-product mutation writes its `flows/<slug>.yml` through here so
 * the files can be verified against real flows before anything depends on
 * them. Block 3 adds the push reactor and flips authority — including the
 * CDC pause/reconfigure/resume that a stream-shaped resource needs and a
 * dbt job does not.
 *
 * Structure mirrors `dbt/dbt-config.service.ts` deliberately: same commit
 * primitives, same "no repo, no write-through" tolerance, same
 * `sourceBlobSha` short-circuit so an unchanged definition makes no commit.
 */
import { loggers } from "../logging";
import { authorForUser } from "../apps/workspace-consoles.service";
import {
  connectedTierEnabled,
  ensureLocalRepo,
  freshenBeforeMainWrite,
  resolveMirrorTarget,
  mirrorPushNow,
  queueMirrorPush,
} from "../apps/cloud-repo.service";
import {
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  repoDirFor,
  repoExists,
  resolveCommit,
  type GitAuthor,
} from "../apps/repository.service";
import { Flow, type IFlow } from "../database/workspace-schema";
import {
  flowFilePath,
  flowToFile,
  serializeFlowFile,
} from "./flow-config-files";

const logger = loggers.api("flow-config");

/**
 * The workspace repo, at a tip that agrees with the mirror.
 *
 * Freshening lives at this choke point rather than beside the commit, for the
 * same reason it does in dbt-config.service: `ensureLocalRepo` returns early
 * once the directory exists and never refreshes it, and any caller that READS
 * the tree to decide what to write has already made its decision by the time
 * a commit-time freshen runs. Kept identical to the dbt module deliberately —
 * these two are the same shape and drifted apart once already (#916).
 */
async function repoDirIfExists(workspaceId: string): Promise<string | null> {
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return null;
  await freshenBeforeMainWrite(workspaceId);
  return repoDir;
}

async function commitConfig(
  workspaceId: string,
  mutation: { writes?: Record<string, string>; deletes?: string[] },
  message: string,
  author?: GitAuthor,
): Promise<void> {
  // Freshened by repoDirIfExists (#916, moved up to the choke point).
  const repoDir = await repoDirIfExists(workspaceId);
  // No repo: Mongo remains the only home. Block 3 makes a repo required at
  // the route boundary; while this is export-only, a workspace without one
  // simply gets no files.
  if (!repoDir) return;
  const result = await commitBlobsOnBranch(repoDir, DEFAULT_BRANCH, mutation, {
    message,
    author,
  });
  if (!result.unchanged) queueMirrorPush(workspaceId);
}

/** Write-through: the flow's file mirrors the row's definition fields. */
export interface FlowFileWriteResult {
  ok: boolean;
  /** True when a commit was actually made (an unchanged definition is a no-op). */
  changed: boolean;
  error?: string;
}

export async function commitFlowFile(
  flow: IFlow,
  actorUserId?: string,
  messageOverride?: string,
): Promise<FlowFileWriteResult> {
  // Pre-backfill rows have neither; the migration stamps both. Skipping on
  // an empty NAME as well as an empty slug keeps serialize/parse symmetric:
  // `parseFlowFile` rejects a file with no name, so writing one would
  // produce a file the reader refuses — harmless while Mongo is
  // authoritative, a real hazard once block 3 makes files authoritative.
  // (Caught by running the projection against production rows before their
  // backfill had deployed.)
  if (!flow.slug || !flow.name?.trim()) {
    return { ok: true, changed: false };
  }
  try {
    const contents = serializeFlowFile(flowToFile(flow));
    const sha = blobOid(contents);
    // Unchanged definition: no commit, no push, no churn.
    if (flow.sourceBlobSha === sha) return { ok: true, changed: false };
    await commitConfig(
      flow.workspaceId.toString(),
      { writes: { [flowFilePath(flow.slug)]: contents } },
      messageOverride ?? `flow: "${flow.name ?? flow.slug}" (${flow.slug})`,
      actorUserId ? await authorForUser(actorUserId) : undefined,
    );
    await Flow.updateOne({ _id: flow._id }, { $set: { sourceBlobSha: sha } });
    return { ok: true, changed: true };
  } catch (error) {
    // Export-only: a failed mirror must never fail the user's mutation.
    // Mongo is authoritative and the next write (or the backfill CLI)
    // re-syncs the file.
    const message = error instanceof Error ? error.message : String(error);
    // The user's mutation still succeeds — Mongo is authoritative — but the
    // failure is RETURNED as well as logged. Swallowing it silently is how
    // 21 of 31 production flows failed to export while the CLI reported
    // success.
    logger.warn("Flow config write-through failed", {
      workspaceId: flow.workspaceId.toString(),
      slug: flow.slug,
      error: message,
    });
    return { ok: false, changed: false, error: message };
  }
}

/** Remove a deleted flow's file. */
export async function deleteFlowFile(
  flow: Pick<IFlow, "workspaceId" | "slug" | "name">,
  actorUserId?: string,
): Promise<void> {
  if (!flow.slug) return;
  try {
    await commitConfig(
      flow.workspaceId.toString(),
      { deletes: [flowFilePath(flow.slug)] },
      `flow: delete "${flow.name ?? flow.slug}" (${flow.slug})`,
      actorUserId ? await authorForUser(actorUserId) : undefined,
    );
  } catch (error) {
    logger.warn("Flow config delete write-through failed", {
      workspaceId: flow.workspaceId.toString(),
      slug: flow.slug,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Mirror every flow in a workspace. Used by the one-time export and
 * available to an operator when a repo was connected after the fact.
 */
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
  const repoDir = await repoDirIfExists(workspaceId);
  if (!repoDir) {
    return { ok: false, reason: "no local repo after ensureLocalRepo" };
  }
  // repoDirIfExists has freshened, so main must now BE the mirror's main.
  const mainOid = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!mainOid) {
    return {
      ok: false,
      reason: `local ${DEFAULT_BRANCH} is missing after freshen — the local repo is not a clone of ${target.owner}/${target.repo}`,
    };
  }
  return { ok: true, mainOid };
}

export async function exportWorkspaceFlows(
  workspaceId: string,
  actorUserId?: string,
): Promise<{
  written: number;
  skipped: number;
  failed: Array<{ slug: string; error: string }>;
  commitMade: boolean;
}> {
  // Refuse to run at all when the mirror is unreachable from here, rather
  // than committing into a local-only repo and reporting success.
  const reachable = await assertMirrorReachable(workspaceId);
  if (!reachable.ok) {
    return {
      written: 0,
      skipped: 0,
      failed: [{ slug: "(workspace)", error: reachable.reason }],
      commitMade: false,
    };
  }

  // `.lean()` matters: a live document's DocumentArrays are circular and
  // overflow the YAML dumper (see `plain()` in flow-config-files).
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

  // One commit for the whole backfill rather than one per flow: a readable
  // history, and a single push to await.
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
        await Flow.updateOne({ _id: id }, { $set: { sourceBlobSha: sha } });
      }
      // `queueMirrorPush` is fire-and-forget; a CLI that exits immediately
      // kills the push in flight, which is how a "successful" export landed
      // nothing on GitHub. Await the flush.
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
