import { createHash, randomUUID } from "node:crypto";
import { MongoServerError } from "mongodb";
import { Types } from "mongoose";
import {
  AppV2Session,
  type IAppV2Project,
  type IAppV2Session,
  type IAppV2Worktree,
} from "../database/workspace-schema";
import type { AppV2Actor } from "./app-project.service";
import {
  APP_V2_SESSION_MAX_TIMEOUT_MS,
  APP_V2_SESSION_OPERATION_LEASE_MS,
} from "./config";
import {
  AppV2ConflictError,
  AppV2NotFoundError,
  AppV2OperationConflictError,
  AppV2RecoveryConflictError,
} from "./errors";
import type {
  ProvisioningReservation,
  SessionExecutionTarget,
  SessionExecRequest,
  SessionExecResult,
  SessionExecutor,
  SessionFlushResult,
} from "./session-executor";
import {
  appV2SessionOperationKey,
  appV2SessionOperationMutex,
  type AppV2KeyedMutex,
} from "./session-operation-lock";
import { AppV2WorktreeService } from "./worktree.service";

if (APP_V2_SESSION_OPERATION_LEASE_MS <= APP_V2_SESSION_MAX_TIMEOUT_MS) {
  throw new Error("Apps v2 operation lease policy must exceed command timeout");
}

export type AppV2SessionStatus =
  | "active"
  | "paused"
  | "unsynced"
  | "conflict"
  | "provisioning"
  | "revoked"
  | "destroyed"
  | "error";

export interface AppV2SessionRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  worktreeId: string;
  actorId: string;
  purpose: "dev" | "build" | "job";
  provider: string;
  sandboxId: string;
  reservationId: string;
  reservationCleaned?: boolean;
  generation: number;
  operationId?: string;
  operationExpiresAt?: Date;
  leaseEpoch: number;
  appliedWipOid: string;
  pendingRecoveryId?: string;
  pendingRecoveryCompleted?: boolean;
  pendingExpectedWipOid?: string;
  pendingExpectedRevision?: number;
  pendingSuccessRef?: string;
  recoveryRef?: string;
  status: AppV2SessionStatus;
  lastActiveAt: Date;
}

export type NewAppV2SessionRecord = Omit<
  AppV2SessionRecord,
  | "id"
  | "generation"
  | "operationId"
  | "operationExpiresAt"
  | "pendingRecoveryId"
  | "pendingRecoveryCompleted"
  | "pendingExpectedWipOid"
  | "pendingExpectedRevision"
  | "pendingSuccessRef"
  | "recoveryRef"
>;

export type AppV2SessionChanges = Partial<
  Pick<
    AppV2SessionRecord,
    | "appliedWipOid"
    | "leaseEpoch"
    | "status"
    | "lastActiveAt"
    | "sandboxId"
    | "provider"
    | "reservationId"
    | "reservationCleaned"
  >
> & {
  pendingRecoveryId?: string | null;
  pendingRecoveryCompleted?: boolean | null;
  pendingExpectedWipOid?: string | null;
  pendingExpectedRevision?: number | null;
  pendingSuccessRef?: string | null;
  recoveryRef?: string | null;
};

export interface AppV2SessionStore {
  find(
    workspaceId: string,
    projectId: string,
    worktreeId: string,
    actorId: string,
    purpose: AppV2SessionRecord["purpose"],
  ): Promise<AppV2SessionRecord | null>;
  listProject(
    workspaceId: string,
    projectId: string,
  ): Promise<AppV2SessionRecord[]>;
  listStaleProvisioning(limit: number): Promise<AppV2SessionRecord[]>;
  reserve(
    record: NewAppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<AppV2SessionRecord>;
  acquireOperation(
    record: AppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<AppV2SessionRecord>;
  renewOperation(
    record: AppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<void>;
  assertOperation(
    record: AppV2SessionRecord,
    operationId: string,
  ): Promise<void>;
  releaseOperation(
    record: AppV2SessionRecord,
    operationId: string,
  ): Promise<void>;
  install(
    record: NewAppV2SessionRecord,
    expected: AppV2SessionRecord,
    operationId: string,
  ): Promise<AppV2SessionRecord>;
  update(
    record: AppV2SessionRecord,
    changes: AppV2SessionChanges,
    operationId: string,
  ): Promise<AppV2SessionRecord>;
}

interface OperationContext {
  record: AppV2SessionRecord;
  readonly operationId: string;
  readonly signal: AbortSignal;
  assertHealthy(): void;
}

function sessionRecord(document: IAppV2Session): AppV2SessionRecord {
  return {
    id: document._id.toString(),
    workspaceId: document.workspaceId.toString(),
    projectId: document.projectId.toString(),
    worktreeId: document.worktreeId.toString(),
    actorId: document.actorId,
    purpose: document.purpose,
    provider: document.provider,
    sandboxId: document.sandboxId,
    reservationId: document.reservationId,
    reservationCleaned: document.reservationCleaned,
    generation: document.generation,
    operationId: document.operationId,
    operationExpiresAt: document.operationExpiresAt,
    leaseEpoch: document.leaseEpoch,
    appliedWipOid: document.appliedWipOid,
    pendingRecoveryId: document.pendingRecoveryId,
    pendingRecoveryCompleted: document.pendingRecoveryCompleted,
    pendingExpectedWipOid: document.pendingExpectedWipOid,
    pendingExpectedRevision: document.pendingExpectedRevision,
    pendingSuccessRef: document.pendingSuccessRef,
    recoveryRef: document.recoveryRef,
    status: document.status,
    lastActiveAt: document.lastActiveAt,
  };
}

function sessionIdentityFilter(record: AppV2SessionRecord) {
  return {
    _id: new Types.ObjectId(record.id),
    workspaceId: new Types.ObjectId(record.workspaceId),
    projectId: new Types.ObjectId(record.projectId),
    worktreeId: new Types.ObjectId(record.worktreeId),
    actorId: record.actorId,
    purpose: record.purpose,
  };
}

function sessionCasFilter(record: AppV2SessionRecord) {
  return {
    ...sessionIdentityFilter(record),
    sandboxId: record.sandboxId,
    generation: record.generation,
    leaseEpoch: record.leaseEpoch,
    status: record.status,
  };
}

function activeOperationFilter(operationId: string) {
  return {
    operationId,
    $expr: { $gt: ["$operationExpiresAt", "$$NOW"] },
  };
}

function operationLeasePipeline(operationId: string, leaseMs: number) {
  return [
    {
      $set: {
        operationId: { $literal: operationId },
        operationExpiresAt: {
          $dateAdd: {
            startDate: "$$NOW",
            unit: "millisecond",
            amount: leaseMs,
          },
        },
      },
    },
  ];
}

function sessionSet(record: NewAppV2SessionRecord) {
  return {
    workspaceId: new Types.ObjectId(record.workspaceId),
    projectId: new Types.ObjectId(record.projectId),
    worktreeId: new Types.ObjectId(record.worktreeId),
    actorId: record.actorId,
    purpose: record.purpose,
    provider: record.provider,
    sandboxId: record.sandboxId,
    reservationId: record.reservationId,
    reservationCleaned: record.reservationCleaned ?? false,
    leaseEpoch: record.leaseEpoch,
    appliedWipOid: record.appliedWipOid,
    status: record.status,
    lastActiveAt: record.lastActiveAt,
  };
}

export class MongoAppV2SessionStore implements AppV2SessionStore {
  async find(
    workspaceId: string,
    projectId: string,
    worktreeId: string,
    actorId: string,
    purpose: AppV2SessionRecord["purpose"],
  ): Promise<AppV2SessionRecord | null> {
    const session = await AppV2Session.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      projectId: new Types.ObjectId(projectId),
      worktreeId: new Types.ObjectId(worktreeId),
      actorId,
      purpose,
    });
    return session ? sessionRecord(session) : null;
  }

  async listProject(
    workspaceId: string,
    projectId: string,
  ): Promise<AppV2SessionRecord[]> {
    const sessions = await AppV2Session.find({
      workspaceId: new Types.ObjectId(workspaceId),
      projectId: new Types.ObjectId(projectId),
    });
    return sessions.map(sessionRecord);
  }

  async listStaleProvisioning(limit: number): Promise<AppV2SessionRecord[]> {
    const sessions = await AppV2Session.find({
      status: "provisioning",
      $or: [
        { operationId: { $exists: false } },
        { operationId: null },
        { $expr: { $lte: ["$operationExpiresAt", "$$NOW"] } },
      ],
    }).limit(Math.min(Math.max(limit, 1), 100));
    return sessions.map(sessionRecord);
  }

  async reserve(
    record: NewAppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<AppV2SessionRecord> {
    const id = new Types.ObjectId();
    try {
      const session = await AppV2Session.findOneAndUpdate(
        {
          _id: id,
          workspaceId: new Types.ObjectId(record.workspaceId),
          projectId: new Types.ObjectId(record.projectId),
          worktreeId: new Types.ObjectId(record.worktreeId),
          actorId: record.actorId,
          purpose: record.purpose,
        },
        [
          {
            $set: {
              ...sessionSet(record),
              generation: 0,
              operationId: { $literal: operationId },
              operationExpiresAt: {
                $dateAdd: {
                  startDate: "$$NOW",
                  unit: "millisecond",
                  amount: leaseMs,
                },
              },
            },
          },
        ],
        { upsert: true, new: true },
      );
      if (!session) throw new Error("Session reservation was not created");
      return sessionRecord(session);
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new AppV2OperationConflictError(
          "Session provisioning is already in progress; retry later",
        );
      }
      throw error;
    }
  }

  async acquireOperation(
    record: AppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<AppV2SessionRecord> {
    const session = await AppV2Session.findOneAndUpdate(
      {
        ...sessionCasFilter(record),
        $or: [
          { operationId: { $exists: false } },
          { operationId: null },
          { $expr: { $lte: ["$operationExpiresAt", "$$NOW"] } },
        ],
      },
      operationLeasePipeline(operationId, leaseMs),
      { new: true },
    );
    if (!session) {
      throw new AppV2OperationConflictError(
        "Session operation is already in progress; retry later",
      );
    }
    return sessionRecord(session);
  }

  async renewOperation(
    record: AppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<void> {
    const session = await AppV2Session.findOneAndUpdate(
      {
        ...sessionIdentityFilter(record),
        ...activeOperationFilter(operationId),
      },
      operationLeasePipeline(operationId, leaseMs),
      { new: true },
    );
    if (!session) {
      throw new AppV2OperationConflictError(
        "Session operation lease renewal failed",
      );
    }
  }

  async assertOperation(
    record: AppV2SessionRecord,
    operationId: string,
  ): Promise<void> {
    const owned = await AppV2Session.exists({
      ...sessionIdentityFilter(record),
      ...activeOperationFilter(operationId),
    });
    if (!owned) {
      throw new AppV2OperationConflictError(
        "Session operation lease is no longer owned",
      );
    }
  }

  async releaseOperation(
    record: AppV2SessionRecord,
    operationId: string,
  ): Promise<void> {
    await AppV2Session.updateOne(
      { ...sessionIdentityFilter(record), operationId },
      { $unset: { operationId: "", operationExpiresAt: "" } },
    );
  }

  async install(
    record: NewAppV2SessionRecord,
    expected: AppV2SessionRecord,
    operationId: string,
  ): Promise<AppV2SessionRecord> {
    const session = await AppV2Session.findOneAndUpdate(
      {
        ...sessionCasFilter(expected),
        ...activeOperationFilter(operationId),
      },
      {
        $set: sessionSet(record),
        $unset: {
          pendingRecoveryId: "",
          pendingRecoveryCompleted: "",
          pendingExpectedWipOid: "",
          pendingExpectedRevision: "",
          pendingSuccessRef: "",
          recoveryRef: "",
        },
        $inc: { generation: 1 },
      },
      { new: true },
    );
    if (!session) {
      throw new AppV2OperationConflictError(
        "Session provisioning ownership changed; retry later",
      );
    }
    return sessionRecord(session);
  }

  async update(
    record: AppV2SessionRecord,
    changes: AppV2SessionChanges,
    operationId: string,
  ): Promise<AppV2SessionRecord> {
    const set: Record<string, unknown> = { ...changes };
    const unset: Record<string, ""> = {};
    if (changes.pendingRecoveryId === null) {
      delete set.pendingRecoveryId;
      unset.pendingRecoveryId = "";
    }
    if (changes.pendingRecoveryCompleted === null) {
      delete set.pendingRecoveryCompleted;
      unset.pendingRecoveryCompleted = "";
    }
    if (changes.pendingExpectedWipOid === null) {
      delete set.pendingExpectedWipOid;
      unset.pendingExpectedWipOid = "";
    }
    if (changes.pendingExpectedRevision === null) {
      delete set.pendingExpectedRevision;
      unset.pendingExpectedRevision = "";
    }
    if (changes.pendingSuccessRef === null) {
      delete set.pendingSuccessRef;
      unset.pendingSuccessRef = "";
    }
    if (changes.recoveryRef === null) {
      delete set.recoveryRef;
      unset.recoveryRef = "";
    }
    const session = await AppV2Session.findOneAndUpdate(
      {
        ...sessionCasFilter(record),
        ...activeOperationFilter(operationId),
      },
      {
        ...(Object.keys(set).length > 0 ? { $set: set } : {}),
        ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
        $inc: { generation: 1 },
      },
      { new: true },
    );
    if (!session) {
      throw new AppV2OperationConflictError(
        "Session operation ownership changed; retry later",
      );
    }
    return sessionRecord(session);
  }
}

export function appV2PendingRecoveryId(
  sessionId: string,
  operationId: string,
): string {
  return createHash("sha256")
    .update(`mako-apps-v2-recovery\0${sessionId}\0${operationId}`)
    .digest("hex");
}

export interface EnsuredAppV2Session {
  session: AppV2SessionRecord;
  worktree: IAppV2Worktree;
}

export interface AppV2SessionLifecycleResult extends EnsuredAppV2Session {
  flush: SessionFlushResult;
}

export class AppV2SessionService {
  constructor(
    private readonly providerName: string,
    private readonly executor: SessionExecutor,
    private readonly worktrees = new AppV2WorktreeService(),
    private readonly store: AppV2SessionStore = new MongoAppV2SessionStore(),
    private readonly mutex: AppV2KeyedMutex = appV2SessionOperationMutex,
    private readonly operationLeaseMs = APP_V2_SESSION_OPERATION_LEASE_MS,
  ) {
    if (!Number.isSafeInteger(operationLeaseMs) || operationLeaseMs < 3) {
      throw new Error("Apps v2 operation lease must be at least 3ms");
    }
  }

  get(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
  ): Promise<AppV2SessionRecord> {
    return this.locked(project, worktree, actor, async () => {
      const session = await this.requireSession(project, worktree, actor);
      if (session.recoveryRef) return session;
      return this.withOperation(session, async context => {
        const currentWorktree = await this.reconcilePendingRecovery(
          project,
          worktree,
          actor,
          context,
        );
        if (
          context.record.recoveryRef ||
          ["unsynced", "revoked", "provisioning"].includes(
            context.record.status,
          )
        ) {
          return context.record;
        }
        const status = await this.executor.status(
          this.target(project, currentWorktree, actor, context.record),
          context.signal,
        );
        context.assertHealthy();
        if (status === "missing") {
          return this.write(context, {
            status: "error",
            lastActiveAt: new Date(),
          });
        }
        const metadataStatus = status === "running" ? "active" : "paused";
        return context.record.status === metadataStatus
          ? context.record
          : this.write(context, {
              status: metadataStatus,
              lastActiveAt: new Date(),
            });
      });
    });
  }

  ensure(
    project: IAppV2Project,
    initialWorktree: IAppV2Worktree,
    actor: AppV2Actor,
  ): Promise<EnsuredAppV2Session> {
    return this.locked(project, initialWorktree, actor, async () => {
      const existing = await this.find(project, initialWorktree, actor);
      if (existing?.recoveryRef) this.throwRecoveryConflict(existing);
      if (!existing) {
        const operationId = randomUUID();
        const reservationId = randomUUID();
        const reservation = await this.store.reserve(
          {
            workspaceId: project.workspaceId.toString(),
            projectId: project._id.toString(),
            worktreeId: initialWorktree._id.toString(),
            actorId: actor.userId,
            purpose: "dev",
            provider: this.providerName,
            sandboxId: `reservation:${reservationId}`,
            reservationId,
            leaseEpoch: initialWorktree.leaseEpoch,
            appliedWipOid: initialWorktree.wipOid,
            status: "provisioning",
            lastActiveAt: new Date(),
          },
          operationId,
          this.operationLeaseMs,
        );
        return this.runOwnedOperation(reservation, operationId, context =>
          this.prepareAndInstall(project, initialWorktree, actor, context),
        );
      }
      return this.withOperation(existing, async context => {
        let worktree = await this.reconcilePendingRecovery(
          project,
          initialWorktree,
          actor,
          context,
        );
        this.assertNoRecoveryConflict(context.record);
        if (context.record.status === "unsynced") {
          return { session: context.record, worktree };
        }

        if (context.record.status === "provisioning") {
          await this.cleanupReservation(context);
          await this.beginProvisioning(context, worktree.leaseEpoch);
          return this.prepareAndInstall(project, worktree, actor, context);
        }
        if (
          context.record.status === "destroyed" ||
          context.record.status === "revoked"
        ) {
          await this.beginProvisioning(context, worktree.leaseEpoch);
          return this.prepareAndInstall(project, worktree, actor, context);
        }

        const status = await this.executor.status(
          this.target(project, worktree, actor, context.record),
          context.signal,
        );
        context.assertHealthy();
        if (
          status !== "missing" &&
          context.record.leaseEpoch === worktree.leaseEpoch
        ) {
          const metadataStatus = status === "running" ? "active" : "paused";
          const session =
            context.record.status === metadataStatus
              ? context.record
              : await this.write(context, {
                  status: metadataStatus,
                  lastActiveAt: new Date(),
                });
          return { session, worktree };
        }

        worktree = await this.rotateLease(project, worktree);
        context.assertHealthy();
        await this.executor
          .kill(
            this.target(project, initialWorktree, actor, context.record),
            context.signal,
          )
          .catch(() => undefined);
        context.assertHealthy();
        await this.beginProvisioning(context, worktree.leaseEpoch);
        return this.prepareAndInstall(project, worktree, actor, context);
      });
    });
  }

  exec(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
    request: SessionExecRequest,
  ): Promise<SessionExecResult> {
    return this.locked(project, worktree, actor, async () => {
      const session = await this.requireActive(project, worktree, actor);
      return this.withOperation(session, async context => {
        const currentWorktree = await this.reconcilePendingRecovery(
          project,
          worktree,
          actor,
          context,
        );
        this.assertNoRecoveryConflict(context.record);
        const recoveryId = appV2PendingRecoveryId(
          context.record.id,
          context.operationId,
        );
        const recoveryTarget = this.target(
          project,
          currentWorktree,
          actor,
          context.record,
          recoveryId,
        );
        const recoveryIdentity = this.executor.recoveryIdentity(
          recoveryTarget,
          recoveryId,
        );
        await this.write(context, {
          pendingRecoveryId: recoveryId,
          pendingRecoveryCompleted: false,
          pendingExpectedWipOid: currentWorktree.wipOid,
          pendingExpectedRevision: currentWorktree.revision,
          pendingSuccessRef: recoveryIdentity.successRef,
        });
        try {
          const result = await this.executor.exec(recoveryTarget, {
            ...request,
            signal: this.combineSignals(request.signal, context.signal),
          });
          context.assertHealthy();
          await this.write(context, { pendingRecoveryCompleted: true });
          await this.write(
            context,
            result.durability.status === "durable"
              ? {
                  appliedWipOid: result.durability.revision.wipOid,
                  pendingRecoveryId: null,
                  pendingRecoveryCompleted: null,
                  pendingExpectedWipOid: null,
                  pendingExpectedRevision: null,
                  pendingSuccessRef: null,
                  status: "active",
                  lastActiveAt: new Date(),
                }
              : {
                  pendingRecoveryId: null,
                  pendingRecoveryCompleted: null,
                  pendingExpectedWipOid: null,
                  pendingExpectedRevision: null,
                  pendingSuccessRef: null,
                  status: "conflict",
                  recoveryRef: result.durability.recoveryRef,
                  lastActiveAt: new Date(),
                },
          );
          if (result.durability.status === "durable") {
            await this.executor
              .clearSuccessMarker(
                recoveryTarget,
                recoveryId,
                result.durability.revision.wipOid,
              )
              .catch(() => undefined);
          }
          return result;
        } catch (error) {
          await this.markUnsynced(context);
          context.assertHealthy();
          throw error;
        }
      });
    });
  }

  flush(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
  ): Promise<AppV2SessionLifecycleResult> {
    return this.locked(project, worktree, actor, async () => {
      const session = await this.requireCurrent(project, worktree, actor);
      return this.withOperation(session, async context => {
        const currentWorktree = await this.reconcilePendingRecovery(
          project,
          worktree,
          actor,
          context,
        );
        this.assertNoRecoveryConflict(context.record);
        return this.flushOwned(project, currentWorktree, actor, context);
      });
    });
  }

  pause(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
  ): Promise<AppV2SessionLifecycleResult> {
    return this.locked(project, worktree, actor, async () => {
      const session = await this.requireCurrent(project, worktree, actor, true);
      return this.withOperation(session, async context => {
        const currentWorktree = await this.reconcilePendingRecovery(
          project,
          worktree,
          actor,
          context,
        );
        if (context.record.recoveryRef) {
          await this.executor.pause(
            this.target(project, currentWorktree, actor, context.record),
            context.signal,
          );
          context.assertHealthy();
          const retained = await this.write(context, {
            lastActiveAt: new Date(),
          });
          return {
            session: retained,
            worktree: currentWorktree,
            flush: this.recoveryFlush(context.record.recoveryRef),
          };
        }
        const flushed = await this.flushOwned(
          project,
          currentWorktree,
          actor,
          context,
        );
        await this.executor.pause(
          this.target(project, flushed.worktree, actor, context.record),
          context.signal,
        );
        context.assertHealthy();
        if (flushed.flush.durability.status === "conflict") return flushed;
        return {
          ...flushed,
          session: await this.write(context, {
            status: "paused",
            lastActiveAt: new Date(),
          }),
        };
      });
    });
  }

  destroy(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
  ): Promise<AppV2SessionLifecycleResult> {
    return this.locked(project, worktree, actor, async () => {
      const session = await this.requireCurrent(project, worktree, actor, true);
      return this.withOperation(session, async context => {
        const currentWorktree = await this.reconcilePendingRecovery(
          project,
          worktree,
          actor,
          context,
        );
        const flushed = context.record.recoveryRef
          ? {
              session: context.record,
              worktree: currentWorktree,
              flush: this.recoveryFlush(context.record.recoveryRef),
            }
          : await this.flushOwned(project, currentWorktree, actor, context);
        if (
          flushed.flush.durability.status === "conflict" &&
          !session.recoveryRef
        ) {
          return flushed;
        }
        const rotated = await this.rotateLease(project, flushed.worktree);
        context.assertHealthy();
        await this.write(context, {
          status: "error",
          leaseEpoch: rotated.leaseEpoch,
          lastActiveAt: new Date(),
        });
        await this.executor.kill(
          this.target(project, rotated, actor, context.record),
          context.signal,
        );
        context.assertHealthy();
        const destroyed = await this.write(context, {
          status: "destroyed",
          lastActiveAt: new Date(),
        });
        return { ...flushed, session: destroyed, worktree: rotated };
      });
    });
  }

  private async prepareAndInstall(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
    context: OperationContext,
  ): Promise<EnsuredAppV2Session> {
    let provisionedSandboxId: string | undefined;
    const prepared = await this.executor.prepare(
      {
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        worktreeId: worktree._id.toString(),
        actorId: actor.userId,
        memberRole: actor.memberRole,
        purpose: "dev",
        leaseEpoch: worktree.leaseEpoch,
        durableRevision: {
          wipOid: worktree.wipOid,
          revision: worktree.revision,
        },
      },
      {
        reservationId: context.record.reservationId,
        signal: context.signal,
        onProvisioned: async sandboxId => {
          provisionedSandboxId = sandboxId;
          context.assertHealthy();
          await this.write(context, {
            sandboxId,
            lastActiveAt: new Date(),
          });
        },
      },
    );
    try {
      context.assertHealthy();
      context.record = await this.store.install(
        {
          workspaceId: project.workspaceId.toString(),
          projectId: project._id.toString(),
          worktreeId: worktree._id.toString(),
          actorId: actor.userId,
          purpose: "dev",
          provider: this.providerName,
          sandboxId: prepared.sandboxId,
          reservationId: context.record.reservationId,
          leaseEpoch: worktree.leaseEpoch,
          appliedWipOid: prepared.appliedRevision.wipOid,
          status: "active",
          lastActiveAt: new Date(),
        },
        context.record,
        context.operationId,
      );
      context.assertHealthy();
      return { session: context.record, worktree };
    } catch (error) {
      const sandboxId = provisionedSandboxId ?? prepared.sandboxId;
      await this.executor
        .kill({
          workspaceId: project.workspaceId.toString(),
          projectId: project._id.toString(),
          worktreeId: worktree._id.toString(),
          actorId: actor.userId,
          memberRole: actor.memberRole,
          purpose: "dev",
          sandboxId,
          leaseEpoch: worktree.leaseEpoch,
          durableRevision: {
            wipOid: worktree.wipOid,
            revision: worktree.revision,
          },
          appliedWipOid: prepared.appliedRevision.wipOid,
        })
        .catch(() => undefined);
      throw error;
    }
  }

  private async beginProvisioning(
    context: OperationContext,
    leaseEpoch: number,
  ): Promise<void> {
    const reservationId = randomUUID();
    await this.write(context, {
      reservationId,
      sandboxId: `reservation:${reservationId}`,
      leaseEpoch,
      reservationCleaned: false,
      status: "provisioning",
      lastActiveAt: new Date(),
    });
  }

  private async cleanupReservation(context: OperationContext): Promise<void> {
    if (context.record.reservationCleaned) return;
    await this.executor.cleanupProvisioning(
      this.reservation(context.record),
      context.signal,
    );
    context.assertHealthy();
    await this.write(context, {
      reservationCleaned: true,
      lastActiveAt: new Date(),
    });
  }

  private reservation(session: AppV2SessionRecord): ProvisioningReservation {
    return {
      workspaceId: session.workspaceId,
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      actorId: session.actorId,
      purpose: session.purpose,
      reservationId: session.reservationId,
      sandboxId: session.sandboxId,
    };
  }

  private async flushOwned(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
    context: OperationContext,
  ): Promise<AppV2SessionLifecycleResult> {
    const recoveryId = appV2PendingRecoveryId(
      context.record.id,
      context.operationId,
    );
    const recoveryTarget = this.target(
      project,
      worktree,
      actor,
      context.record,
      recoveryId,
    );
    const recoveryIdentity = this.executor.recoveryIdentity(
      recoveryTarget,
      recoveryId,
    );
    await this.write(context, {
      pendingRecoveryId: recoveryId,
      pendingRecoveryCompleted: false,
      pendingExpectedWipOid: worktree.wipOid,
      pendingExpectedRevision: worktree.revision,
      pendingSuccessRef: recoveryIdentity.successRef,
    });
    try {
      const flush = await this.executor.flush(recoveryTarget, context.signal);
      context.assertHealthy();
      await this.write(context, { pendingRecoveryCompleted: true });
      await this.write(
        context,
        flush.durability.status === "durable"
          ? {
              appliedWipOid: flush.durability.revision.wipOid,
              pendingRecoveryId: null,
              pendingRecoveryCompleted: null,
              pendingExpectedWipOid: null,
              pendingExpectedRevision: null,
              pendingSuccessRef: null,
              status: "active",
              lastActiveAt: new Date(),
            }
          : {
              pendingRecoveryId: null,
              pendingRecoveryCompleted: null,
              pendingExpectedWipOid: null,
              pendingExpectedRevision: null,
              pendingSuccessRef: null,
              status: "conflict",
              recoveryRef: flush.durability.recoveryRef,
              lastActiveAt: new Date(),
            },
      );
      const updatedWorktree =
        flush.durability.status === "durable"
          ? await this.worktrees.getById(
              project,
              worktree._id.toString(),
              actor,
            )
          : worktree;
      context.assertHealthy();
      if (flush.durability.status === "durable") {
        await this.executor
          .clearSuccessMarker(
            recoveryTarget,
            recoveryId,
            flush.durability.revision.wipOid,
          )
          .catch(() => undefined);
      }
      return {
        session: context.record,
        worktree: updatedWorktree,
        flush,
      };
    } catch (error) {
      await this.markUnsynced(context);
      context.assertHealthy();
      throw error;
    }
  }

  private async reconcilePendingRecovery(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
    context: OperationContext,
  ): Promise<IAppV2Worktree> {
    const pendingRecoveryId = context.record.pendingRecoveryId;
    if (!pendingRecoveryId) return worktree;
    const target = this.target(project, worktree, actor, context.record);
    const successRef =
      context.record.pendingSuccessRef ??
      this.executor.recoveryIdentity(target, pendingRecoveryId).successRef;
    const recovery = await this.executor.reconcileRecovery(target, {
      recoveryId: pendingRecoveryId,
      expectedWipOid:
        context.record.pendingExpectedWipOid ?? context.record.appliedWipOid,
      expectedRevision:
        context.record.pendingExpectedRevision ?? worktree.revision,
      successRef,
    });
    context.assertHealthy();
    if (recovery.status === "durable") {
      const updatedWorktree = await this.worktrees.getById(
        project,
        worktree._id.toString(),
        actor,
      );
      if (
        updatedWorktree.wipOid !== recovery.revision.wipOid ||
        updatedWorktree.revision !== recovery.revision.revision
      ) {
        throw new AppV2OperationConflictError(
          "Recovered worktree projection does not match the Git success marker",
        );
      }
      await this.write(context, {
        appliedWipOid: recovery.revision.wipOid,
        pendingRecoveryId: null,
        pendingRecoveryCompleted: null,
        pendingExpectedWipOid: null,
        pendingExpectedRevision: null,
        pendingSuccessRef: null,
        status: "active",
        lastActiveAt: new Date(),
      });
      await this.executor
        .clearSuccessMarker(
          this.target(project, updatedWorktree, actor, context.record),
          pendingRecoveryId,
          recovery.revision.wipOid,
        )
        .catch(() => undefined);
      return updatedWorktree;
    }
    if (recovery.status === "conflict") {
      await this.write(context, {
        pendingRecoveryId: null,
        pendingRecoveryCompleted: null,
        pendingExpectedWipOid: null,
        pendingExpectedRevision: null,
        pendingSuccessRef: null,
        recoveryRef: recovery.recoveryRef,
        status: "conflict",
        lastActiveAt: new Date(),
      });
      return worktree;
    }
    if (!context.record.pendingRecoveryCompleted) {
      throw new AppV2OperationConflictError(
        "Session recovery reconciliation is still pending; retry later",
      );
    }
    await this.write(context, {
      pendingRecoveryId: null,
      pendingRecoveryCompleted: null,
      pendingExpectedWipOid: null,
      pendingExpectedRevision: null,
      pendingSuccessRef: null,
      lastActiveAt: new Date(),
    });
    return worktree;
  }

  private async markUnsynced(context: OperationContext): Promise<void> {
    try {
      context.assertHealthy();
      await this.write(context, {
        pendingRecoveryCompleted: true,
        status: "unsynced",
        lastActiveAt: new Date(),
      });
    } catch {
      // The pending recovery intent remains discoverable after lease loss.
    }
  }

  private async write(
    context: OperationContext,
    changes: AppV2SessionChanges,
  ): Promise<AppV2SessionRecord> {
    context.assertHealthy();
    context.record = await this.store.update(
      context.record,
      changes,
      context.operationId,
    );
    context.assertHealthy();
    return context.record;
  }

  private recoveryFlush(recoveryRef: string): SessionFlushResult {
    return {
      excludedPaths: [],
      durability: { status: "conflict", recoveryRef },
    };
  }

  private find(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
  ): Promise<AppV2SessionRecord | null> {
    return this.store.find(
      project.workspaceId.toString(),
      project._id.toString(),
      worktree._id.toString(),
      actor.userId,
      "dev",
    );
  }

  private async requireSession(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
  ): Promise<AppV2SessionRecord> {
    const session = await this.find(project, worktree, actor);
    if (
      !session ||
      session.status === "revoked" ||
      session.status === "destroyed"
    ) {
      throw new AppV2NotFoundError("Session not found");
    }
    return session;
  }

  private async requireCurrent(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
    allowRecovery = false,
  ): Promise<AppV2SessionRecord> {
    const session = await this.requireSession(project, worktree, actor);
    if (
      session.leaseEpoch !== worktree.leaseEpoch ||
      ![
        "active",
        "paused",
        "unsynced",
        "conflict",
        "provisioning",
        "error",
      ].includes(session.status)
    ) {
      throw new AppV2ConflictError("Session lease is stale");
    }
    if (!allowRecovery) this.assertNoRecoveryConflict(session);
    return session;
  }

  private async requireActive(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
  ): Promise<AppV2SessionRecord> {
    const session = await this.requireCurrent(project, worktree, actor);
    if (!["active", "paused"].includes(session.status)) {
      throw new AppV2ConflictError(
        "Session has unsynced changes; flush before executing",
      );
    }
    return session;
  }

  private assertNoRecoveryConflict(session: AppV2SessionRecord): void {
    if (session.recoveryRef) this.throwRecoveryConflict(session);
  }

  private throwRecoveryConflict(session: AppV2SessionRecord): never {
    throw new AppV2RecoveryConflictError(
      "Session has a retained recovery ref and requires explicit recovery",
      session.recoveryRef ?? "",
    );
  }

  private rotateLease(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
  ): Promise<IAppV2Worktree> {
    return this.worktrees.rotateLease(project, worktree, {
      ifRevision: worktree.revision,
      expectedWipOid: worktree.wipOid,
      leaseEpoch: worktree.leaseEpoch,
    });
  }

  private target(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
    session: AppV2SessionRecord,
    recoveryId?: string,
  ): SessionExecutionTarget {
    return {
      workspaceId: project.workspaceId.toString(),
      projectId: project._id.toString(),
      worktreeId: worktree._id.toString(),
      actorId: actor.userId,
      memberRole: actor.memberRole,
      purpose: session.purpose,
      sandboxId: session.sandboxId,
      leaseEpoch: session.leaseEpoch,
      durableRevision: {
        wipOid: worktree.wipOid,
        revision: worktree.revision,
      },
      appliedWipOid: session.appliedWipOid,
      recoveryId,
    };
  }

  private withOperation<T>(
    session: AppV2SessionRecord,
    operation: (context: OperationContext) => Promise<T>,
  ): Promise<T> {
    const operationId = randomUUID();
    return this.store
      .acquireOperation(session, operationId, this.operationLeaseMs)
      .then(owned => this.runOwnedOperation(owned, operationId, operation));
  }

  private async runOwnedOperation<T>(
    owned: AppV2SessionRecord,
    operationId: string,
    operation: (context: OperationContext) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let renewalError: AppV2OperationConflictError | undefined;
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let renewal: Promise<void> | undefined;
    const intervalMs = Math.max(1, Math.floor(this.operationLeaseMs / 3));
    const context: OperationContext = {
      record: owned,
      operationId,
      signal: controller.signal,
      assertHealthy: () => {
        if (renewalError) throw renewalError;
      },
    };
    const schedule = (): void => {
      if (stopped) return;
      timer = setTimeout(() => {
        renewal = this.store
          .renewOperation(owned, operationId, this.operationLeaseMs)
          .catch(error => {
            renewalError =
              error instanceof AppV2OperationConflictError
                ? error
                : new AppV2OperationConflictError(
                    `Session operation lease renewal failed: ${
                      error instanceof Error ? error.message : "unknown error"
                    }`,
                  );
            controller.abort(renewalError);
          })
          .finally(schedule);
      }, intervalMs);
      timer.unref();
    };
    const stop = async (): Promise<void> => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await renewal;
    };

    schedule();
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation(context);
    } catch (error) {
      operationError = error;
    }
    await stop();
    try {
      if (renewalError) throw renewalError;
      if (operationError) throw operationError;
      await this.store.assertOperation(context.record, operationId);
      return result as T;
    } finally {
      await this.store.releaseOperation(context.record, operationId);
    }
  }

  private combineSignals(
    requestSignal: AbortSignal | undefined,
    operationSignal: AbortSignal,
  ): AbortSignal {
    return requestSignal
      ? AbortSignal.any([requestSignal, operationSignal])
      : operationSignal;
  }

  private locked<T>(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    actor: AppV2Actor,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.mutex.run(
      appV2SessionOperationKey({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        worktreeId: worktree._id.toString(),
        actorId: actor.userId,
        purpose: "dev",
      }),
      operation,
    );
  }
}
