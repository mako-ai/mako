import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { AppV2Session, type IAppV2Session } from "../database/workspace-schema";
import {
  AppV2ConflictError,
  AppV2OperationConflictError,
  AppV2ProviderUnavailableError,
} from "./errors";
import { createAppsV2SandboxProvider } from "./providers/sandbox-provider-factory";
import type { SandboxProvider } from "./providers/sandbox-provider";
import { APP_V2_SESSION_OPERATION_LEASE_MS } from "./config";
import type { AppV2SessionRecord } from "./session.service";
import {
  appV2SessionOperationKey,
  appV2SessionOperationMutex,
  type AppV2KeyedMutex,
} from "./session-operation-lock";

export interface AppV2ProjectSessionCleanup {
  revokeAndKill(workspaceId: string, projectId: string): Promise<void>;
}

export interface AppV2ProjectSessionCleanupStore {
  listProject(
    workspaceId: string,
    projectId: string,
  ): Promise<AppV2SessionRecord[]>;
  find(record: AppV2SessionRecord): Promise<AppV2SessionRecord | null>;
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
  revoke(record: AppV2SessionRecord, operationId: string): Promise<void>;
}

function cleanupRecord(session: IAppV2Session): AppV2SessionRecord {
  return {
    id: session._id.toString(),
    workspaceId: session.workspaceId.toString(),
    projectId: session.projectId.toString(),
    worktreeId: session.worktreeId.toString(),
    actorId: session.actorId,
    purpose: session.purpose,
    provider: session.provider,
    sandboxId: session.sandboxId,
    reservationId: session.reservationId,
    reservationCleaned: session.reservationCleaned,
    generation: session.generation,
    operationId: session.operationId,
    operationExpiresAt: session.operationExpiresAt,
    leaseEpoch: session.leaseEpoch,
    appliedWipOid: session.appliedWipOid,
    pendingRecoveryId: session.pendingRecoveryId,
    pendingRecoveryCompleted: session.pendingRecoveryCompleted,
    pendingExpectedWipOid: session.pendingExpectedWipOid,
    pendingExpectedRevision: session.pendingExpectedRevision,
    pendingSuccessRef: session.pendingSuccessRef,
    recoveryRef: session.recoveryRef,
    status: session.status,
    lastActiveAt: session.lastActiveAt,
  };
}

export class MongoAppV2ProjectSessionCleanupStore
  implements AppV2ProjectSessionCleanupStore
{
  async listProject(
    workspaceId: string,
    projectId: string,
  ): Promise<AppV2SessionRecord[]> {
    const sessions = await AppV2Session.find({
      workspaceId: new Types.ObjectId(workspaceId),
      projectId: new Types.ObjectId(projectId),
      status: { $nin: ["destroyed", "revoked"] },
    });
    return sessions.map(cleanupRecord);
  }

  async find(record: AppV2SessionRecord): Promise<AppV2SessionRecord | null> {
    const current = await AppV2Session.findOne({
      _id: new Types.ObjectId(record.id),
      workspaceId: new Types.ObjectId(record.workspaceId),
      projectId: new Types.ObjectId(record.projectId),
      worktreeId: new Types.ObjectId(record.worktreeId),
      actorId: record.actorId,
      purpose: record.purpose,
    });
    return current ? cleanupRecord(current) : null;
  }

  async acquireOperation(
    record: AppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<AppV2SessionRecord> {
    const current = await AppV2Session.findOneAndUpdate(
      {
        _id: new Types.ObjectId(record.id),
        workspaceId: new Types.ObjectId(record.workspaceId),
        projectId: new Types.ObjectId(record.projectId),
        worktreeId: new Types.ObjectId(record.worktreeId),
        actorId: record.actorId,
        purpose: record.purpose,
        sandboxId: record.sandboxId,
        generation: record.generation,
        leaseEpoch: record.leaseEpoch,
        status: record.status,
        $or: [
          { operationId: { $exists: false } },
          { operationId: null },
          { $expr: { $lte: ["$operationExpiresAt", "$$NOW"] } },
        ],
      },
      [
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
      ],
      { new: true },
    );
    if (!current) {
      throw new AppV2OperationConflictError(
        "Session cleanup is blocked by an active operation; retry later",
      );
    }
    return cleanupRecord(current);
  }

  async renewOperation(
    record: AppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<void> {
    const current = await AppV2Session.findOneAndUpdate(
      {
        _id: new Types.ObjectId(record.id),
        workspaceId: new Types.ObjectId(record.workspaceId),
        projectId: new Types.ObjectId(record.projectId),
        worktreeId: new Types.ObjectId(record.worktreeId),
        actorId: record.actorId,
        purpose: record.purpose,
        operationId,
        $expr: { $gt: ["$operationExpiresAt", "$$NOW"] },
      },
      [
        {
          $set: {
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
      { new: true },
    );
    if (!current) {
      throw new AppV2OperationConflictError(
        "Session cleanup lease renewal failed",
      );
    }
  }

  async assertOperation(
    record: AppV2SessionRecord,
    operationId: string,
  ): Promise<void> {
    const current = await AppV2Session.exists({
      _id: new Types.ObjectId(record.id),
      workspaceId: new Types.ObjectId(record.workspaceId),
      projectId: new Types.ObjectId(record.projectId),
      worktreeId: new Types.ObjectId(record.worktreeId),
      actorId: record.actorId,
      purpose: record.purpose,
      operationId,
      $expr: { $gt: ["$operationExpiresAt", "$$NOW"] },
    });
    if (!current) {
      throw new AppV2OperationConflictError(
        "Session cleanup lease is no longer owned",
      );
    }
  }

  async releaseOperation(
    record: AppV2SessionRecord,
    operationId: string,
  ): Promise<void> {
    await AppV2Session.updateOne(
      {
        _id: new Types.ObjectId(record.id),
        workspaceId: new Types.ObjectId(record.workspaceId),
        projectId: new Types.ObjectId(record.projectId),
        worktreeId: new Types.ObjectId(record.worktreeId),
        actorId: record.actorId,
        purpose: record.purpose,
        operationId,
      },
      { $unset: { operationId: "", operationExpiresAt: "" } },
    );
  }

  async revoke(record: AppV2SessionRecord, operationId: string): Promise<void> {
    const revoked = await AppV2Session.findOneAndUpdate(
      {
        _id: new Types.ObjectId(record.id),
        workspaceId: new Types.ObjectId(record.workspaceId),
        projectId: new Types.ObjectId(record.projectId),
        worktreeId: new Types.ObjectId(record.worktreeId),
        actorId: record.actorId,
        purpose: record.purpose,
        sandboxId: record.sandboxId,
        generation: record.generation,
        leaseEpoch: record.leaseEpoch,
        status: record.status,
        operationId,
        $expr: { $gt: ["$operationExpiresAt", "$$NOW"] },
      },
      {
        $set: { status: "revoked", lastActiveAt: new Date() },
        $inc: { generation: 1 },
      },
      { new: true },
    );
    if (!revoked) {
      throw new AppV2ConflictError(
        "Session changed while project deletion was cleaning it up",
      );
    }
  }
}

export class AppV2ProjectSessionCleanupService
  implements AppV2ProjectSessionCleanup
{
  constructor(
    private readonly providerFactory: () =>
      | SandboxProvider
      | undefined = createAppsV2SandboxProvider,
    private readonly mutex: AppV2KeyedMutex = appV2SessionOperationMutex,
    private readonly store: AppV2ProjectSessionCleanupStore = new MongoAppV2ProjectSessionCleanupStore(),
    private readonly operationLeaseMs = APP_V2_SESSION_OPERATION_LEASE_MS,
  ) {}

  async revokeAndKill(workspaceId: string, projectId: string): Promise<void> {
    const sessions = await this.store.listProject(workspaceId, projectId);
    if (sessions.length === 0) return;
    const provider = this.providerFactory();
    if (!provider) {
      throw new AppV2ProviderUnavailableError(
        "Active sandbox sessions prevent project deletion",
      );
    }
    for (const session of sessions) {
      await this.mutex.run(
        appV2SessionOperationKey({
          workspaceId,
          projectId,
          worktreeId: session.worktreeId.toString(),
          actorId: session.actorId,
          purpose: session.purpose,
        }),
        async () => {
          const current = await this.store.find(session);
          if (!current || ["destroyed", "revoked"].includes(current.status)) {
            return;
          }
          if (current.provider !== provider.name) {
            throw new AppV2ProviderUnavailableError(
              "The active session provider is unavailable",
            );
          }
          const operationId = randomUUID();
          const owned = await this.store.acquireOperation(
            current,
            operationId,
            this.operationLeaseMs,
          );
          const controller = new AbortController();
          let renewalError: unknown;
          let stopped = false;
          let heartbeat: NodeJS.Timeout | undefined;
          let renewal: Promise<void> | undefined;
          const scheduleHeartbeat = (): void => {
            if (stopped) return;
            heartbeat = setTimeout(
              () => {
                renewal = this.store
                  .renewOperation(owned, operationId, this.operationLeaseMs)
                  .catch(error => {
                    renewalError = error;
                    controller.abort(error);
                  })
                  .finally(scheduleHeartbeat);
              },
              Math.max(1, Math.floor(this.operationLeaseMs / 3)),
            );
            heartbeat.unref();
          };
          scheduleHeartbeat();
          try {
            const matches = await provider.listByLabels(
              {
                managedBy: "mako-apps-v2",
                workspaceId: owned.workspaceId,
                projectId: owned.projectId,
                worktreeId: owned.worktreeId,
                actorId: owned.actorId,
                purpose: owned.purpose,
                reservationId: owned.reservationId,
              },
              controller.signal,
            );
            const sandboxIds = new Set(
              matches.map(sandbox => sandbox.sandboxId),
            );
            if (!owned.sandboxId.startsWith("reservation:")) {
              sandboxIds.add(owned.sandboxId);
            }
            for (const sandboxId of sandboxIds) {
              await this.killWithRetry(provider, sandboxId, controller.signal);
            }
            if (renewalError) throw renewalError;
            await this.store.assertOperation(owned, operationId);
            await this.store.revoke(owned, operationId);
            if (renewalError) throw renewalError;
          } finally {
            stopped = true;
            if (heartbeat) clearTimeout(heartbeat);
            await renewal;
            await this.store.releaseOperation(owned, operationId);
          }
        },
      );
    }
  }

  private async killWithRetry(
    provider: SandboxProvider,
    sandboxId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await provider.kill(sandboxId, signal);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new AppV2ConflictError(
      `Sandbox session cleanup must be retried: ${
        lastError instanceof Error ? lastError.message : "kill failed"
      }`,
    );
  }
}
