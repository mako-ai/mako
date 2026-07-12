import { afterEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import {
  AppV2ChatTurn,
  AppV2Worktree,
  Chat,
} from "../database/workspace-schema";
import {
  APPS_V2_CHAT_TURN_STALE_MS,
  claimAppsV2ChatTurnFinalization,
  listRetryableAppsV2ChatTurns,
  touchAppsV2ChatTurnProject,
} from "./chat-turn.service";

const workspaceId = new Types.ObjectId();
const projectId = new Types.ObjectId();
const worktreeId = new Types.ObjectId();
const chatId = new Types.ObjectId().toString();
const identity = {
  workspaceId: workspaceId.toString(),
  chatId,
  turnId: "new-turn",
  actorId: "actor",
};

afterEach(() => {
  vi.restoreAllMocks();
});

function mockWorktree(activeTurnId?: string) {
  vi.spyOn(AppV2Worktree, "findById").mockReturnValue({
    select: vi.fn(async () => ({
      _id: worktreeId,
      workspaceId,
      projectId,
      actorId: "actor",
      kind: "agent",
      chatId,
      revision: 7,
      activeTurnId,
    })),
  } as never);
}

describe("Apps v2 chat turn ownership", () => {
  it("adopts orphaned dirty WIP only after its prior turn is no longer active", async () => {
    mockWorktree("crashed-turn");
    const ownerLookup = vi
      .spyOn(Chat, "exists")
      .mockImplementation(async query =>
        (query as { appsV2ActiveTurnId?: string }).appsV2ActiveTurnId ===
        identity.turnId
          ? ({ _id: new Types.ObjectId() } as never)
          : null,
      );
    vi.spyOn(AppV2Worktree, "updateOne").mockResolvedValue({
      modifiedCount: 1,
    } as never);
    const turnUpdate = vi
      .spyOn(AppV2ChatTurn, "updateOne")
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 } as never);

    await touchAppsV2ChatTurnProject(
      identity,
      projectId.toString(),
      worktreeId.toString(),
      7,
    );

    expect(AppV2Worktree.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ activeTurnId: "crashed-turn", revision: 7 }),
      { $set: { activeTurnId: "new-turn" } },
    );
    expect(turnUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "active" }),
      expect.any(Array),
    );
    for (const [query] of ownerLookup.mock.calls) {
      expect(query).toMatchObject({
        _id: expect.anything(),
        workspaceId: expect.anything(),
        createdBy: identity.actorId,
      });
    }
  });

  it("refuses old-turn tools after durable chat ownership is superseded", async () => {
    mockWorktree("active-turn");
    vi.spyOn(Chat, "exists").mockResolvedValue(null);
    vi.spyOn(AppV2Worktree, "updateOne");
    vi.spyOn(AppV2ChatTurn, "updateOne").mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    } as never);

    await expect(
      touchAppsV2ChatTurnProject(
        identity,
        projectId.toString(),
        worktreeId.toString(),
        7,
      ),
    ).rejects.toThrow(/newer chat turn superseded/);
    expect(AppV2Worktree.updateOne).not.toHaveBeenCalled();
  });

  it("skips fresh active turns and selects only stale active retries", async () => {
    const now = new Date("2026-07-12T10:00:00.000Z");
    const limit = vi.fn(async () => []);
    const sort = vi.fn(() => ({ limit }));
    const find = vi
      .spyOn(AppV2ChatTurn, "find")
      .mockReturnValue({ sort } as never);

    await listRetryableAppsV2ChatTurns(3, { now });

    const query = find.mock.calls[0][0] as {
      $and: Array<{ $or: Array<Record<string, unknown>> }>;
    };
    const statusClauses = query.$and[1].$or;
    expect(statusClauses).toContainEqual({
      status: "active",
      heartbeatAt: {
        $lt: new Date(now.getTime() - APPS_V2_CHAT_TURN_STALE_MS),
      },
    });
    expect(statusClauses).not.toContainEqual({ status: "active" });
    expect(statusClauses).toContainEqual({
      status: "superseded",
      touchedProjects: {
        $elemMatch: {
          status: { $in: ["pending", "failed", "recoverable"] },
        },
      },
    });
    expect(sort).toHaveBeenCalledWith({ heartbeatAt: 1 });
    expect(limit).toHaveBeenCalledWith(3);
  });

  it("acquires an expiring CAS lease before retrying stale work", async () => {
    vi.spyOn(Chat, "exists").mockResolvedValue({
      _id: new Types.ObjectId(),
    } as never);
    const claim = vi
      .spyOn(AppV2ChatTurn, "findOneAndUpdate")
      .mockResolvedValue(null);

    await claimAppsV2ChatTurnFinalization(
      { ...identity, retryLeaseId: "retry-lease" },
      false,
      true,
    );

    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        $and: expect.arrayContaining([
          expect.objectContaining({
            $or: expect.arrayContaining([
              expect.objectContaining({
                status: "active",
                heartbeatAt: expect.any(Object),
              }),
            ]),
          }),
        ]),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "finalizing",
          retryLeaseId: "retry-lease",
          retryLeaseExpiresAt: expect.any(Date),
        }),
      }),
      { new: true },
    );
  });

  it("leases a superseded turn only when it still has uncommitted projects", async () => {
    const ownerLookup = vi.spyOn(Chat, "exists");
    const claim = vi
      .spyOn(AppV2ChatTurn, "findOneAndUpdate")
      .mockResolvedValue(null);

    await claimAppsV2ChatTurnFinalization(
      {
        ...identity,
        retryLeaseId: "handoff-lease",
        allowSupersededRetry: true,
      },
      false,
      true,
    );

    expect(ownerLookup).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        $and: expect.arrayContaining([
          {
            status: "superseded",
            touchedProjects: {
              $elemMatch: {
                status: { $in: ["pending", "failed", "recoverable"] },
              },
            },
          },
        ]),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ retryLeaseId: "handoff-lease" }),
      }),
      { new: true },
    );
  });

  it("leases a remote-only retry after successor ownership without reopening local work", async () => {
    const ownerLookup = vi.spyOn(Chat, "exists");
    const claim = vi
      .spyOn(AppV2ChatTurn, "findOneAndUpdate")
      .mockResolvedValue(null);

    await claimAppsV2ChatTurnFinalization(
      {
        ...identity,
        retryLeaseId: "remote-retry-lease",
        allowRemoteOnlyRetry: true,
      },
      false,
      true,
    );

    expect(ownerLookup).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        $and: expect.arrayContaining([
          {
            status: "remote_failed",
            "touchedProjects.status": {
              $nin: ["pending", "failed", "recoverable"],
            },
          },
        ]),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "finalizing",
          retryLeaseId: "remote-retry-lease",
        }),
      }),
      { new: true },
    );
  });
});
