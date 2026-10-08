/**
 * Deploy a workspace's workflows when `main` moves (rfcs/workflows-as-code.md).
 *
 * Called from `syncRepoBackedResources`, so it runs for a push through Mako's
 * git endpoint and for a push made directly on GitHub. Like the other entries
 * there it is an idempotent reconcile: it compares the `workflows/` tree at
 * `main` with the tree at the deployed commit and does nothing when they are
 * the same, so a push that touches only apps or dbt never restarts the worker.
 *
 * The first deploy for a workspace also creates its Hatchet tenant, the
 * worker's Mako API key and the Kubernetes Secret holding both credentials.
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
import { generateApiKey } from "../auth/api-key.middleware";
import type { WorkspaceApiKeyScope } from "../auth/api-key-scopes";
import { Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";
import { ensureWorkspaceTenant, isHatchetConfigured } from "./hatchet";
import {
  deployWorker,
  isWorkflowsKubeConfigured,
  readTargetSha,
  workerSecretExists,
  createWorkerSecret,
} from "./kube";

const logger = loggers.api("workflows-on-push");

export const WORKFLOWS_DIR = "workflows";
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

/**
 * Make sure the worker's Secret exists. The Mako API key can be read only
 * when it is created, so a missing Secret means a new key: the old one is
 * removed and the new one written to Kubernetes in the same step.
 */
async function ensureWorkerCredentials(
  workspaceId: string,
  hatchetToken: string,
  userId: string,
): Promise<void> {
  if (await workerSecretExists(workspaceId)) return;

  const _id = new Types.ObjectId(workspaceId);
  const { key, hash, prefix } = generateApiKey();
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
          keyHash: hash,
          prefix,
          scopes: WORKER_KEY_SCOPES,
          createdAt: new Date(),
          createdBy: userId,
        },
      },
      $set: { "workflows.workerApiKeyId": keyId },
    },
  );
  await createWorkerSecret(workspaceId, { hatchetToken, makoApiKey: key });
}

export type WorkflowsDeployResult =
  | { deployed: true; sha: string }
  | { deployed: false; reason: string };

const deployInFlight = new Map<string, Promise<WorkflowsDeployResult>>();

/** Deploy `workflows/` at `main` if it differs from what is deployed. */
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

  if (!isHatchetConfigured() || !isWorkflowsKubeConfigured()) {
    // Local development: run the worker by hand (deploy/workflows/README.md).
    logger.info("Workflows changed but this instance cannot deploy workers", {
      workspaceId,
      head,
    });
    return { deployed: false, reason: "Worker deploys are not configured" };
  }

  const deployedSha = await readTargetSha(workspaceId);
  if (deployedSha && (await workflowsTree(repoDir, deployedSha)) === tree) {
    return { deployed: false, reason: "workflows/ is unchanged" };
  }

  const tenant = await ensureWorkspaceTenant(workspaceId);
  await ensureWorkerCredentials(
    workspaceId,
    tenant.token,
    userId ?? workspace.createdBy,
  );
  await deployWorker(workspaceId, head);
  return { deployed: true, sha: head };
}
