import { randomUUID } from "node:crypto";
import { APP_V2_SESSION_OPERATION_LEASE_MS } from "./config";
import { AppV2OperationConflictError } from "./errors";
import type { SessionExecutor } from "./session-executor";
import {
  MongoAppV2SessionStore,
  type AppV2SessionRecord,
  type AppV2SessionStore,
} from "./session.service";

export interface AppV2ProvisioningSweepResult {
  examined: number;
  cleaned: number;
}

/**
 * Callable stale-provisioning sweep. Scheduling is intentionally left to a
 * future Inngest function; ensure retries use the same reservation cleanup.
 */
export class AppV2ProvisioningReconcileService {
  constructor(
    private readonly executor: SessionExecutor,
    private readonly store: AppV2SessionStore = new MongoAppV2SessionStore(),
    private readonly operationLeaseMs = APP_V2_SESSION_OPERATION_LEASE_MS,
  ) {}

  async sweep(limit = 100): Promise<AppV2ProvisioningSweepResult> {
    const records = await this.store.listStaleProvisioning(limit);
    let cleaned = 0;
    for (const record of records) {
      try {
        await this.clean(record);
        cleaned += 1;
      } catch (error) {
        if (error instanceof AppV2OperationConflictError) continue;
        throw error;
      }
    }
    return { examined: records.length, cleaned };
  }

  private async clean(record: AppV2SessionRecord): Promise<void> {
    const operationId = randomUUID();
    const owned = await this.store.acquireOperation(
      record,
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
      await this.executor.cleanupProvisioning(
        {
          workspaceId: owned.workspaceId,
          projectId: owned.projectId,
          worktreeId: owned.worktreeId,
          actorId: owned.actorId,
          purpose: owned.purpose,
          reservationId: owned.reservationId,
          sandboxId: owned.sandboxId,
        },
        controller.signal,
      );
      if (renewalError) throw renewalError;
      await this.store.assertOperation(owned, operationId);
      await this.store.update(
        owned,
        { status: "error", lastActiveAt: new Date() },
        operationId,
      );
      if (renewalError) throw renewalError;
    } finally {
      stopped = true;
      if (heartbeat) clearTimeout(heartbeat);
      await renewal;
      await this.store.releaseOperation(owned, operationId);
    }
  }
}
