import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { AppV2GitHubDelivery } from "../database/workspace-schema";
import { inngest } from "../inngest/client";

const handlePush = vi.hoisted(() => vi.fn());
vi.mock("./github-push.service", () => ({
  handleAppsV2GitHubPushEvent: handlePush,
}));

import {
  APP_V2_GITHUB_DELIVERY_LEASE_MS,
  enqueueAppsV2GitHubPushDelivery,
  processAppsV2GitHubDelivery,
  reconcileStaleAppsV2GitHubDeliveries,
} from "./github-delivery.service";

const input = {
  deliveryId: "delivery-123",
  installationId: 42,
  owner: "mako",
  repo: "app",
  branch: "main",
  after: "a".repeat(40),
};

function delivery(status: "pending" | "processing" | "completed" | "failed") {
  const timestamp = new Date("2026-07-12T12:00:00.000Z");
  return {
    _id: new Types.ObjectId(),
    ...input,
    event: "push",
    status,
    attempts: 0,
    ...(status === "processing"
      ? {
          leaseToken: "lease-1",
          expiresAt: new Date(
            timestamp.getTime() + APP_V2_GITHUB_DELIVERY_LEASE_MS,
          ),
        }
      : {}),
    receivedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  handlePush.mockReset();
});

describe("Apps v2 GitHub delivery queue", () => {
  it("persists before enqueue and treats completed duplicates as no-ops", async () => {
    const pending = delivery("pending");
    const persist = vi
      .spyOn(AppV2GitHubDelivery, "findOneAndUpdate")
      .mockResolvedValueOnce(pending as never)
      .mockResolvedValueOnce(delivery("completed") as never);
    const send = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] });

    await expect(enqueueAppsV2GitHubPushDelivery(input)).resolves.toMatchObject(
      { enqueued: true, duplicate: false },
    );
    expect(persist).toHaveBeenNthCalledWith(
      1,
      { deliveryId: input.deliveryId },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          status: "pending",
          installationId: 42,
        }),
      }),
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `apps-v2-github:${input.deliveryId}`,
        data: { deliveryId: input.deliveryId },
      }),
    );

    send.mockClear();
    await expect(enqueueAppsV2GitHubPushDelivery(input)).resolves.toEqual({
      enqueued: false,
      duplicate: true,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("marks failed processing retryable and completes a later retry", async () => {
    const processing = delivery("processing");
    vi.spyOn(AppV2GitHubDelivery, "findOneAndUpdate")
      .mockResolvedValueOnce(processing as never)
      .mockResolvedValueOnce(processing as never);
    const update = vi
      .spyOn(AppV2GitHubDelivery, "updateOne")
      .mockResolvedValue({ matchedCount: 1 } as never);
    handlePush.mockRejectedValueOnce(new Error("temporary failure"));

    await expect(processAppsV2GitHubDelivery(input.deliveryId)).rejects.toThrow(
      "temporary failure",
    );
    expect(update).toHaveBeenCalledWith(
      {
        _id: processing._id,
        status: "processing",
        leaseToken: expect.any(String),
      },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "failed" }),
        $unset: expect.objectContaining({ leaseToken: 1, expiresAt: 1 }),
      }),
    );

    handlePush.mockResolvedValueOnce({ matched: 1, conflicts: 0 });
    await expect(
      processAppsV2GitHubDelivery(input.deliveryId),
    ).resolves.toEqual({ processed: true, conflicts: 0 });
    expect(update).toHaveBeenLastCalledWith(
      {
        _id: processing._id,
        status: "processing",
        leaseToken: expect.any(String),
      },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "completed" }),
      }),
    );
  });

  it("throws so Inngest retries while another unexpired attempt owns the delivery", async () => {
    const now = new Date("2026-07-12T12:00:00.000Z");
    const processing = {
      ...delivery("processing"),
      leaseToken: "other-attempt",
      expiresAt: new Date(now.getTime() + 60_000),
    };
    vi.spyOn(AppV2GitHubDelivery, "findOneAndUpdate").mockResolvedValue(null);
    vi.spyOn(AppV2GitHubDelivery, "findOne").mockResolvedValue(
      processing as never,
    );

    await expect(
      processAppsV2GitHubDelivery(input.deliveryId, {
        now: () => now,
        createLeaseToken: () => "new-attempt",
      }),
    ).rejects.toThrow(/another lease/);
    expect(handlePush).not.toHaveBeenCalled();
  });

  it("reclaims an expired attempt with a new token and fences stale completion", async () => {
    const now = new Date("2026-07-12T12:10:00.000Z");
    const reclaimed = {
      ...delivery("processing"),
      leaseToken: "new-attempt",
      expiresAt: new Date(now.getTime() + APP_V2_GITHUB_DELIVERY_LEASE_MS),
    };
    const claim = vi
      .spyOn(AppV2GitHubDelivery, "findOneAndUpdate")
      .mockResolvedValue(reclaimed as never);
    const update = vi
      .spyOn(AppV2GitHubDelivery, "updateOne")
      .mockResolvedValue({ matchedCount: 1 } as never);
    handlePush.mockResolvedValue({ matched: 1, conflicts: 0 });

    await expect(
      processAppsV2GitHubDelivery(input.deliveryId, {
        now: () => now,
        createLeaseToken: () => "new-attempt",
      }),
    ).resolves.toEqual({ processed: true, conflicts: 0 });

    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: expect.arrayContaining([
          {
            status: "processing",
            expiresAt: { $lte: now },
          },
        ]),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ leaseToken: "new-attempt" }),
      }),
      { new: true },
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: "new-attempt" }),
      expect.any(Object),
    );
  });

  it("does not acknowledge processing when completion loses its lease", async () => {
    const processing = delivery("processing");
    vi.spyOn(AppV2GitHubDelivery, "findOneAndUpdate").mockResolvedValue(
      processing as never,
    );
    vi.spyOn(AppV2GitHubDelivery, "updateOne").mockResolvedValue({
      matchedCount: 0,
    } as never);
    handlePush.mockResolvedValue({ matched: 1, conflicts: 0 });

    await expect(
      processAppsV2GitHubDelivery(input.deliveryId, {
        createLeaseToken: () => "lost-lease",
      }),
    ).rejects.toThrow(/ownership was lost/);
  });

  it("exposes stale delivery reconciliation", async () => {
    const now = new Date("2026-07-12T12:10:00.000Z");
    const update = vi
      .spyOn(AppV2GitHubDelivery, "updateMany")
      .mockResolvedValue({ modifiedCount: 2 } as never);

    await expect(reconcileStaleAppsV2GitHubDeliveries(now)).resolves.toBe(2);
    expect(update).toHaveBeenCalledWith(
      { status: "processing", expiresAt: { $lte: now } },
      {
        $set: { status: "pending" },
        $unset: { leaseToken: 1, expiresAt: 1 },
      },
    );
  });
});
