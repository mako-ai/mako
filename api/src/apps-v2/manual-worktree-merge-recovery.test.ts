import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { createAppV2Scaffold } from "@mako/schemas";
import {
  AppV2Worktree,
  type IAppV2Project,
  type IAppV2Worktree,
} from "../database/workspace-schema";
import { AppV2GitProvider } from "./providers/git-provider";
import { AppV2ProjectService } from "./app-project.service";
import { AppV2WorktreeService } from "./worktree.service";

const originalWorktreeFindOne = AppV2Worktree.findOne;
const originalWorktreeFindOneAndUpdate = AppV2Worktree.findOneAndUpdate;
const temporaryRoots: string[] = [];

afterEach(async () => {
  AppV2Worktree.findOne = originalWorktreeFindOne;
  AppV2Worktree.findOneAndUpdate = originalWorktreeFindOneAndUpdate;
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(root => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

interface RecoveryHarness {
  git: AppV2GitProvider;
  project: IAppV2Project;
  worktree: IAppV2Worktree;
  service: AppV2WorktreeService;
  initialSha: string;
  mergedSha: string;
}

async function createHarness(
  options: {
    dirty?: boolean;
    treeCleanWip?: boolean;
  } = {},
): Promise<RecoveryHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "app-v2-manual-recovery-"));
  temporaryRoots.push(root);
  const git = new AppV2GitProvider(root);
  const repositoryId = "project";
  const scaffold = createAppV2Scaffold();
  const initial = await git.createRepository(repositoryId, scaffold);
  const worktreeId = new Types.ObjectId();
  const manualRefs = await git.createWorktreeRef(
    repositoryId,
    worktreeId.toString(),
    initial.sha,
  );
  let manualWipOid = manualRefs.wipOid;
  let revision = 0;
  if (options.dirty || options.treeCleanWip) {
    const filePath = options.dirty ? "src/manual-only.ts" : "package.json";
    const contents = options.dirty
      ? "export const manualOnly = true;\n"
      : (scaffold.find(file => file.path === filePath)?.contents ?? "");
    const write = await git.writeFile(
      repositoryId,
      manualRefs.wipRef,
      manualWipOid,
      initial.sha,
      manualRefs.leaseRef,
      manualRefs.leaseOid,
      filePath,
      Buffer.from(contents),
      false,
    );
    manualWipOid = write.wipOid;
    revision = 1;
  }

  const chatId = new Types.ObjectId().toString();
  const conversationBranch = `mako/chat/${chatId}`;
  await git.ensureBranch(repositoryId, conversationBranch, initial.sha);
  const agentRefs = await git.createWorktreeRef(
    repositoryId,
    new Types.ObjectId().toString(),
    initial.sha,
  );
  const agentWrite = await git.writeFile(
    repositoryId,
    agentRefs.wipRef,
    agentRefs.wipOid,
    initial.sha,
    agentRefs.leaseRef,
    agentRefs.leaseOid,
    "src/merged.ts",
    Buffer.from("export const merged = true;\n"),
    false,
  );
  const agentCommit = await git.commit(
    repositoryId,
    conversationBranch,
    agentRefs.wipRef,
    agentWrite.wipOid,
    initial.sha,
    agentRefs.leaseRef,
    agentRefs.leaseOid,
    "Add merged file",
  );
  const merge = await git.mergeConversationBranchToDefault(
    repositoryId,
    "main",
    conversationBranch,
    initial.sha,
    agentCommit.sha,
    { name: "Project owner", email: "owner@mako.local" },
  );

  const workspaceId = new Types.ObjectId();
  const projectId = new Types.ObjectId();
  const project = {
    _id: projectId,
    workspaceId,
    repositoryId,
    defaultBranch: "main",
    headSha: merge.mergedSha,
    deletionStatus: "active",
  } as unknown as IAppV2Project;
  const worktree = {
    _id: worktreeId,
    workspaceId,
    projectId,
    actorId: "user-1",
    kind: "manual",
    contextKey: "manual",
    branch: "main",
    baseSha: initial.sha,
    wipRef: manualRefs.wipRef,
    wipOid: manualWipOid,
    leaseRef: manualRefs.leaseRef,
    leaseOid: manualRefs.leaseOid,
    revision,
    leaseEpoch: 1,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as IAppV2Worktree;

  AppV2Worktree.findOne = vi.fn(
    async () => worktree,
  ) as unknown as typeof AppV2Worktree.findOne;
  AppV2Worktree.findOneAndUpdate = vi.fn(
    async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => {
      const matches = Object.entries(filter).every(([key, expected]) => {
        const actual = worktree[key as keyof IAppV2Worktree];
        return actual?.toString() === expected?.toString();
      });
      if (!matches) return null;
      const set = update.$set as Record<string, unknown> | undefined;
      if (set) Object.assign(worktree, set);
      const increment = update.$inc as Record<string, number> | undefined;
      if (increment) {
        for (const [key, amount] of Object.entries(increment)) {
          const current = Number(
            worktree[key as keyof IAppV2Worktree] as number,
          );
          (worktree as unknown as Record<string, unknown>)[key] =
            current + amount;
        }
      }
      return worktree;
    },
  ) as unknown as typeof AppV2Worktree.findOneAndUpdate;

  return {
    git,
    project,
    worktree,
    service: new AppV2WorktreeService(
      new AppV2ProjectService(git, { revokeAndKill: vi.fn() }),
    ),
    initialSha: initial.sha,
    mergedSha: merge.mergedSha,
  };
}

describe("Apps v2 manual worktree recovery after branch merge", () => {
  it("fast-forwards a genuinely clean manual worktree to the merged head", async () => {
    const harness = await createHarness({ treeCleanWip: true });
    expect(harness.worktree.wipOid).not.toBe(harness.initialSha);

    const recovered = await harness.service.getActorWorktree(harness.project, {
      userId: "user-1",
    });

    expect(recovered.baseSha).toBe(harness.mergedSha);
    expect(recovered.wipOid).toBe(harness.mergedSha);
    expect(recovered.revision).toBe(2);
    expect(recovered.status).toBe("active");
    expect(
      await harness.git.resolveRef(
        harness.project.repositoryId,
        recovered.wipRef,
      ),
    ).toBe(harness.mergedSha);
    expect(
      (await harness.service.tree(harness.project, recovered)).some(
        entry => entry.path === "src/merged.ts",
      ),
    ).toBe(true);
    expect(await harness.service.status(harness.project, recovered)).toEqual({
      clean: true,
      changes: [],
    });
  });

  it("repairs Mongo projection after the Git fast-forward already committed", async () => {
    const harness = await createHarness();
    await harness.git.fastForwardCleanWorktree(
      harness.project.repositoryId,
      harness.worktree.branch,
      harness.mergedSha,
      harness.worktree.wipRef,
      harness.initialSha,
      harness.worktree.leaseRef,
      harness.worktree.leaseOid,
    );

    const recovered = await harness.service.getActorWorktree(harness.project, {
      userId: "user-1",
    });

    expect(recovered.baseSha).toBe(harness.mergedSha);
    expect(recovered.wipOid).toBe(harness.mergedSha);
    expect(recovered.revision).toBe(1);
    expect(recovered.status).toBe("active");
  });

  it("preserves dirty WIP on its old base and marks it conflicted", async () => {
    const harness = await createHarness({ dirty: true });
    const dirtyWipOid = harness.worktree.wipOid;

    const recovered = await harness.service.getActorWorktree(harness.project, {
      userId: "user-1",
    });

    expect(recovered.baseSha).toBe(harness.initialSha);
    expect(recovered.wipOid).toBe(dirtyWipOid);
    expect(recovered.status).toBe("conflict");
    expect(
      await harness.git.resolveRef(
        harness.project.repositoryId,
        recovered.wipRef,
      ),
    ).toBe(dirtyWipOid);
    expect(
      (await harness.service.tree(harness.project, recovered)).some(
        entry => entry.path === "src/manual-only.ts",
      ),
    ).toBe(true);
  });

  it("lets a concurrent mutation win the WIP CAS without losing edits", async () => {
    const harness = await createHarness();
    const originalFastForward = harness.git.fastForwardCleanWorktree.bind(
      harness.git,
    );
    let concurrentWipOid = "";
    vi.spyOn(harness.git, "fastForwardCleanWorktree").mockImplementationOnce(
      async (...args) => {
        const dirty = await harness.git.writeFile(
          harness.project.repositoryId,
          harness.worktree.wipRef,
          harness.worktree.wipOid,
          harness.worktree.baseSha,
          harness.worktree.leaseRef,
          harness.worktree.leaseOid,
          "src/concurrent.ts",
          Buffer.from("export const concurrent = true;\n"),
          false,
        );
        concurrentWipOid = dirty.wipOid;
        harness.worktree.wipOid = dirty.wipOid;
        harness.worktree.revision += 1;
        return originalFastForward(...args);
      },
    );

    const recovered = await harness.service.getActorWorktree(harness.project, {
      userId: "user-1",
    });

    expect(recovered.baseSha).toBe(harness.initialSha);
    expect(recovered.wipOid).toBe(concurrentWipOid);
    expect(recovered.status).toBe("conflict");
    expect(
      await harness.git.resolveRef(
        harness.project.repositoryId,
        recovered.wipRef,
      ),
    ).toBe(concurrentWipOid);
    expect(
      (await harness.service.tree(harness.project, recovered)).some(
        entry => entry.path === "src/concurrent.ts",
      ),
    ).toBe(true);
  });
});
