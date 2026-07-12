import { afterEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { Chat } from "../database/workspace-schema";
import { saveChat } from "../services/agent-thread.service";

const chatId = new Types.ObjectId().toString();
const workspaceId = new Types.ObjectId().toString();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat write scope", () => {
  it("rejects a mismatched workspace or actor before writing", async () => {
    vi.spyOn(Chat, "exists").mockResolvedValue(null);
    const write = vi.spyOn(Chat, "findOneAndUpdate");

    await expect(
      saveChat(chatId, workspaceId, "other-actor", []),
    ).rejects.toThrow(/not owned/);
    expect(write).not.toHaveBeenCalled();
  });

  it("persists only through the exact chat, workspace, and actor filter", async () => {
    vi.spyOn(Chat, "exists").mockResolvedValue({
      _id: new Types.ObjectId(chatId),
    } as never);
    const write = vi.spyOn(Chat, "findOneAndUpdate").mockResolvedValue({
      _id: new Types.ObjectId(chatId),
    } as never);

    await saveChat(chatId, workspaceId, "actor-a", []);

    expect(write).toHaveBeenCalledWith(
      {
        _id: new Types.ObjectId(chatId),
        workspaceId: new Types.ObjectId(workspaceId),
        createdBy: "actor-a",
      },
      expect.anything(),
      { new: true },
    );
  });
});
