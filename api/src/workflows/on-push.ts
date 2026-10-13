/**
 * Deploy a workspace's workflows when its repo moves
 * (docs/src/content/docs/workflows.md).
 *
 * A deploy is one write: the commit and tree of `workflows/` at `main`, saved
 * as the workspace's target. The worker asks for it and switches to it when
 * it builds. Before the first deploy this also gives the workspace its
 * Hatchet token and its worker.
 */
import { Types } from "mongoose";

import { WORKFLOWS_DIR } from "../apps/app-paths";
import { ensureLocalRepo, freshenForServe } from "../apps/cloud-repo.service";
import { runGit } from "../apps/git";
import {
  DEFAULT_BRANCH,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "../apps/repository.service";
import { generateApiKey, hashApiKey } from "../auth/api-key.middleware";
import type { WorkspaceApiKeyScope } from "../auth/api-key-scopes";
import { Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  ensureWorkspaceTenant,
  hasInstanceHatchet,
  workflowsNamePrefix,
} from "./hatchet";
import {
  ensureWorkerDeployment,
  isGkeWorkerConfigured,
  workerSecretExists,
  writeWorkerSecret,
} from "./kube";

const logger = loggers.api("workflows-on-push");

/** One key per environment that runs a worker: previews share a database. */
const workerKeyName = () => `Workflows worker ${workflowsNamePrefix()}`.trim();
const WORKER_KEY_SCOPES: WorkspaceApiKeyScope[] = [
  "mcp",
  "query:read",
  "workflows:runtime",
];

/** The object id at `spec` (a commit's `workflows/` by default), or null. */
async function workflowsTree(
  repoDir: string,
  spec: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit([
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      "--quiet",
      spec.includes(":") ? spec : `${spec}:${WORKFLOWS_DIR}`,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Give the workspace the runtime key `name`, replacing an earlier one of that
 * name. The key acts as `userId`: the worker's as who deployed, a sandbox
 * run's as the person testing (sandbox.ts).
 */
export async function setKey(
  workspaceId: string,
  userId: string,
  name: string,
  key: string,
): Promise<void> {
  const _id = new Types.ObjectId(workspaceId);
  const keyHash = hashApiKey(key);
  const holder = await Workspace.findOne({ "apiKeys.keyHash": keyHash })
    .select("_id")
    .lean();
  if (holder) {
    if (holder._id.equals(_id)) return;
    throw new Error(
      "WORKFLOWS_WORKER_KEY already belongs to another workspace. A static worker serves one workspace.",
    );
  }
  await Workspace.updateOne({ _id }, { $pull: { apiKeys: { name } } });
  await Workspace.updateOne(
    { _id },
    {
      $push: {
        apiKeys: {
          _id: new Types.ObjectId(),
          name,
          keyHash,
          prefix: key.substring(0, 14),
          scopes: WORKER_KEY_SCOPES,
          createdAt: new Date(),
          createdBy: userId,
        },
      },
    },
  );
}

/**
 * Make sure the workspace's worker can sign in to Mako, and exists. Where
 * this API can create pods (`gke`) it makes one per workspace; elsewhere the
 * operator runs the runtime image with WORKFLOWS_WORKER_KEY (`static`).
 */
async function ensureWorker(
  workspaceId: string,
  userId: string,
): Promise<void> {
  if (!isGkeWorkerConfigured()) {
    const key = process.env.WORKFLOWS_WORKER_KEY;
    if (!key?.startsWith("revops_")) {
      logger.warn(
        "Set WORKFLOWS_WORKER_KEY (revops_...) and start the worker with it",
        { workspaceId },
      );
      return;
    }
    await setKey(workspaceId, userId, workerKeyName(), key);
    return;
  }
  // The key can be read only when it is created, and it lives in two places:
  // this environment's key on the workspace, and the pod's Secret. Either
  // missing (a first deploy, a database restored from before the worker, a
  // new cluster) means a new key written to both, replacing what the pod held.
  const workspace = await Workspace.findById(workspaceId)
    .select("apiKeys.name")
    .lean();
  const hasKey = workspace?.apiKeys?.some(k => k.name === workerKeyName());
  const rotate = !hasKey || !(await workerSecretExists(workspaceId));
  if (rotate) {
    const { key } = generateApiKey();
    await setKey(workspaceId, userId, workerKeyName(), key);
    await writeWorkerSecret(workspaceId, key);
  }
  await ensureWorkerDeployment(workspaceId, rotate);
}

type Commit = { sha: string; tree: string; names: string[] };

/** `workflows/` on a branch, or null when the branch or the folder is missing. */
async function workflowsAt(
  repoDir: string,
  branch: string,
): Promise<Commit | null> {
  const sha = await resolveCommit(repoDir, `refs/heads/${branch}`);
  const tree = sha ? await workflowsTree(repoDir, sha) : null;
  if (!sha || !tree) return null;
  // A workflow is a folder holding workflow.ts, as worker.mjs reads it.
  const { stdout } = await runGit([
    ...["-C", repoDir, "ls-tree", "--name-only", tree],
  ]);
  const names: string[] = [];
  for (const name of stdout.split("\n").filter(Boolean)) {
    const file = await workflowsTree(
      repoDir,
      `${sha}:${WORKFLOWS_DIR}/${name}/workflow.ts`,
    );
    if (file) names.push(name);
  }
  return { sha, tree, names };
}

/**
 * Whether a move of main can change what is deployed: main holds
 * `workflows/`, or something is deployed that main may have dropped. Read
 * from this instance's repository, which the push just wrote. Most
 * workspaces have no workflows, and their pushes ask for no deploy.
 */
export async function hasWorkflowsToDeploy(
  workspaceId: string,
): Promise<boolean> {
  const onMain = await workflowsTree(
    repoDirFor(workspaceId),
    `refs/heads/${DEFAULT_BRANCH}`,
  );
  if (onMain) return true;
  const deployed = await Workspace.exists({
    _id: workspaceId,
    "workflows.live": { $exists: true },
  });
  return Boolean(deployed);
}

const deploys = new Map<string, Promise<void>>();

/**
 * Point the worker at `workflows/` on `main`. One at a time per workspace, in
 * order: a push that lands during a deploy is deployed after it, not dropped.
 */
export function deployWorkflowsFromRepo(
  workspaceId: string,
  userId?: string,
): Promise<void> {
  const run = (deploys.get(workspaceId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => deployWorkflowsNow(workspaceId, userId))
    .finally(() => {
      if (deploys.get(workspaceId) === run) deploys.delete(workspaceId);
    });
  deploys.set(workspaceId, run);
  return run;
}

async function deployWorkflowsNow(
  workspaceId: string,
  userId?: string,
): Promise<void> {
  const workspace = await Workspace.findById(workspaceId)
    .select("workflows createdBy")
    .lean();
  // Nothing to deploy to without a Hatchet: Mako runs without workflows.
  const state = workspace?.workflows ?? {};
  if (!workspace || !(state.hatchetToken || hasInstanceHatchet())) return;
  // The deploy runs on whichever instance Inngest calls: read the mirror's
  // main, not this instance's last copy of it.
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return;
  await freshenForServe(workspaceId, 0);
  const main = await workflowsAt(repoDir, DEFAULT_BRANCH);
  if (main) {
    await ensureWorkspaceTenant(workspaceId);
    await ensureWorker(workspaceId, userId ?? workspace.createdBy);
  }

  // The slot follows what the repository holds: `workflows/` deleted on main
  // is gone from the worker. The commit changes under the slot; what the
  // worker reported for the old one stays until it reports again, so the
  // screen shows old-live, new-wanted.
  if (main && state.live?.tree !== main.tree) {
    await Workspace.updateOne(
      { _id: workspace._id },
      {
        $set: {
          "workflows.live.sha": main.sha,
          "workflows.live.tree": main.tree,
          "workflows.live.names": main.names,
        },
      },
    );
    logger.info("Set workflows target", { workspaceId, sha: main.sha });
  } else if (!main && state.live) {
    await Workspace.updateOne(
      { _id: workspace._id },
      { $unset: { "workflows.live": "" } },
    );
    logger.info("Unset workflows target", { workspaceId });
  }
}
