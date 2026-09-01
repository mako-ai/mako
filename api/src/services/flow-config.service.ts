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
  ensureLocalRepo,
  freshenBeforeMainWrite,
  queueMirrorPush,
} from "../apps/cloud-repo.service";
import {
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  repoDirFor,
  repoExists,
  type GitAuthor,
} from "../apps/repository.service";
import { Flow, type IFlow } from "../database/workspace-schema";
import {
  flowFilePath,
  flowToFile,
  serializeFlowFile,
} from "./flow-config-files";

const logger = loggers.api("flow-config");

async function repoDirIfExists(workspaceId: string): Promise<string | null> {
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  return (await repoExists(repoDir)) ? repoDir : null;
}

async function commitConfig(
  workspaceId: string,
  mutation: { writes?: Record<string, string>; deletes?: string[] },
  message: string,
  author?: GitAuthor,
): Promise<void> {
  const repoDir = await repoDirIfExists(workspaceId);
  // No repo: Mongo remains the only home. Block 3 makes a repo required at
  // the route boundary; while this is export-only, a workspace without one
  // simply gets no files.
  if (!repoDir) return;
  // Config-as-code commits land on main, so they must be judged against the
  // mirror's main, not this instance's cache. Without this a stale instance
  // commits onto an old tip and pushes it — the divergence class #897 fixed
  // for skills and worktree writes, which these two write paths never
  // adopted. Coalesced and non-blocking on failure.
  await freshenBeforeMainWrite(workspaceId);
  const result = await commitBlobsOnBranch(repoDir, DEFAULT_BRANCH, mutation, {
    message,
    author,
  });
  if (!result.unchanged) queueMirrorPush(workspaceId);
}

/** Write-through: the flow's file mirrors the row's definition fields. */
export async function commitFlowFile(
  flow: IFlow,
  actorUserId?: string,
  messageOverride?: string,
): Promise<void> {
  // Pre-backfill rows have neither; the migration stamps both. Skipping on
  // an empty NAME as well as an empty slug keeps serialize/parse symmetric:
  // `parseFlowFile` rejects a file with no name, so writing one would
  // produce a file the reader refuses — harmless while Mongo is
  // authoritative, a real hazard once block 3 makes files authoritative.
  // (Caught by running the projection against production rows before their
  // backfill had deployed.)
  if (!flow.slug || !flow.name?.trim()) return;
  try {
    const contents = serializeFlowFile(flowToFile(flow));
    const sha = blobOid(contents);
    // Unchanged definition: no commit, no push, no churn.
    if (flow.sourceBlobSha === sha) return;
    await commitConfig(
      flow.workspaceId.toString(),
      { writes: { [flowFilePath(flow.slug)]: contents } },
      messageOverride ?? `flow: "${flow.name ?? flow.slug}" (${flow.slug})`,
      actorUserId ? await authorForUser(actorUserId) : undefined,
    );
    await Flow.updateOne({ _id: flow._id }, { $set: { sourceBlobSha: sha } });
  } catch (error) {
    // Export-only: a failed mirror must never fail the user's mutation.
    // Mongo is authoritative and the next write (or the backfill CLI)
    // re-syncs the file.
    logger.warn("Flow config write-through failed", {
      workspaceId: flow.workspaceId.toString(),
      slug: flow.slug,
      error: error instanceof Error ? error.message : String(error),
    });
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
export async function exportWorkspaceFlows(
  workspaceId: string,
  actorUserId?: string,
): Promise<{ written: number; skipped: number }> {
  const flows = await Flow.find({ workspaceId }).sort({ _id: 1 });
  let written = 0;
  let skipped = 0;
  for (const flow of flows) {
    if (!flow.slug) {
      skipped++;
      continue;
    }
    const before = flow.sourceBlobSha;
    await commitFlowFile(flow, actorUserId, `flow: export "${flow.slug}"`);
    const after = await Flow.findById(flow._id).select("sourceBlobSha").lean();
    if (after?.sourceBlobSha && after.sourceBlobSha !== before) written++;
  }
  return { written, skipped };
}
