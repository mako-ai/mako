import assert from "node:assert/strict";
import { Types } from "mongoose";
import {
  AppV2ConflictError,
  AppV2OperationConflictError,
  AppV2ProviderUnavailableError,
} from "./errors";
import {
  AppV2ProjectSessionCleanupService,
  type AppV2ProjectSessionCleanupStore,
} from "./project-session-cleanup";
import type { AppV2SessionRecord } from "./session.service";
import { AppV2KeyedMutex } from "./session-operation-lock";
import { FakeSandboxProvider } from "./testing/fake-sandbox-provider";

class MemoryCleanupStore implements AppV2ProjectSessionCleanupStore {
  constructor(readonly records: AppV2SessionRecord[]) {}

  async listProject(
    workspaceId: string,
    projectId: string,
  ): Promise<AppV2SessionRecord[]> {
    return this.records
      .filter(
        record =>
          record.workspaceId === workspaceId &&
          record.projectId === projectId &&
          !["destroyed", "revoked"].includes(record.status),
      )
      .map(record => ({ ...record }));
  }

  async find(record: AppV2SessionRecord): Promise<AppV2SessionRecord | null> {
    const current = this.records.find(candidate => candidate.id === record.id);
    return current ? { ...current } : null;
  }

  async acquireOperation(
    record: AppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<AppV2SessionRecord> {
    const current = this.records.find(candidate => candidate.id === record.id);
    if (
      !current ||
      (current.operationId &&
        (!current.operationExpiresAt ||
          current.operationExpiresAt.getTime() > Date.now()))
    ) {
      throw new AppV2OperationConflictError("Cleanup operation conflict");
    }
    current.operationId = operationId;
    current.operationExpiresAt = new Date(Date.now() + leaseMs);
    return { ...current };
  }

  async renewOperation(
    record: AppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<void> {
    const current = this.records.find(candidate => candidate.id === record.id);
    if (
      !current ||
      current.operationId !== operationId ||
      !current.operationExpiresAt ||
      current.operationExpiresAt.getTime() <= Date.now()
    ) {
      throw new AppV2OperationConflictError("Cleanup renewal failed");
    }
    current.operationExpiresAt = new Date(Date.now() + leaseMs);
  }

  async assertOperation(
    record: AppV2SessionRecord,
    operationId: string,
  ): Promise<void> {
    const current = this.records.find(candidate => candidate.id === record.id);
    if (
      !current ||
      current.operationId !== operationId ||
      !current.operationExpiresAt ||
      current.operationExpiresAt.getTime() <= Date.now()
    ) {
      throw new AppV2OperationConflictError("Cleanup lease expired");
    }
  }

  async releaseOperation(
    record: AppV2SessionRecord,
    operationId: string,
  ): Promise<void> {
    const current = this.records.find(candidate => candidate.id === record.id);
    if (current?.operationId === operationId) {
      delete current.operationId;
      delete current.operationExpiresAt;
    }
  }

  async revoke(record: AppV2SessionRecord, operationId: string): Promise<void> {
    const index = this.records.findIndex(candidate =>
      [
        "id",
        "workspaceId",
        "projectId",
        "worktreeId",
        "actorId",
        "purpose",
        "sandboxId",
        "generation",
        "leaseEpoch",
        "status",
      ].every(
        key =>
          candidate[key as keyof AppV2SessionRecord] ===
          record[key as keyof AppV2SessionRecord],
      ),
    );
    if (index < 0) throw new AppV2ConflictError("Cleanup CAS conflict");
    if (
      this.records[index].operationId !== operationId ||
      !this.records[index].operationExpiresAt ||
      this.records[index].operationExpiresAt.getTime() <= Date.now()
    ) {
      throw new AppV2OperationConflictError("Cleanup operation was stolen");
    }
    this.records[index] = {
      ...this.records[index],
      status: "revoked",
      generation: this.records[index].generation + 1,
    };
  }
}

class RetriableFakeSandboxProvider extends FakeSandboxProvider {
  killFailuresRemaining = 0;
  killAttempts = 0;

  override async kill(sandboxId: string): Promise<void> {
    this.killAttempts += 1;
    if (this.killFailuresRemaining > 0) {
      this.killFailuresRemaining -= 1;
      throw new Error("transient provider failure");
    }
    await super.kill(sandboxId);
  }
}

async function run(): Promise<void> {
  const workspaceId = new Types.ObjectId().toString();
  const projectId = new Types.ObjectId().toString();
  const worktreeId = new Types.ObjectId().toString();
  const provider = new RetriableFakeSandboxProvider();
  const sandbox = await provider.create({
    workspaceId,
    projectId,
    worktreeId,
    actorId: "actor",
    purpose: "dev",
    leaseEpoch: 1,
    durableRevision: { wipOid: "a".repeat(40), revision: 0 },
    labels: {
      managedBy: "mako-apps-v2",
      workspaceId,
      projectId,
      worktreeId,
      actorId: "actor",
      purpose: "dev",
      reservationId: "cleanup-reservation",
    },
    async onProvisioned() {},
  });
  const store = new MemoryCleanupStore([
    {
      id: new Types.ObjectId().toString(),
      workspaceId,
      projectId,
      worktreeId,
      actorId: "actor",
      purpose: "dev",
      provider: provider.name,
      sandboxId: sandbox.sandboxId,
      reservationId: "cleanup-reservation",
      generation: 0,
      leaseEpoch: 1,
      appliedWipOid: "a".repeat(40),
      status: "active",
      lastActiveAt: new Date(),
    },
  ]);

  const unavailable = new AppV2ProjectSessionCleanupService(
    () => undefined,
    new AppV2KeyedMutex(),
    store,
  );
  await assert.rejects(
    unavailable.revokeAndKill(workspaceId, projectId),
    AppV2ProviderUnavailableError,
  );
  assert.equal(store.records[0].status, "active");

  const cleanup = new AppV2ProjectSessionCleanupService(
    () => provider,
    new AppV2KeyedMutex(),
    store,
  );
  provider.killFailuresRemaining = 3;
  await assert.rejects(
    cleanup.revokeAndKill(workspaceId, projectId),
    /must be retried/,
  );
  assert.equal(store.records[0].status, "active");
  assert.equal(provider.killAttempts, 3);

  await cleanup.revokeAndKill(workspaceId, projectId);
  assert.equal(store.records[0].status, "revoked");
  assert.equal(store.records[0].generation, 1);
  assert.equal(await provider.status(sandbox.sandboxId), "missing");
  await cleanup.revokeAndKill(workspaceId, projectId);
  assert.equal(provider.killAttempts, 4);

  const orphanReservationId = "project-delete-orphan";
  const orphan = await provider.create({
    workspaceId,
    projectId,
    worktreeId,
    actorId: "orphan-actor",
    purpose: "dev",
    leaseEpoch: 2,
    durableRevision: { wipOid: "b".repeat(40), revision: 1 },
    labels: {
      managedBy: "mako-apps-v2",
      reservationId: orphanReservationId,
    },
    async onProvisioned() {
      // Simulate a crash before the real sandbox ID reaches Mongo.
    },
  });
  store.records.push({
    id: new Types.ObjectId().toString(),
    workspaceId,
    projectId,
    worktreeId,
    actorId: "orphan-actor",
    purpose: "dev",
    provider: provider.name,
    sandboxId: `reservation:${orphanReservationId}`,
    reservationId: orphanReservationId,
    generation: 0,
    leaseEpoch: 2,
    appliedWipOid: "b".repeat(40),
    status: "provisioning",
    lastActiveAt: new Date(),
  });
  assert.equal(
    (
      await provider.listByLabels({
        managedBy: "mako-apps-v2",
        workspaceId,
        projectId,
        worktreeId,
        actorId: "orphan-actor",
        purpose: "dev",
        reservationId: orphanReservationId,
      })
    ).length,
    1,
  );
  await cleanup.revokeAndKill(workspaceId, projectId);
  assert.equal(store.records[1].status, "revoked");
  assert.equal(await provider.status(orphan.sandboxId), "missing");
}

void run();
