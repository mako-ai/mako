import { Types } from "mongoose";
import {
  AppV2ChatTurn,
  AppV2Worktree,
  Chat,
  type IAppV2ChatTurn,
  type IAppV2ChatTurnProject,
} from "../database/workspace-schema";
import { AppV2OperationConflictError } from "./errors";

export const APPS_V2_CHAT_TURN_STALE_MS = 15 * 60_000;
export const APPS_V2_CHAT_TURN_RETRY_LEASE_MS = 5 * 60_000;

export interface AppsV2ChatTurnIdentity {
  workspaceId: string;
  chatId: string;
  turnId: string;
  actorId: string;
  retryLeaseId?: string;
  allowSupersededRetry?: boolean;
  allowRemoteOnlyRetry?: boolean;
}

function identityQuery(identity: AppsV2ChatTurnIdentity) {
  return {
    workspaceId: new Types.ObjectId(identity.workspaceId),
    chatId: identity.chatId,
    turnId: identity.turnId,
    actorId: identity.actorId,
  };
}

function finalizationLeaseQuery(identity: AppsV2ChatTurnIdentity) {
  return identity.retryLeaseId
    ? { retryLeaseId: identity.retryLeaseId }
    : { retryLeaseId: { $exists: false } };
}

async function markTurnSuperseded(
  identity: AppsV2ChatTurnIdentity,
): Promise<void> {
  await AppV2ChatTurn.updateOne(
    {
      ...identityQuery(identity),
      status: {
        $in: ["active", "finalizing", "failed", "recoverable"],
      },
    },
    {
      $set: { status: "superseded", finalizedAt: new Date() },
      $unset: { retryLeaseId: 1, retryLeaseExpiresAt: 1 },
    },
  );
}

export async function requireAppsV2TurnOwner(
  identity: AppsV2ChatTurnIdentity,
): Promise<void> {
  const ownsChat = await Chat.exists({
    _id: new Types.ObjectId(identity.chatId),
    workspaceId: new Types.ObjectId(identity.workspaceId),
    createdBy: identity.actorId,
    appsV2ActiveTurnId: identity.turnId,
  });
  if (ownsChat) return;
  await markTurnSuperseded(identity);
  throw new AppV2OperationConflictError(
    "A newer chat turn superseded this Apps v2 operation",
  );
}

export async function assertTurnOwnership(
  identity: AppsV2ChatTurnIdentity,
  allowedStatuses: IAppV2ChatTurn["status"][] = ["active"],
): Promise<void> {
  if (!identity.allowSupersededRetry && !identity.allowRemoteOnlyRetry) {
    await requireAppsV2TurnOwner(identity);
  }
  const heartbeat = await AppV2ChatTurn.updateOne(
    {
      ...identityQuery(identity),
      status: { $in: allowedStatuses },
      ...(identity.retryLeaseId ? finalizationLeaseQuery(identity) : {}),
    },
    { $set: { heartbeatAt: new Date() } },
  );
  if (heartbeat.matchedCount !== 1) {
    throw new AppV2OperationConflictError(
      "Apps v2 turn is no longer allowed to mutate",
    );
  }
}

export async function startAppsV2ChatTurn(
  identity: AppsV2ChatTurnIdentity,
): Promise<void> {
  const now = new Date();
  await AppV2ChatTurn.updateOne(
    identityQuery(identity),
    {
      $setOnInsert: {
        status: "active",
        touchedProjects: [],
        isAborted: false,
        attemptCount: 0,
      },
      $set: { heartbeatAt: now },
    },
    { upsert: true },
  );
}

async function claimWorktree(
  identity: AppsV2ChatTurnIdentity,
  projectId: Types.ObjectId,
  worktreeId: Types.ObjectId,
  expectedRevision: number,
): Promise<void> {
  const current = await AppV2Worktree.findById(worktreeId).select(
    "workspaceId projectId actorId kind chatId revision activeTurnId",
  );
  if (
    !current ||
    current.workspaceId.toString() !== identity.workspaceId ||
    !current.projectId.equals(projectId) ||
    current.actorId !== identity.actorId ||
    current.kind !== "agent" ||
    current.chatId !== identity.chatId
  ) {
    throw new AppV2OperationConflictError(
      "Apps v2 turn cannot claim this conversation worktree",
    );
  }
  if (current.revision !== expectedRevision) {
    throw new AppV2OperationConflictError(
      "Apps v2 worktree changed before turn ownership was recorded",
    );
  }

  const currentOwner = current.activeTurnId;
  if (currentOwner && currentOwner !== identity.turnId) {
    const ownerIsActive = await Chat.exists({
      _id: new Types.ObjectId(identity.chatId),
      workspaceId: new Types.ObjectId(identity.workspaceId),
      createdBy: identity.actorId,
      appsV2ActiveTurnId: currentOwner,
    });
    if (ownerIsActive) {
      throw new AppV2OperationConflictError(
        "A previous Apps v2 turn still owns this conversation worktree",
      );
    }
  }

  const claimed = await AppV2Worktree.updateOne(
    {
      _id: worktreeId,
      workspaceId: current.workspaceId,
      actorId: identity.actorId,
      kind: "agent",
      chatId: identity.chatId,
      revision: expectedRevision,
      ...(currentOwner
        ? { activeTurnId: currentOwner }
        : {
            $or: [{ activeTurnId: { $exists: false } }, { activeTurnId: null }],
          }),
    },
    { $set: { activeTurnId: identity.turnId } },
  );
  if (claimed.modifiedCount !== 1 && currentOwner !== identity.turnId) {
    throw new AppV2OperationConflictError(
      "Apps v2 worktree turn ownership changed concurrently",
    );
  }
}

/**
 * Claims a conversation worktree and records its durable revision. Calling
 * this before mutation fences overlapping turns; calling it after mutation
 * advances the revision the finalizer is allowed to commit.
 */
export async function touchAppsV2ChatTurnProject(
  identity: AppsV2ChatTurnIdentity,
  projectId: string,
  worktreeId: string,
  expectedRevision: number,
): Promise<void> {
  const projectObjectId = new Types.ObjectId(projectId);
  const worktreeObjectId = new Types.ObjectId(worktreeId);
  await startAppsV2ChatTurn(identity);
  await assertTurnOwnership(identity);
  await claimWorktree(
    identity,
    projectObjectId,
    worktreeObjectId,
    expectedRevision,
  );

  const updated = await AppV2ChatTurn.updateOne(
    { ...identityQuery(identity), status: "active" },
    [
      {
        $set: {
          heartbeatAt: new Date(),
          touchedProjects: {
            $concatArrays: [
              {
                $filter: {
                  input: { $ifNull: ["$touchedProjects", []] },
                  as: "project",
                  cond: { $ne: ["$$project.projectId", projectObjectId] },
                },
              },
              [
                {
                  projectId: projectObjectId,
                  worktreeId: worktreeObjectId,
                  expectedRevision,
                  status: "pending",
                },
              ],
            ],
          },
        },
      },
    ],
  );
  if (updated.matchedCount !== 1) {
    throw new AppV2OperationConflictError("Apps v2 turn is no longer active");
  }
}

export async function releaseAppsV2ChatTurnProject(
  turnId: string,
  worktreeId: string,
): Promise<void> {
  await AppV2Worktree.updateOne(
    {
      _id: new Types.ObjectId(worktreeId),
      activeTurnId: turnId,
    },
    { $unset: { activeTurnId: 1 } },
  );
}

export async function persistAppsV2ChatTurnProjectResult(
  identity: AppsV2ChatTurnIdentity,
  result: IAppV2ChatTurnProject,
): Promise<void> {
  const updated = await AppV2ChatTurn.updateOne(
    {
      ...identityQuery(identity),
      status: "finalizing",
      ...finalizationLeaseQuery(identity),
      "touchedProjects.projectId": result.projectId,
    },
    {
      $set: {
        "touchedProjects.$": result,
        heartbeatAt: new Date(),
      },
    },
  );
  if (updated.matchedCount !== 1) {
    throw new AppV2OperationConflictError(
      "Apps v2 turn finalization ownership was lost",
    );
  }
}

export async function getAppsV2ChatTurn(
  identity: AppsV2ChatTurnIdentity,
): Promise<IAppV2ChatTurn | null> {
  return AppV2ChatTurn.findOne(identityQuery(identity));
}

export async function claimAppsV2ChatTurnFinalization(
  identity: AppsV2ChatTurnIdentity,
  isAborted: boolean,
  retry: boolean,
): Promise<IAppV2ChatTurn | null> {
  if (!identity.allowSupersededRetry && !identity.allowRemoteOnlyRetry) {
    await requireAppsV2TurnOwner(identity);
  }
  const now = new Date();
  const staleBefore = new Date(now.getTime() - APPS_V2_CHAT_TURN_STALE_MS);
  if (retry && !identity.retryLeaseId) {
    throw new AppV2OperationConflictError(
      "Apps v2 retry finalization requires a lease",
    );
  }
  return AppV2ChatTurn.findOneAndUpdate(
    {
      ...identityQuery(identity),
      ...(retry
        ? {
            $and: [
              {
                $or: [
                  { retryLeaseExpiresAt: { $exists: false } },
                  { retryLeaseExpiresAt: { $lt: now } },
                ],
              },
              identity.allowSupersededRetry
                ? {
                    status: "superseded",
                    touchedProjects: {
                      $elemMatch: {
                        status: {
                          $in: ["pending", "failed", "recoverable"],
                        },
                      },
                    },
                  }
                : identity.allowRemoteOnlyRetry
                  ? {
                      status: "remote_failed",
                      "touchedProjects.status": {
                        $nin: ["pending", "failed", "recoverable"],
                      },
                    }
                  : {
                      $or: [
                        {
                          status: {
                            $in: ["failed", "recoverable", "remote_failed"],
                          },
                        },
                        {
                          status: "active",
                          heartbeatAt: { $lt: staleBefore },
                        },
                        {
                          status: "finalizing",
                          heartbeatAt: { $lt: staleBefore },
                        },
                      ],
                    },
            ],
          }
        : { status: "active" }),
    },
    {
      $set: {
        status: "finalizing",
        finalizingAt: now,
        heartbeatAt: now,
        isAborted,
        ...(retry
          ? {
              retryLeaseId: identity.retryLeaseId,
              retryLeaseExpiresAt: new Date(
                now.getTime() + APPS_V2_CHAT_TURN_RETRY_LEASE_MS,
              ),
            }
          : {}),
      },
      $inc: { attemptCount: 1 },
      $unset: {
        finalizedAt: 1,
        ...(retry ? {} : { retryLeaseId: 1, retryLeaseExpiresAt: 1 }),
      },
    },
    { new: true },
  );
}

export async function finishAppsV2ChatTurn(
  identity: AppsV2ChatTurnIdentity,
  status:
    | "completed"
    | "superseded"
    | "failed"
    | "recoverable"
    | "remote_failed",
): Promise<void> {
  const updated = await AppV2ChatTurn.updateOne(
    {
      ...identityQuery(identity),
      status: "finalizing",
      ...finalizationLeaseQuery(identity),
    },
    {
      $set: { status, finalizedAt: new Date(), heartbeatAt: new Date() },
      $unset: { retryLeaseId: 1, retryLeaseExpiresAt: 1 },
    },
  );
  if (updated.matchedCount !== 1) {
    throw new AppV2OperationConflictError(
      "Apps v2 turn finalization ownership was lost",
    );
  }
}

export async function listRetryableAppsV2ChatTurns(
  limit: number,
  options: {
    workspaceId?: string;
    chatId?: string;
    turnId?: string;
    actorId?: string;
    now?: Date;
  } = {},
): Promise<IAppV2ChatTurn[]> {
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - APPS_V2_CHAT_TURN_STALE_MS);
  return AppV2ChatTurn.find({
    ...(options.workspaceId
      ? { workspaceId: new Types.ObjectId(options.workspaceId) }
      : {}),
    ...(options.chatId ? { chatId: options.chatId } : {}),
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.actorId ? { actorId: options.actorId } : {}),
    $and: [
      {
        $or: [
          { retryLeaseExpiresAt: { $exists: false } },
          { retryLeaseExpiresAt: { $lt: now } },
        ],
      },
      {
        $or: [
          { status: { $in: ["failed", "recoverable", "remote_failed"] } },
          { status: "active", heartbeatAt: { $lt: staleBefore } },
          { status: "finalizing", heartbeatAt: { $lt: staleBefore } },
          {
            status: "superseded",
            touchedProjects: {
              $elemMatch: {
                status: { $in: ["pending", "failed", "recoverable"] },
              },
            },
          },
        ],
      },
    ],
  })
    .sort({ heartbeatAt: 1 })
    .limit(limit);
}

export async function supersedeAppsV2ChatTurn(
  identity: AppsV2ChatTurnIdentity,
): Promise<boolean> {
  await markTurnSuperseded(identity);
  const turn = await getAppsV2ChatTurn(identity);
  return Boolean(
    turn?.touchedProjects.some(project =>
      ["pending", "failed", "recoverable"].includes(project.status),
    ),
  );
}
