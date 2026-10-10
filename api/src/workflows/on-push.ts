/**
 * Deploy a workspace's workflows when its repo moves
 * (docs/src/content/docs/workflows.md).
 *
 * A deploy is one write: the commit and tree of `workflows/` at `main`, saved
 * as the workspace's target; another branch is saved as its preview. The
 * worker asks for both and switches to what builds. Before the first deploy
 * this also gives the workspace its Hatchet token and its worker.
 */
import { Types } from "mongoose";

import { WORKFLOWS_DIR } from "../apps/app-paths";
import { ensureLocalRepo } from "../apps/cloud-repo.service";
import { runGit } from "../apps/git";
import {
  DEFAULT_BRANCH,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "../apps/repository.service";
import { generateApiKey, hashApiKey } from "../auth/api-key.middleware";
import type { WorkspaceApiKeyScope } from "../auth/api-key-scopes";
import { AppWorktree, Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import { ensureWorkspaceTenant } from "./hatchet";
import {
  createWorkerSecret,
  ensureWorkerDeployment,
  isGkeWorkerConfigured,
  workerSecretExists,
} from "./kube";

const logger = loggers.api("workflows-on-push");

const WORKER_KEY_NAME = "Workflows worker";
const WORKER_KEY_SCOPES: WorkspaceApiKeyScope[] = [
  "mcp",
  "query:read",
  "workflows:runtime",
];

/** The tree id of `workflows/` at a commit, or null when it has none. */
async function workflowsTree(
  repoDir: string,
  commit: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit([
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      "--quiet",
      `${commit}:${WORKFLOWS_DIR}`,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Make `key` the workspace's worker key, replacing any earlier one. */
async function setWorkerKey(
  workspaceId: string,
  userId: string,
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
  // The scope is the worker's alone, so it finds the key being replaced.
  await Workspace.updateOne(
    { _id },
    { $pull: { apiKeys: { scopes: "workflows:runtime" } } },
  );
  await Workspace.updateOne(
    { _id },
    {
      $push: {
        apiKeys: {
          _id: new Types.ObjectId(),
          name: WORKER_KEY_NAME,
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
    await setWorkerKey(workspaceId, userId, key);
    return;
  }
  // The key can be read only when it is created, so a missing Secret means a
  // new key, written to Kubernetes in the same step.
  if (!(await workerSecretExists(workspaceId))) {
    const { key } = generateApiKey();
    await setWorkerKey(workspaceId, userId, key);
    await createWorkerSecret(workspaceId, key);
  }
  await ensureWorkerDeployment(workspaceId);
}

type Commit = { sha: string; tree: string };

/** `workflows/` on a branch, or null when the branch or the folder is missing. */
async function workflowsAt(
  repoDir: string,
  branch: string,
): Promise<Commit | null> {
  const sha = await resolveCommit(repoDir, `refs/heads/${branch}`);
  const tree = sha ? await workflowsTree(repoDir, sha) : null;
  return sha && tree ? { sha, tree } : null;
}

const deploys = new Map<string, Promise<void>>();

/**
 * Point the worker at `workflows/` on `main`, and at the pusher's branch. One
 * at a time per workspace, in order: a push that lands during a deploy is
 * deployed after it, not dropped.
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
  const state = workspace?.workflows;
  if (!workspace || !state?.enabled) return;
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return;
  const main = await workflowsAt(repoDir, DEFAULT_BRANCH);

  // The pusher's branch is the workspace's one preview: the last branch
  // pushed with workflow changes wins. Once it matches main (merged, or
  // reverted) there is nothing left to preview.
  const worktree = userId
    ? await AppWorktree.findOne({ workspaceId: workspace._id, userId })
        .select("branch")
        .lean()
    : null;
  // Without a pusher (a merge), look again at the branch already previewed.
  const branch = worktree?.branch ?? state.preview?.branch;
  const pushed =
    branch && branch !== DEFAULT_BRANCH
      ? await workflowsAt(repoDir, branch)
      : null;
  const preview = pushed && pushed.tree !== main?.tree ? pushed : null;

  if (main || preview) {
    await ensureWorkspaceTenant(workspaceId);
    await ensureWorker(workspaceId, userId ?? workspace.createdBy);
  }

  // A slot follows what the repository holds: gone from the repository
  // (`workflows/` deleted on main, a preview merged) is gone from the worker.
  const set: Record<string, unknown> = {};
  const unset: Record<string, ""> = {};
  if (main && state.target?.tree !== main.tree) set["workflows.target"] = main;
  if (!main && state.target) unset["workflows.target"] = "";
  if (preview && branch && state.preview?.tree !== preview.tree) {
    set["workflows.preview"] = { branch, ...preview };
  } else if (!preview && branch && state.preview?.branch === branch) {
    unset["workflows.preview"] = "";
  }
  if (Object.keys(set).length + Object.keys(unset).length === 0) return;
  await Workspace.updateOne(
    { _id: workspace._id },
    {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
  );
  logger.info("Set workflows target", { workspaceId, ...set, unset });
}
