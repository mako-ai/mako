import assert from "node:assert/strict";
import { Types } from "mongoose";
import { AppV2OperationConflictError } from "./errors";
import { AppV2ProvisioningReconcileService } from "./provisioning-reconcile.service";
import type {
  AppV2SessionChanges,
  AppV2SessionRecord,
  AppV2SessionStore,
  NewAppV2SessionRecord,
} from "./session.service";
import { FakeSessionExecutor } from "./testing/fake-session-executor";

class SweepStore implements AppV2SessionStore {
  constructor(readonly record: AppV2SessionRecord) {}

  async find(): Promise<AppV2SessionRecord | null> {
    return { ...this.record };
  }

  async listProject(): Promise<AppV2SessionRecord[]> {
    return [{ ...this.record }];
  }

  async listStaleProvisioning(): Promise<AppV2SessionRecord[]> {
    return this.record.status === "provisioning" ? [{ ...this.record }] : [];
  }

  async reserve(
    _record: NewAppV2SessionRecord,
    _operationId: string,
    _leaseMs: number,
  ): Promise<AppV2SessionRecord> {
    throw new Error("not used");
  }

  async acquireOperation(
    _record: AppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<AppV2SessionRecord> {
    if (
      this.record.operationId &&
      this.record.operationExpiresAt &&
      this.record.operationExpiresAt.getTime() > Date.now()
    ) {
      throw new AppV2OperationConflictError("already owned");
    }
    this.record.operationId = operationId;
    this.record.operationExpiresAt = new Date(Date.now() + leaseMs);
    return { ...this.record };
  }

  async renewOperation(
    _record: AppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<void> {
    await this.assertOperation(this.record, operationId);
    this.record.operationExpiresAt = new Date(Date.now() + leaseMs);
  }

  async assertOperation(
    _record: AppV2SessionRecord,
    operationId: string,
  ): Promise<void> {
    if (
      this.record.operationId !== operationId ||
      !this.record.operationExpiresAt ||
      this.record.operationExpiresAt.getTime() <= Date.now()
    ) {
      throw new AppV2OperationConflictError("not owned");
    }
  }

  async releaseOperation(
    _record: AppV2SessionRecord,
    operationId: string,
  ): Promise<void> {
    if (this.record.operationId === operationId) {
      delete this.record.operationId;
      delete this.record.operationExpiresAt;
    }
  }

  async install(
    _record: NewAppV2SessionRecord,
    _expected: AppV2SessionRecord,
    _operationId: string,
  ): Promise<AppV2SessionRecord> {
    throw new Error("not used");
  }

  async update(
    _record: AppV2SessionRecord,
    changes: AppV2SessionChanges,
    operationId: string,
  ): Promise<AppV2SessionRecord> {
    await this.assertOperation(this.record, operationId);
    Object.assign(this.record, changes);
    this.record.generation += 1;
    return { ...this.record };
  }
}

async function run(): Promise<void> {
  const record: AppV2SessionRecord = {
    id: new Types.ObjectId().toString(),
    workspaceId: new Types.ObjectId().toString(),
    projectId: new Types.ObjectId().toString(),
    worktreeId: new Types.ObjectId().toString(),
    actorId: "actor",
    purpose: "dev",
    provider: "fake",
    sandboxId: "reservation:stale-reservation",
    reservationId: "stale-reservation",
    generation: 0,
    leaseEpoch: 1,
    appliedWipOid: "a".repeat(40),
    status: "provisioning",
    lastActiveAt: new Date(),
  };
  const store = new SweepStore(record);
  const executor = new FakeSessionExecutor();
  const reconciler = new AppV2ProvisioningReconcileService(executor, store, 30);
  const result = await reconciler.sweep();
  assert.deepEqual(result, { examined: 1, cleaned: 1 });
  assert.equal(executor.cleanedReservations.length, 1);
  assert.equal(
    executor.cleanedReservations[0].reservationId,
    "stale-reservation",
  );
  assert.equal(record.status, "error");
  assert.equal(record.operationId, undefined);

  const repeated = await reconciler.sweep();
  assert.deepEqual(repeated, { examined: 0, cleaned: 0 });
  assert.equal(executor.cleanedReservations.length, 1);
}

void run();
