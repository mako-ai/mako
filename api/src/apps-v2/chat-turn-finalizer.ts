import { createHash, randomUUID } from "node:crypto";
import { Types } from "mongoose";
import {
  AppV2Session,
  type IAppV2ChatTurn,
  type IAppV2ChatTurnProject,
  type IAppV2Project,
  type IAppV2Worktree,
} from "../database/workspace-schema";
import { publishRealtimeEvent } from "../services/realtime.service";
import { workspaceService } from "../services/workspace.service";
import { AppV2RecoveryConflictError } from "./errors";
import {
  AppV2GitHubPushService,
  type AppV2GitHubPushResult,
} from "./github-push.service";
import { getAppV2Services, type AppV2Services } from "./service-factory";
import type { AppV2Actor } from "./app-project.service";
import {
  claimAppsV2ChatTurnFinalization,
  assertTurnOwnership,
  finishAppsV2ChatTurn,
  getAppsV2ChatTurn,
  listRetryableAppsV2ChatTurns,
  persistAppsV2ChatTurnProjectResult,
  releaseAppsV2ChatTurnProject,
  type AppsV2ChatTurnIdentity,
} from "./chat-turn.service";

export interface AppsV2ChatTurnProjectResult {
  projectId: string;
  worktreeId: string;
  expectedRevision: number;
  status:
    | "pending"
    | "committed"
    | "clean"
    | "superseded"
    | "failed"
    | "recoverable";
  sha?: string;
  localOutcome?: "committed_local";
  remoteStatus?: "local_only" | "pushed" | "remote_failed" | "conflict";
  remoteError?: string;
  error?: string;
  recoveryRef?: string;
}

export interface AppsV2ChatTurnFinalizationResult {
  status: IAppV2ChatTurn["status"];
  projects: AppsV2ChatTurnProjectResult[];
}

export interface AppsV2ChatTurnFinalizerDependencies {
  services(): AppV2Services;
  shouldFlush(worktreeId: string): Promise<boolean>;
  actor(workspaceId: string, actorId: string): Promise<AppV2Actor>;
  assertOwnership(
    identity: AppsV2ChatTurnIdentity,
    allowedStatuses?: IAppV2ChatTurn["status"][],
  ): Promise<void>;
  claim(
    identity: AppsV2ChatTurnIdentity,
    isAborted: boolean,
    retry: boolean,
  ): Promise<IAppV2ChatTurn | null>;
  get(identity: AppsV2ChatTurnIdentity): Promise<IAppV2ChatTurn | null>;
  persist(
    identity: AppsV2ChatTurnIdentity,
    result: IAppV2ChatTurnProject,
  ): Promise<void>;
  finish(
    identity: AppsV2ChatTurnIdentity,
    status:
      | "completed"
      | "superseded"
      | "failed"
      | "recoverable"
      | "remote_failed",
  ): Promise<void>;
  release(turnId: string, worktreeId: string): Promise<void>;
  push(params: {
    workspaceId: string;
    projectId: string;
    chatId: string;
    actor: AppV2Actor;
    localSha: string;
    wipOid?: string;
    requireAutoPush: boolean;
  }): Promise<AppV2GitHubPushResult>;
  afterLocalResultPersisted?(result: IAppV2ChatTurnProject): Promise<void>;
  afterLocalCommit?(sha: string): Promise<void>;
  publish(
    workspaceId: string,
    event:
      | {
          type: "app-v2.worktree.updated";
          projectId: string;
          worktreeId: string;
          revision: number;
          forUserId: string;
        }
      | {
          type: "app-v2.commit.created";
          projectId: string;
          worktreeId: string;
          sha: string;
          forUserId: string;
        },
  ): void;
}

export async function requiresSessionReconciliation(
  worktreeId: string,
): Promise<boolean> {
  return Boolean(
    await AppV2Session.exists({
      worktreeId: new Types.ObjectId(worktreeId),
      status: { $nin: ["destroyed", "revoked"] },
    }),
  );
}

const defaultDependencies: AppsV2ChatTurnFinalizerDependencies = {
  services: getAppV2Services,
  shouldFlush: requiresSessionReconciliation,
  async actor(workspaceId, actorId) {
    const member = await workspaceService.getMember(workspaceId, actorId);
    return { userId: actorId, memberRole: member?.role };
  },
  assertOwnership: assertTurnOwnership,
  claim: claimAppsV2ChatTurnFinalization,
  get: getAppsV2ChatTurn,
  persist: persistAppsV2ChatTurnProjectResult,
  finish: finishAppsV2ChatTurn,
  release: releaseAppsV2ChatTurnProject,
  push: params => new AppV2GitHubPushService().pushConversation(params),
  publish: publishRealtimeEvent,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Apps v2 error";
}

function publicResult(
  project: IAppV2ChatTurnProject,
): AppsV2ChatTurnProjectResult {
  return {
    projectId: project.projectId.toString(),
    worktreeId: project.worktreeId.toString(),
    expectedRevision: project.expectedRevision,
    status: project.status,
    sha: project.sha,
    localOutcome: project.localOutcome,
    remoteStatus: project.remoteStatus,
    remoteError: project.remoteError,
    error: project.error,
    recoveryRef: project.recoveryRef,
  };
}

function durableResult(
  project: IAppV2ChatTurnProject,
  update: Omit<IAppV2ChatTurnProject, "projectId" | "worktreeId">,
): IAppV2ChatTurnProject {
  return {
    projectId: project.projectId,
    worktreeId: project.worktreeId,
    ...update,
  };
}

function turnCommitMarker(turnId: string): string {
  return createHash("sha256").update(turnId).digest("hex");
}

async function recoverCommittedTurn(
  serviceGraph: AppV2Services,
  project: IAppV2Project,
  worktree: IAppV2Worktree,
  touched: IAppV2ChatTurnProject,
  turnId: string,
): Promise<
  | { state: "not-advanced" }
  | { state: "recovered"; sha: string }
  | { state: "ambiguous" }
> {
  const intent = touched.commitIntent;
  if (!intent || intent.turnId !== turnId || worktree.activeTurnId !== turnId) {
    return { state: "ambiguous" };
  }
  if (
    worktree.revision === intent.expectedRevision &&
    worktree.wipOid === intent.expectedWipOid &&
    worktree.baseSha === intent.expectedBaseSha
  ) {
    return { state: "not-advanced" };
  }
  if (
    worktree.revision !== intent.expectedRevision + 1 ||
    !worktree.lastAgentCommitSha ||
    worktree.baseSha !== worktree.lastAgentCommitSha ||
    worktree.wipOid !== worktree.lastAgentCommitSha
  ) {
    return { state: "ambiguous" };
  }
  try {
    const branchSha = await serviceGraph.projects.git.resolveBranch(
      project.repositoryId,
      worktree.branch,
    );
    if (branchSha !== worktree.lastAgentCommitSha) {
      return { state: "ambiguous" };
    }
    const [commit, expectedTree] = await Promise.all([
      serviceGraph.projects.git.getCommit(
        project.repositoryId,
        worktree.lastAgentCommitSha,
      ),
      serviceGraph.projects.git.getCommit(
        project.repositoryId,
        intent.expectedWipOid,
      ),
    ]);
    if (
      commit.treeSha !== expectedTree.treeSha ||
      commit.parentShas.length !== 1 ||
      commit.parentShas[0] !== intent.expectedBaseSha ||
      !commit.message.split("\n").includes(`Mako-Turn-Id: ${intent.marker}`)
    ) {
      return { state: "ambiguous" };
    }
    return { state: "recovered", sha: commit.sha };
  } catch {
    return { state: "ambiguous" };
  }
}

function finalStatus(
  projects: readonly IAppV2ChatTurnProject[],
): "completed" | "superseded" | "failed" | "recoverable" | "remote_failed" {
  if (projects.some(project => project.status === "recoverable")) {
    return "recoverable";
  }
  if (projects.some(project => project.status === "failed")) return "failed";
  if (
    projects.some(
      project =>
        project.remoteStatus === "remote_failed" ||
        project.remoteStatus === "conflict",
    )
  ) {
    return "remote_failed";
  }
  if (
    projects.length > 0 &&
    projects.every(project => project.status === "superseded")
  ) {
    return "superseded";
  }
  return "completed";
}

export async function finalizeAppsV2ChatTurn(
  {
    workspaceId,
    chatId,
    turnId,
    actorId,
    retryLeaseId,
    allowSupersededRetry,
    allowRemoteOnlyRetry,
    isAborted,
    retry = false,
  }: AppsV2ChatTurnIdentity & {
    isAborted: boolean;
    retry?: boolean;
  },
  dependencies: AppsV2ChatTurnFinalizerDependencies = defaultDependencies,
): Promise<AppsV2ChatTurnFinalizationResult> {
  const identity = {
    workspaceId,
    chatId,
    turnId,
    actorId,
    retryLeaseId,
    allowSupersededRetry,
    allowRemoteOnlyRetry,
  };
  const claimed = await dependencies.claim(identity, isAborted, retry);
  if (!claimed) {
    const existing = await dependencies.get(identity);
    return {
      status: existing?.status ?? "completed",
      projects: (existing?.touchedProjects ?? []).map(publicResult),
    };
  }

  await dependencies.assertOwnership(identity, ["finalizing"]);
  const actor = await dependencies.actor(workspaceId, actorId);
  const serviceGraph = dependencies.services();
  const results: IAppV2ChatTurnProject[] = [];

  for (const touched of claimed.touchedProjects) {
    const projectId = touched.projectId.toString();
    const worktreeId = touched.worktreeId.toString();
    if (
      retry &&
      ["committed", "clean", "superseded"].includes(touched.status)
    ) {
      if (
        touched.status === "committed" &&
        (touched.remoteStatus === "remote_failed" ||
          touched.remoteStatus === "local_only") &&
        touched.sha
      ) {
        let retried = touched;
        try {
          const remote = await dependencies.push({
            workspaceId,
            projectId,
            chatId,
            actor,
            localSha: touched.sha,
            requireAutoPush: true,
          });
          retried = durableResult(touched, {
            expectedRevision: touched.expectedRevision,
            status: "committed",
            sha: touched.sha,
            localOutcome: "committed_local",
            remoteStatus: remote.status,
            remoteError: remote.error,
          });
        } catch (error) {
          retried = durableResult(touched, {
            expectedRevision: touched.expectedRevision,
            status: "committed",
            sha: touched.sha,
            localOutcome: "committed_local",
            remoteStatus: "remote_failed",
            remoteError: errorMessage(error),
          });
        }
        await dependencies.persist(identity, retried);
        results.push(retried);
        if (
          retried.remoteStatus === "pushed" ||
          retried.remoteStatus === "local_only"
        ) {
          await dependencies.release(turnId, worktreeId);
        }
        continue;
      }
      results.push(touched);
      continue;
    }
    let result!: IAppV2ChatTurnProject;
    let localResultPersisted = false;
    let localCommitCompleted = false;
    let commitIntentPersisted = false;
    let commitExpectedRevision = touched.expectedRevision;
    try {
      const project = await serviceGraph.projects.getWritable(
        workspaceId,
        projectId,
        actor,
      );
      let worktree = await serviceGraph.worktrees.getById(
        project,
        worktreeId,
        actor,
      );
      const commitRecovery = touched.commitIntent
        ? await recoverCommittedTurn(
            serviceGraph,
            project,
            worktree,
            touched,
            turnId,
          )
        : undefined;
      if (commitRecovery?.state === "recovered") {
        if (serviceGraph.sessions && touched.commitIntent) {
          await serviceGraph.sessions.advanceEquivalentCommit(
            project,
            worktree,
            actor,
            touched.commitIntent.expectedWipOid,
          );
        }
        result = durableResult(touched, {
          expectedRevision: touched.commitIntent?.expectedRevision ?? 0,
          status: "committed",
          sha: commitRecovery.sha,
          localOutcome: "committed_local",
          remoteStatus: "local_only",
        });
        await dependencies.persist(identity, result);
        localResultPersisted = true;
        await dependencies.afterLocalResultPersisted?.(result);
        dependencies.publish(workspaceId, {
          type: "app-v2.worktree.updated",
          projectId,
          worktreeId,
          revision: worktree.revision,
          forUserId: actorId,
        });
        dependencies.publish(workspaceId, {
          type: "app-v2.commit.created",
          projectId,
          worktreeId,
          sha: commitRecovery.sha,
          forUserId: actorId,
        });
        try {
          const remote = await dependencies.push({
            workspaceId,
            projectId,
            chatId,
            actor,
            localSha: commitRecovery.sha,
            wipOid: worktree.wipOid,
            requireAutoPush: true,
          });
          result.remoteStatus = remote.status;
          result.remoteError = remote.error;
        } catch (error) {
          result.remoteStatus = "remote_failed";
          result.remoteError = errorMessage(error);
        }
      } else if (commitRecovery?.state === "ambiguous") {
        result = durableResult(touched, {
          expectedRevision:
            touched.commitIntent?.expectedRevision ?? touched.expectedRevision,
          status: "recoverable",
          error:
            "Worktree advanced after commit intent but does not match this turn",
          commitIntent: touched.commitIntent,
        });
      } else if (
        worktree.kind !== "agent" ||
        worktree.chatId !== chatId ||
        worktree.activeTurnId !== turnId ||
        worktree.revision !== touched.expectedRevision
      ) {
        result = durableResult(touched, {
          expectedRevision: touched.expectedRevision,
          status: "superseded",
          error:
            "Worktree revision or turn ownership changed before finalization",
        });
      } else {
        if (await dependencies.shouldFlush(worktreeId)) {
          try {
            if (!serviceGraph.sessions) {
              throw new Error(
                "Apps v2 session requires reconciliation but the provider is unavailable",
              );
            }
            await dependencies.assertOwnership(identity, ["finalizing"]);
            const ensured = await serviceGraph.sessions.ensure(
              project,
              worktree,
              actor,
            );
            await dependencies.assertOwnership(identity, ["finalizing"]);
            const flushed = await serviceGraph.sessions.flush(
              project,
              ensured.worktree,
              actor,
            );
            await dependencies.assertOwnership(identity, ["finalizing"]);
            if (flushed.flush.durability.status === "conflict") {
              result = durableResult(touched, {
                expectedRevision: touched.expectedRevision,
                status: "recoverable",
                error: "Sandbox source flush requires recovery",
                recoveryRef: flushed.flush.durability.recoveryRef,
              });
              await dependencies.persist(identity, result);
              results.push(result);
              continue;
            }
            worktree = flushed.worktree;
            result = durableResult(touched, {
              expectedRevision: worktree.revision,
              status: "pending",
            });
            commitExpectedRevision = worktree.revision;
            await dependencies.persist(identity, result);
          } catch (error) {
            result = durableResult(touched, {
              expectedRevision: touched.expectedRevision,
              status:
                error instanceof AppV2RecoveryConflictError
                  ? "recoverable"
                  : "failed",
              error: errorMessage(error),
              recoveryRef:
                error instanceof AppV2RecoveryConflictError
                  ? error.recoveryRef
                  : undefined,
            });
            await dependencies.persist(identity, result);
            results.push(result);
            continue;
          }
        }

        const current = await serviceGraph.worktrees.getById(
          project,
          worktreeId,
          actor,
        );
        const expectedRevision = commitExpectedRevision;
        if (
          current.activeTurnId !== turnId ||
          current.revision !== expectedRevision
        ) {
          result = durableResult(touched, {
            expectedRevision,
            status: "superseded",
            error: "Worktree changed while finalization was in progress",
          });
        } else {
          const status = await serviceGraph.worktrees.status(project, current);
          await dependencies.assertOwnership(identity, ["finalizing"]);
          if (status.clean) {
            result = durableResult(touched, {
              expectedRevision,
              status: "clean",
            });
          } else {
            await dependencies.assertOwnership(identity, ["finalizing"]);
            const marker = turnCommitMarker(turnId);
            const commitIntent = {
              turnId,
              expectedRevision,
              expectedWipOid: current.wipOid,
              expectedBaseSha: current.baseSha,
              marker,
            };
            const intentResult = durableResult(touched, {
              expectedRevision,
              status: "pending",
              commitIntent,
            });
            await dependencies.persist(identity, intentResult);
            commitIntentPersisted = true;
            const committed = await serviceGraph.worktrees.commit(
              project,
              current,
              {
                ifRevision: expectedRevision,
                expectedWipOid: current.wipOid,
                leaseEpoch: current.leaseEpoch,
              },
              `Mako agent turn${isAborted ? " (aborted)" : ""}\n\nMako-Turn-Id: ${marker}`,
              actor,
            );
            localCommitCompleted = true;
            await dependencies.afterLocalCommit?.(committed.sha);
            if (serviceGraph.sessions) {
              await serviceGraph.sessions.advanceEquivalentCommit(
                project,
                committed.worktree,
                actor,
                current.wipOid,
              );
            }
            dependencies.publish(workspaceId, {
              type: "app-v2.worktree.updated",
              projectId,
              worktreeId,
              revision: committed.worktree.revision,
              forUserId: actorId,
            });
            dependencies.publish(workspaceId, {
              type: "app-v2.commit.created",
              projectId,
              worktreeId,
              sha: committed.sha,
              forUserId: actorId,
            });
            result = durableResult(touched, {
              expectedRevision,
              status: "committed",
              sha: committed.sha,
              localOutcome: "committed_local",
              remoteStatus: "local_only",
            });
            await dependencies.persist(identity, result);
            localResultPersisted = true;
            await dependencies.afterLocalResultPersisted?.(result);
            try {
              const remote = await dependencies.push({
                workspaceId,
                projectId,
                chatId,
                actor,
                localSha: committed.sha,
                wipOid: committed.worktree.wipOid,
                requireAutoPush: true,
              });
              result.remoteStatus = remote.status;
              result.remoteError = remote.error;
            } catch (error) {
              result.remoteStatus = "remote_failed";
              result.remoteError = errorMessage(error);
            }
          }
        }
      }
    } catch (error) {
      if (
        localResultPersisted ||
        localCommitCompleted ||
        commitIntentPersisted
      ) {
        throw error;
      }
      result = durableResult(touched, {
        expectedRevision: touched.expectedRevision,
        status:
          error instanceof AppV2RecoveryConflictError
            ? "recoverable"
            : "failed",
        error: errorMessage(error),
        recoveryRef:
          error instanceof AppV2RecoveryConflictError
            ? error.recoveryRef
            : undefined,
      });
    }

    await dependencies.persist(identity, result);
    results.push(result);
    if (!["failed", "recoverable", "pending"].includes(result.status)) {
      await dependencies.release(turnId, worktreeId);
    }
  }

  const status = finalStatus(results);
  await dependencies.finish(identity, status);
  return { status, projects: results.map(publicResult) };
}

/**
 * Bounded reconciliation entry point used at same-chat request start and by
 * Apps v2 maintenance. Recovery-aware finalization always re-enters session
 * ensure/flush before Git.
 */
export async function reconcilePendingAppsV2ChatTurns({
  limit = 25,
  workspaceId,
  chatId,
  turnId,
  actorId,
}: {
  limit?: number;
  workspaceId?: string;
  chatId?: string;
  turnId?: string;
  actorId?: string;
} = {}): Promise<
  Array<{
    turnId: string;
    result?: AppsV2ChatTurnFinalizationResult;
    error?: string;
  }>
> {
  const turns = await listRetryableAppsV2ChatTurns(limit, {
    workspaceId,
    chatId,
    turnId,
    actorId,
  });
  const results: Array<{
    turnId: string;
    result?: AppsV2ChatTurnFinalizationResult;
    error?: string;
  }> = [];
  for (const turn of turns) {
    const retryLeaseId = randomUUID();
    try {
      results.push({
        turnId: turn.turnId,
        result: await finalizeAppsV2ChatTurn({
          workspaceId: turn.workspaceId.toString(),
          chatId: turn.chatId,
          turnId: turn.turnId,
          actorId: turn.actorId,
          retryLeaseId,
          allowSupersededRetry: turn.status === "superseded",
          allowRemoteOnlyRetry: turn.status === "remote_failed",
          isAborted: turn.isAborted,
          retry: true,
        }),
      });
    } catch (error) {
      results.push({ turnId: turn.turnId, error: errorMessage(error) });
    }
  }
  return results;
}

/**
 * Finalizes the exact predecessor while it still owns the chat. Fresh active
 * turns use the normal claim; failed/recoverable/superseded turns use a leased
 * retry. A fresh finalizing turn remains owned elsewhere and fails closed.
 */
export async function finalizeAppsV2PredecessorForHandoff(
  identity: AppsV2ChatTurnIdentity,
): Promise<AppsV2ChatTurnFinalizationResult> {
  const existing = await getAppsV2ChatTurn(identity);
  const retry = Boolean(
    existing &&
      [
        "failed",
        "recoverable",
        "remote_failed",
        "superseded",
        "finalizing",
      ].includes(existing.status),
  );
  const result = await finalizeAppsV2ChatTurn({
    ...identity,
    isAborted: existing?.isAborted ?? false,
    retry,
    retryLeaseId: retry ? randomUUID() : undefined,
    allowSupersededRetry: existing?.status === "superseded",
  });
  if (result.status !== "completed" && result.status !== "remote_failed") {
    throw new Error(
      `Previous Apps v2 turn did not finalize safely (${result.status})`,
    );
  }
  return result;
}
