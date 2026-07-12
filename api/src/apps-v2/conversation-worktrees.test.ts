import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import mongoose, { Types } from "mongoose";
import { createAppV2Scaffold } from "@mako/schemas";
import {
  AppV2Project,
  AppV2Worktree,
  type IAppV2Project,
  type IAppV2Worktree,
} from "../database/workspace-schema";
import { AppV2GitProvider } from "./providers/git-provider";
import { AppV2ProjectService } from "./app-project.service";
import { AppV2WorktreeService } from "./worktree.service";

const originalStartSession = mongoose.startSession;
const originalProjectUpdateOne = AppV2Project.updateOne;
const originalWorktreeCreate = AppV2Worktree.create;
const originalWorktreeFindOne = AppV2Worktree.findOne;
const temporaryRoots: string[] = [];

afterEach(async () => {
  mongoose.startSession = originalStartSession;
  AppV2Project.updateOne = originalProjectUpdateOne;
  AppV2Worktree.create = originalWorktreeCreate;
  AppV2Worktree.findOne = originalWorktreeFindOne;
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(root => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("Apps v2 conversation worktrees", () => {
  it("keeps manual and two chat worktrees, refs, and branches separate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "app-v2-chats-"));
    temporaryRoots.push(root);
    const git = new AppV2GitProvider(root);
    const initial = await git.createRepository(
      "project",
      createAppV2Scaffold(),
    );
    const workspaceId = new Types.ObjectId();
    const projectId = new Types.ObjectId();
    const project = {
      _id: projectId,
      workspaceId,
      repositoryId: "project",
      defaultBranch: "main",
      headSha: initial.sha,
      deletionStatus: "active",
    } as unknown as IAppV2Project;
    const documents: IAppV2Worktree[] = [];

    mongoose.startSession = vi.fn(async () => ({
      withTransaction: async (operation: () => Promise<void>) => operation(),
      endSession: async () => undefined,
    })) as unknown as typeof mongoose.startSession;
    AppV2Project.updateOne = vi.fn(async () => ({
      modifiedCount: 1,
    })) as unknown as typeof AppV2Project.updateOne;
    AppV2Worktree.create = vi.fn(async (records: unknown[]) => {
      const record = records[0] as IAppV2Worktree;
      const document = {
        ...record,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as IAppV2Worktree;
      documents.push(document);
      return [document];
    }) as unknown as typeof AppV2Worktree.create;
    AppV2Worktree.findOne = vi.fn(async (filter: Record<string, unknown>) => {
      return (
        documents.find(document =>
          Object.entries(filter).every(([key, value]) => {
            const actual = document[key as keyof IAppV2Worktree];
            return actual?.toString() === value?.toString();
          }),
        ) ?? null
      );
    }) as unknown as typeof AppV2Worktree.findOne;

    const worktrees = new AppV2WorktreeService(
      new AppV2ProjectService(git, { revokeAndKill: vi.fn() }),
    );
    const actor = { userId: "user-1" };
    const chatOne = new Types.ObjectId().toString();
    const chatTwo = new Types.ObjectId().toString();

    const manual = await worktrees.getOrCreateManual(project, actor);
    const firstChat = await worktrees.getOrCreateAgent(project, actor, chatOne);
    const secondChat = await worktrees.getOrCreateAgent(
      project,
      actor,
      chatTwo,
    );
    const reusedFirstChat = await worktrees.getOrCreateAgent(
      project,
      actor,
      chatOne,
    );

    expect(documents).toHaveLength(3);
    expect(reusedFirstChat._id.toString()).toBe(firstChat._id.toString());
    expect(new Set(documents.map(document => document.wipRef)).size).toBe(3);
    expect(new Set(documents.map(document => document.leaseRef)).size).toBe(3);
    expect([manual.branch, firstChat.branch, secondChat.branch]).toEqual([
      "main",
      `mako/chat/${chatOne}`,
      `mako/chat/${chatTwo}`,
    ]);
    expect(documents.map(document => document.contextKey)).toEqual([
      "manual",
      `chat:${chatOne}`,
      `chat:${chatTwo}`,
    ]);
  });
});
