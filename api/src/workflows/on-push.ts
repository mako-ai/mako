/**
 * Deploy a workspace's workflows when `main` moves (rfcs/workflows-as-code.md).
 *
 * Called from `syncRepoBackedResources`, so it runs for a push through Mako's
 * git endpoint and for a push made directly on GitHub. A deploy is one write:
 * the commit and tree of `workflows/` at `main`, saved as the workspace's
 * target. The worker asks Mako for its target, typechecks it and switches to
 * it, so a push that touches only apps or dbt changes nothing, and a commit
 * that does not build never replaces the running code.
 *
 * Before the first deploy this also makes sure the workspace has a Hatchet
 * token and a worker: its Mako API key, and under the `gke` provider its pod.
 */
import { Types } from "mongoose";

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
import { Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import { ensureWorkspaceTenant } from "./hatchet";
import {
  createWorkerSecret,
  ensureWorkerDeployment,
  isGkeWorkerConfigured,
  workerSecretExists,
} from "./kube";

const logger = loggers.api("workflows-on-push");

export const WORKFLOWS_DIR = "workflows";
const WORKER_KEY_NAME = "Workflows worker";
const WORKER_KEY_SCOPES: WorkspaceApiKeyScope[] = [
  "mcp",
  "query:read",
  "workflows:runtime",
];

/**
 * Who runs the worker. `gke`: Mako creates a sandboxed pod per workspace.
 * `static`: the operator runs the runtime image themselves (docker-compose,
 * or anywhere) with WORKFLOWS_WORKER_KEY, and Mako creates nothing.
 */
export function workerProvider(): "gke" | "static" {
  const explicit = process.env.WORKFLOWS_WORKER_PROVIDER;
  if (explicit === "gke" || explicit === "static") return explicit;
  return isGkeWorkerConfigured() ? "gke" : "static";
}

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
  const keyId = new Types.ObjectId();
  const workspace = await Workspace.findById(_id).select("workflows").lean();
  const previous = workspace?.workflows?.workerApiKeyId;
  if (previous) {
    await Workspace.updateOne(
      { _id },
      { $pull: { apiKeys: { _id: previous } } },
    );
  }
  await Workspace.updateOne(
    { _id },
    {
      $push: {
        apiKeys: {
          _id: keyId,
          name: WORKER_KEY_NAME,
          keyHash,
          prefix: key.substring(0, 14),
          scopes: WORKER_KEY_SCOPES,
          createdAt: new Date(),
          createdBy: userId,
        },
      },
      $set: { "workflows.workerApiKeyId": keyId },
    },
  );
}

/** Make sure the workspace's worker can sign in to Mako, and exists. */
async function ensureWorker(
  workspaceId: string,
  userId: string,
): Promise<void> {
  if (workerProvider() === "static") {
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

export type WorkflowsDeployResult =
  | { deployed: true; sha: string }
  | { deployed: false; reason: string };

const deployInFlight = new Map<string, Promise<WorkflowsDeployResult>>();

/** Point the worker at `workflows/` on `main` if it changed. */
export function deployWorkflowsFromRepo(
  workspaceId: string,
  userId?: string,
): Promise<WorkflowsDeployResult> {
  const running = deployInFlight.get(workspaceId);
  if (running) return running;
  const run = deployWorkflowsNow(workspaceId, userId).finally(() => {
    deployInFlight.delete(workspaceId);
  });
  deployInFlight.set(workspaceId, run);
  return run;
}

async function deployWorkflowsNow(
  workspaceId: string,
  userId?: string,
): Promise<WorkflowsDeployResult> {
  const workspace = await Workspace.findById(workspaceId)
    .select("workflows createdBy")
    .lean();
  if (!workspace?.workflows?.enabled) {
    return { deployed: false, reason: "Workflows are not enabled" };
  }
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) {
    return { deployed: false, reason: "The workspace has no repository" };
  }
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!head) return { deployed: false, reason: "main has no commits" };
  const tree = await workflowsTree(repoDir, head);
  if (!tree) {
    return { deployed: false, reason: "main has no workflows/ folder" };
  }

  await ensureWorkspaceTenant(workspaceId);
  await ensureWorker(workspaceId, userId ?? workspace.createdBy);
  if (workspace.workflows.target?.tree === tree) {
    return { deployed: false, reason: "workflows/ is unchanged" };
  }
  await Workspace.updateOne(
    { _id: workspace._id },
    { $set: { "workflows.target": { sha: head, tree } } },
  );
  logger.info("Set workflows target", { workspaceId, sha: head });
  return { deployed: true, sha: head };
}
