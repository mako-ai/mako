import { Types } from "mongoose";
import { CdcEntityLock } from "../database/workspace-schema";

export interface CdcLease {
  workspaceId: string;
  flowId: string;
  entity: string;
  ownerId: string;
  fencingToken: number;
  leasedUntil: Date;
}

export const CDC_LEASE_DURATION_MS = 60_000;
export const CDC_HEARTBEAT_INTERVAL_MS = 15_000;

export class CdcLockService {
  async acquireLease(params: {
    workspaceId: string;
    flowId: string;
    entity: string;
    ownerId: string;
  }): Promise<CdcLease | null> {
    const workspaceObjectId = new Types.ObjectId(params.workspaceId);
    const flowObjectId = new Types.ObjectId(params.flowId);
    const now = new Date();
    const leasedUntil = new Date(now.getTime() + CDC_LEASE_DURATION_MS);

    const existing = await CdcEntityLock.findOne({
      flowId: flowObjectId,
      entity: params.entity,
    });

    if (!existing) {
      try {
        const created = await CdcEntityLock.create({
          workspaceId: workspaceObjectId,
          flowId: flowObjectId,
          entity: params.entity,
          ownerId: params.ownerId,
          leasedUntil,
          heartbeatAt: now,
          fencingToken: 1,
          acquiredAt: now,
        });

        return {
          workspaceId: params.workspaceId,
          flowId: params.flowId,
          entity: params.entity,
          ownerId: params.ownerId,
          fencingToken: created.fencingToken,
          leasedUntil: created.leasedUntil,
        };
      } catch {
        // Lost race to create; continue with standard acquisition path.
      }
    }

    const isExpired = !existing || existing.leasedUntil <= now;
    const isSameOwner = existing?.ownerId === params.ownerId;
    if (!isExpired && !isSameOwner) {
      return null;
    }

    const filter = {
      flowId: flowObjectId,
      entity: params.entity,
      ...(isSameOwner
        ? { ownerId: params.ownerId }
        : { leasedUntil: { $lte: now } }),
    };

    const nextToken = isSameOwner
      ? existing?.fencingToken || 1
      : (existing?.fencingToken || 0) + 1;

    const updated = await CdcEntityLock.findOneAndUpdate(
      filter,
      {
        $set: {
          workspaceId: workspaceObjectId,
          ownerId: params.ownerId,
          leasedUntil,
          heartbeatAt: now,
          acquiredAt: isSameOwner ? existing?.acquiredAt : now,
          fencingToken: nextToken,
        },
      },
      { new: true },
    );

    if (!updated) {
      return null;
    }

    return {
      workspaceId: params.workspaceId,
      flowId: params.flowId,
      entity: params.entity,
      ownerId: params.ownerId,
      fencingToken: updated.fencingToken,
      leasedUntil: updated.leasedUntil,
    };
  }

  async heartbeat(lease: CdcLease): Promise<CdcLease | null> {
    const now = new Date();
    const leasedUntil = new Date(now.getTime() + CDC_LEASE_DURATION_MS);
    const updated = await CdcEntityLock.findOneAndUpdate(
      {
        flowId: new Types.ObjectId(lease.flowId),
        entity: lease.entity,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
      },
      {
        $set: {
          heartbeatAt: now,
          leasedUntil,
        },
      },
      { new: true },
    );

    if (!updated) {
      return null;
    }

    return {
      ...lease,
      leasedUntil: updated.leasedUntil,
    };
  }

  async release(lease: CdcLease): Promise<void> {
    await CdcEntityLock.deleteOne({
      flowId: new Types.ObjectId(lease.flowId),
      entity: lease.entity,
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
    });
  }

  async assertFencingToken(lease: CdcLease): Promise<void> {
    const lock = await CdcEntityLock.findOne({
      flowId: new Types.ObjectId(lease.flowId),
      entity: lease.entity,
    }).lean();

    if (!lock) {
      throw new Error("CDC lease lost: lock document missing");
    }

    if (lock.fencingToken !== lease.fencingToken) {
      throw new Error("CDC lease lost: fencing token mismatch");
    }

    if (lock.ownerId !== lease.ownerId) {
      throw new Error("CDC lease lost: lock owner changed");
    }

    if (lock.leasedUntil <= new Date()) {
      throw new Error("CDC lease lost: lease expired");
    }
  }

  getLeasePolicy() {
    return {
      leaseDurationMs: CDC_LEASE_DURATION_MS,
      heartbeatIntervalMs: CDC_HEARTBEAT_INTERVAL_MS,
    };
  }
}

export const cdcLockService = new CdcLockService();

export function buildLeaseOwnerId(flowId: string, entity: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `materializer:${flowId}:${entity}:${suffix}`;
}
