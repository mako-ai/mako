import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../database/workspace-schema";
import {
  registerActiveGeneration,
  stopActiveGeneration,
} from "../services/resumable-stream.service";
import {
  beginChatTurnOwnership,
  claimChatContinuation,
  promoteChatTurnOwnership,
} from "./chat-continuation-ownership";

const scope = {
  chatId: "64b7f0f0f0f0f0f0f0f0f0f0",
  workspaceId: "64b7f0f0f0f0f0f0f0f0f0f2",
  actorId: "actor-a",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat continuation ownership", () => {
  it("atomically replaces the durable Apps v2 turn owner", async () => {
    const update = vi.spyOn(Chat, "findOneAndUpdate").mockResolvedValue({
      appsV2ActiveTurnId: "turn-old",
    } as never);

    await expect(beginChatTurnOwnership(scope, "turn-new")).resolves.toBe(
      "turn-old",
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: expect.anything(),
        createdBy: "actor-a",
      }),
      {
        $set: {
          activeTurnId: "turn-new",
          appsV2ActiveTurnId: "turn-new",
          activeStreamId: null,
          continuationGeneration: 0,
        },
      },
      { new: false },
    );
  });

  it("aborts an existing same-process generation before replacement", () => {
    const first = new AbortController();
    const second = new AbortController();

    registerActiveGeneration("chat-generation-test", "stream-a", first);
    registerActiveGeneration("chat-generation-test", "stream-b", second);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(stopActiveGeneration("chat-generation-test")).toBe(true);
  });

  it("claims the exact stream, outer turn, and continuation generation", async () => {
    const update = vi.spyOn(Chat, "updateOne").mockResolvedValue({
      modifiedCount: 1,
    } as never);

    await expect(
      claimChatContinuation(scope, "turn-a", "64b7f0f0f0f0f0f0f0f0f0f1", 2),
    ).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: expect.anything(),
        createdBy: "actor-a",
        activeTurnId: "turn-a",
        activeStreamId: "64b7f0f0f0f0f0f0f0f0f0f1",
        continuationGeneration: 2,
      }),
      { $inc: { continuationGeneration: 1 } },
    );
  });

  it("refuses when a newer turn replaced ownership", async () => {
    vi.spyOn(Chat, "updateOne").mockResolvedValue({
      modifiedCount: 0,
    } as never);
    await expect(
      claimChatContinuation(scope, "stale-turn", "64b7f0f0f0f0f0f0f0f0f0f1", 0),
    ).resolves.toBe(false);
  });

  it("rejects cross-workspace and other-user ownership CAS without mutation", async () => {
    const update = vi.spyOn(Chat, "updateOne").mockImplementation(
      async filter =>
        ({
          matchedCount:
            String((filter as { workspaceId?: unknown }).workspaceId) ===
              scope.workspaceId &&
            (filter as { createdBy?: string }).createdBy === scope.actorId
              ? 1
              : 0,
        }) as never,
    );

    await expect(
      promoteChatTurnOwnership(
        { ...scope, workspaceId: "64b7f0f0f0f0f0f0f0f0f0f3" },
        "turn-old",
        "turn-new",
      ),
    ).resolves.toBe(false);
    await expect(
      promoteChatTurnOwnership(
        { ...scope, actorId: "actor-b" },
        "turn-old",
        "turn-new",
      ),
    ).resolves.toBe(false);
    expect(update).toHaveBeenCalledTimes(2);
    for (const [filter] of update.mock.calls) {
      expect(filter).toMatchObject({
        _id: expect.anything(),
        workspaceId: expect.anything(),
      });
      expect((filter as { createdBy?: string }).createdBy).toMatch(
        /^actor-[ab]$/,
      );
    }
  });
});
