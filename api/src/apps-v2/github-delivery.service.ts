import { randomUUID } from "node:crypto";
import {
  AppV2GitHubDelivery,
  type IAppV2GitHubDelivery,
} from "../database/workspace-schema";
import { inngest } from "../inngest/client";
import { handleAppsV2GitHubPushEvent } from "./github-push.service";

export const APP_V2_GITHUB_DELIVERY_LEASE_MS = 5 * 60_000;

export interface AppV2GitHubPushDeliveryInput {
  deliveryId: string;
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
  after?: string;
}

export async function enqueueAppsV2GitHubPushDelivery(
  input: AppV2GitHubPushDeliveryInput,
): Promise<{ enqueued: boolean; duplicate: boolean }> {
  const existing = await AppV2GitHubDelivery.findOneAndUpdate(
    { deliveryId: input.deliveryId },
    {
      $setOnInsert: {
        ...input,
        event: "push",
        status: "pending",
        attempts: 0,
        receivedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  if (!existing) throw new Error("Failed to persist GitHub delivery");
  if (existing.status === "completed") {
    return { enqueued: false, duplicate: true };
  }
  if (existing.status === "failed") {
    await AppV2GitHubDelivery.updateOne(
      { _id: existing._id, status: "failed" },
      {
        $set: { status: "pending" },
        $unset: {
          error: 1,
          processedAt: 1,
          leaseToken: 1,
          expiresAt: 1,
        },
      },
    );
  }
  await inngest.send({
    id: `apps-v2-github:${input.deliveryId}`,
    name: "apps-v2/github.push",
    data: { deliveryId: input.deliveryId },
  });
  return {
    enqueued: true,
    duplicate: existing.createdAt.getTime() !== existing.updatedAt.getTime(),
  };
}

export async function processAppsV2GitHubDelivery(
  deliveryId: string,
  dependencies: {
    createLeaseToken?: () => string;
    now?: () => Date;
  } = {},
): Promise<{ processed: boolean; conflicts?: number }> {
  const claim = await claimAppsV2GitHubDelivery(deliveryId, dependencies);
  if (!claim) return { processed: false };
  const { delivery, leaseToken } = claim;

  try {
    const result = await handleAppsV2GitHubPushEvent({
      owner: delivery.owner,
      repo: delivery.repo,
      branch: delivery.branch,
      after: delivery.after,
      installationId: delivery.installationId,
    });
    const completed = await AppV2GitHubDelivery.updateOne(
      { _id: delivery._id, status: "processing", leaseToken },
      {
        $set: { status: "completed", processedAt: new Date() },
        $unset: { error: 1, leaseToken: 1, expiresAt: 1 },
      },
    );
    if (completed.matchedCount !== 1) {
      throw new Error("GitHub delivery processing ownership was lost");
    }
    return { processed: true, conflicts: result.conflicts };
  } catch (error) {
    await markDeliveryFailed(delivery._id, leaseToken, error);
    throw error;
  }
}

export async function claimAppsV2GitHubDelivery(
  deliveryId: string,
  dependencies: {
    createLeaseToken?: () => string;
    now?: () => Date;
  } = {},
): Promise<{
  delivery: IAppV2GitHubDelivery;
  leaseToken: string;
  expiresAt: Date;
} | null> {
  const now = dependencies.now?.() ?? new Date();
  const leaseToken = dependencies.createLeaseToken?.() ?? randomUUID();
  const expiresAt = new Date(now.getTime() + APP_V2_GITHUB_DELIVERY_LEASE_MS);
  const delivery = await AppV2GitHubDelivery.findOneAndUpdate(
    {
      deliveryId,
      $or: [
        { status: { $in: ["pending", "failed"] } },
        {
          status: "processing",
          expiresAt: { $lte: now },
        },
      ],
    },
    {
      $set: { status: "processing", leaseToken, expiresAt },
      $inc: { attempts: 1 },
      $unset: { error: 1, processedAt: 1 },
    },
    { new: true },
  );
  if (!delivery) {
    const current = await AppV2GitHubDelivery.findOne({ deliveryId });
    if (current?.status === "completed") return null;
    if (
      current?.status === "processing" &&
      current.expiresAt &&
      current.expiresAt > now
    ) {
      throw new Error("GitHub delivery is processing under another lease");
    }
    throw new Error("GitHub delivery could not acquire a processing lease");
  }
  return { delivery, leaseToken, expiresAt };
}

async function markDeliveryFailed(
  deliveryId: IAppV2GitHubDelivery["_id"],
  leaseToken: string,
  error: unknown,
): Promise<void> {
  await AppV2GitHubDelivery.updateOne(
    { _id: deliveryId, status: "processing", leaseToken },
    {
      $set: {
        status: "failed",
        error:
          error instanceof Error ? error.message : "GitHub delivery failed",
        processedAt: new Date(),
      },
      $unset: { leaseToken: 1, expiresAt: 1 },
    },
  );
}

/**
 * Requeues processing records whose worker lease expired. This is safe to call
 * from operational reconciliation; normal Inngest retries also reclaim stale
 * records directly in the processing claim.
 */
export async function reconcileStaleAppsV2GitHubDeliveries(
  now = new Date(),
): Promise<number> {
  const result = await AppV2GitHubDelivery.updateMany(
    { status: "processing", expiresAt: { $lte: now } },
    {
      $set: { status: "pending" },
      $unset: { leaseToken: 1, expiresAt: 1 },
    },
  );
  return result.modifiedCount;
}
