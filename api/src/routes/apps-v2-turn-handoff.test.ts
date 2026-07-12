import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import {
  awaitChatFinalization,
  scheduleChatFinalization,
} from "./chat-finalization-queue";
import {
  APPS_V2_FAILED_HANDOFF_POLICY,
  prepareAppsV2TurnHandoff,
} from "./apps-v2-turn-handoff";

const workspaceId = new Types.ObjectId().toString();
const actorId = "actor";

function identity(chatId: string) {
  return {
    workspaceId,
    chatId,
    turnId: "turn-next",
    actorId,
  };
}

describe("Apps v2 request-start turn handoff", () => {
  it("waits for same-process turn finalization before assigning ownership", async () => {
    const chatId = new Types.ObjectId().toString();
    const order: string[] = [];
    let predecessorCommits = 0;
    scheduleChatFinalization(chatId, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      predecessorCommits += 1;
      order.push("finalize-turn-n");
    });

    const result = await prepareAppsV2TurnHandoff(identity(chatId), {
      awaitLocal: awaitChatFinalization,
      readOwner: vi.fn(async () => "turn-n"),
      finalizePrevious: vi.fn(async () => {
        order.push("confirm-turn-n-finalized");
        return { status: "completed", projects: [] };
      }),
      fence: vi.fn(async () => {
        order.push("fence-turn-n-leases");
      }),
      start: vi.fn(async () => {
        order.push("start-turn-n-plus-1");
      }),
      promote: vi.fn(async () => {
        order.push("promote-turn-n-plus-1");
        return true;
      }),
      abandon: vi.fn(async () => false),
    });

    expect(predecessorCommits).toBe(1);
    expect(order).toEqual([
      "finalize-turn-n",
      "confirm-turn-n-finalized",
      "fence-turn-n-leases",
      "start-turn-n-plus-1",
      "promote-turn-n-plus-1",
    ]);
    expect(result.predecessor?.status).toBe("completed");
  });

  it("reconciles a cross-instance predecessor before new tools can start", async () => {
    const chatId = new Types.ObjectId().toString();
    const projectId = new Types.ObjectId().toString();
    const worktreeId = new Types.ObjectId().toString();
    const order: string[] = [];
    let predecessorCommits = 0;

    const result = await prepareAppsV2TurnHandoff(identity(chatId), {
      awaitLocal: vi.fn(async () => undefined),
      readOwner: vi.fn(async () => "turn-n"),
      finalizePrevious: vi.fn(async () => {
        predecessorCommits += 1;
        order.push("finalize-and-commit-turn-n");
        return {
          status: "completed" as const,
          projects: [
            {
              projectId,
              worktreeId,
              expectedRevision: 4,
              status: "committed" as const,
              sha: "a".repeat(40),
            },
          ],
        };
      }),
      fence: vi.fn(async () => {
        order.push("fence-turn-n-leases");
      }),
      start: vi.fn(async () => {
        order.push("start-turn-n-plus-1");
      }),
      promote: vi.fn(async () => {
        order.push("promote-turn-n-plus-1");
        return true;
      }),
      abandon: vi.fn(async () => false),
    });

    expect(predecessorCommits).toBe(1);
    expect(order).toEqual([
      "finalize-and-commit-turn-n",
      "fence-turn-n-leases",
      "start-turn-n-plus-1",
      "promote-turn-n-plus-1",
    ]);
    expect(result.predecessor?.projects).toMatchObject([
      { projectId, status: "committed", expectedRevision: 4 },
    ]);
  });

  it("allows a successor after a local commit when persistent GitHub failure remains queued", async () => {
    const chatId = new Types.ObjectId().toString();
    const projectId = new Types.ObjectId().toString();
    const worktreeId = new Types.ObjectId().toString();
    const retryQueue = new Set(["turn-n"]);
    let owner = "turn-n";

    const result = await prepareAppsV2TurnHandoff(identity(chatId), {
      awaitLocal: vi.fn(async () => undefined),
      readOwner: vi.fn(async () => owner),
      finalizePrevious: vi.fn(async () => ({
        status: "remote_failed",
        projects: [
          {
            projectId,
            worktreeId,
            expectedRevision: 4,
            status: "committed",
            sha: "a".repeat(40),
            localOutcome: "committed_local",
            remoteStatus: "remote_failed",
            remoteError: "GitHub unavailable",
          },
        ],
      })),
      fence: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      promote: vi.fn(async (_scope, expectedTurnId, turnId) => {
        if (owner !== expectedTurnId) return false;
        owner = turnId;
        return true;
      }),
      abandon: vi.fn(async () => false),
    });

    expect(result.predecessor).toMatchObject({
      status: "remote_failed",
      projects: [
        {
          status: "committed",
          localOutcome: "committed_local",
          remoteStatus: "remote_failed",
        },
      ],
    });
    expect(owner).toBe("turn-next");
    expect(retryQueue.has("turn-n")).toBe(true);
  });

  it.each([
    {
      name: "failed",
      result: { status: "failed" as const, projects: [] },
    },
    {
      name: "recoverable",
      result: { status: "recoverable" as const, projects: [] },
    },
    {
      name: "conflicted",
      result: {
        status: "remote_failed" as const,
        projects: [
          {
            projectId: new Types.ObjectId().toString(),
            worktreeId: new Types.ObjectId().toString(),
            expectedRevision: 2,
            status: "committed" as const,
            remoteStatus: "conflict" as const,
          },
        ],
      },
    },
  ])(
    "retains predecessor ownership when finalization is $name",
    async ({ result }) => {
      const chatId = new Types.ObjectId().toString();
      const start = vi.fn(async () => undefined);
      const promote = vi.fn(async () => true);

      await expect(
        prepareAppsV2TurnHandoff(identity(chatId), {
          awaitLocal: vi.fn(async () => undefined),
          readOwner: vi.fn(async () => "turn-n"),
          finalizePrevious: vi.fn(async () => result),
          fence: vi.fn(async () => undefined),
          start,
          promote,
          abandon: vi.fn(async () => false),
        }),
      ).rejects.toThrow(APPS_V2_FAILED_HANDOFF_POLICY);
      expect(start).not.toHaveBeenCalled();
      expect(promote).not.toHaveBeenCalled();
    },
  );

  it("rotates leases before promotion so an old pre-checked mutation fails", async () => {
    const chatId = new Types.ObjectId().toString();
    let durableLeaseEpoch = 1;
    const oldLoadedLeaseEpoch = durableLeaseEpoch;
    const mutateWithLease = vi.fn(async (leaseEpoch: number) => {
      if (leaseEpoch !== durableLeaseEpoch) throw new Error("Stale Git lease");
    });

    await prepareAppsV2TurnHandoff(identity(chatId), {
      awaitLocal: vi.fn(async () => undefined),
      readOwner: vi.fn(async () => "turn-n"),
      finalizePrevious: vi.fn(async () => ({
        status: "completed",
        projects: [],
      })),
      fence: vi.fn(async () => {
        durableLeaseEpoch += 1;
      }),
      start: vi.fn(async () => undefined),
      promote: vi.fn(async () => true),
      abandon: vi.fn(async () => false),
    });

    await expect(mutateWithLease(oldLoadedLeaseEpoch)).rejects.toThrow(
      /Stale Git lease/,
    );
    await expect(mutateWithLease(durableLeaseEpoch)).resolves.toBeUndefined();
  });

  it("abandons successor metadata when ownership CAS loses", async () => {
    const chatId = new Types.ObjectId().toString();
    const abandon = vi.fn(async () => false);

    await expect(
      prepareAppsV2TurnHandoff(identity(chatId), {
        awaitLocal: vi.fn(async () => undefined),
        readOwner: vi.fn(async () => "turn-n"),
        finalizePrevious: vi.fn(async () => ({
          status: "completed",
          projects: [],
        })),
        fence: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
        promote: vi.fn(async () => false),
        abandon,
      }),
    ).rejects.toThrow(APPS_V2_FAILED_HANDOFF_POLICY);
    expect(abandon).toHaveBeenCalledWith(identity(chatId));
  });
});
