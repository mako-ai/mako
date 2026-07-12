import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose, { Types } from "mongoose";
import {
  AppV2ChatRemote,
  AppV2Project,
  AppV2Worktree,
  GitHubInstallation,
  type IAppV2ChatRemote,
  type IAppV2Project,
  type IAppV2Worktree,
} from "../database/workspace-schema";
import {
  GitHubApiError,
  type TreeChange,
} from "../integrations/github/github-api";

const graph = vi.hoisted(() => ({
  getReadable: vi.fn(),
  getWritable: vi.fn(),
  tree: vi.fn(),
  readFile: vi.fn(),
}));
const publishRealtimeEvent = vi.hoisted(() => vi.fn());

vi.mock("./service-factory", () => ({
  getAppV2Services: () => ({
    projects: {
      getReadable: graph.getReadable,
      getWritable: graph.getWritable,
      git: { tree: graph.tree, readFile: graph.readFile },
    },
  }),
}));
vi.mock("../services/realtime.service", () => ({ publishRealtimeEvent }));

import {
  AppV2GitHubPushService,
  appV2GitHubBindingFingerprint,
  handleAppsV2GitHubPushEvent,
  type AppV2GitHubClient,
} from "./github-push.service";
import { appV2GitHubConversationBranch } from "./conversation-branch";

const workspaceId = new Types.ObjectId();
const projectId = new Types.ObjectId();
const chatId = new Types.ObjectId().toString();
const localSha = "a".repeat(40);
const remoteBranch = appV2GitHubConversationBranch(
  projectId.toString(),
  chatId,
);
const bindingFingerprint = appV2GitHubBindingFingerprint({
  installationId: 42,
  owner: "mako",
  repo: "app",
  baseBranch: "main",
  subdirectory: "mirror",
});
const project = {
  _id: projectId,
  workspaceId,
  owner_id: "owner",
  createdBy: "owner",
  access: "private",
  workspaceRole: "viewer",
  sharedWith: [{ userId: "manager", role: "editor" }],
  repositoryId: projectId.toString(),
  deletionStatus: "active",
  githubBindingGeneration: 1,
  mutationRevision: 1,
  github: {
    installationId: 42,
    owner: "mako",
    repo: "app",
    baseBranch: "main",
    bindingFingerprint,
    subdirectory: "mirror",
    autoPushOnTurnEnd: true,
    boundAt: new Date(),
    boundBy: "owner",
  },
} as unknown as IAppV2Project;
const worktree = {
  _id: new Types.ObjectId(),
  workspaceId,
  projectId,
  actorId: "owner",
  kind: "agent",
  chatId,
  branch: `mako/chat/${chatId}`,
  lastAgentCommitSha: localSha,
  wipOid: localSha,
} as unknown as IAppV2Worktree;

interface FakeRemoteState {
  remote: IAppV2ChatRemote | null;
}

function nestedValue(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, source);
}

function matchesRemote(
  remote: IAppV2ChatRemote,
  query: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(query)) {
    if (key === "$or") {
      if (
        !(expected as Array<Record<string, unknown>>).some(candidate =>
          matchesRemote(remote, candidate),
        )
      ) {
        return false;
      }
      continue;
    }
    const actual = nestedValue(remote, key);
    if (
      expected &&
      typeof expected === "object" &&
      !Array.isArray(expected) &&
      !(expected instanceof Types.ObjectId)
    ) {
      const operator = expected as Record<string, unknown>;
      if ("$exists" in operator) {
        if ((actual !== undefined) !== operator.$exists) return false;
        continue;
      }
      if ("$lte" in operator) {
        if (
          !(actual instanceof Date) ||
          actual.getTime() > (operator.$lte as Date).getTime()
        ) {
          return false;
        }
        continue;
      }
    }
    if (Array.isArray(expected)) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
      continue;
    }
    if (
      actual instanceof Types.ObjectId &&
      expected instanceof Types.ObjectId
    ) {
      if (!actual.equals(expected)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function applyUpdate(
  target: Record<string, unknown>,
  update: Record<string, Record<string, unknown>>,
): void {
  const setValue = (path: string, value: unknown) => {
    const segments = path.split(".");
    let current = target;
    for (const segment of segments.slice(0, -1)) {
      current[segment] ??= {};
      current = current[segment] as Record<string, unknown>;
    }
    current[segments.at(-1) as string] = value;
  };
  const deleteValue = (path: string) => {
    const segments = path.split(".");
    let current = target;
    for (const segment of segments.slice(0, -1)) {
      if (!current[segment] || typeof current[segment] !== "object") return;
      current = current[segment] as Record<string, unknown>;
    }
    delete current[segments.at(-1) as string];
  };
  for (const [key, value] of Object.entries(update.$set ?? {})) {
    setValue(key, value);
  }
  for (const [key, amount] of Object.entries(update.$inc ?? {})) {
    target[key] = Number(target[key] ?? 0) + Number(amount);
  }
  for (const key of Object.keys(update.$unset ?? {})) {
    deleteValue(key);
  }
  for (const [key, value] of Object.entries(update.$addToSet ?? {})) {
    const values = (target[key] ?? []) as unknown[];
    if (!values.includes(value)) values.push(value);
    target[key] = values;
  }
}

function mockPersistence(state: FakeRemoteState): void {
  vi.spyOn(GitHubInstallation, "findOne").mockResolvedValue({} as never);
  vi.spyOn(AppV2Worktree, "findOne").mockImplementation(async () => worktree);
  vi.spyOn(AppV2Worktree, "updateOne").mockResolvedValue({
    matchedCount: 1,
  } as never);
  vi.spyOn(AppV2Project, "findOneAndUpdate").mockImplementation(
    async (_query, update) => {
      const mutation = update as Record<string, Record<string, unknown>>;
      if (project.githubPushLease) return null;
      applyUpdate(project as unknown as Record<string, unknown>, mutation);
      return project;
    },
  );
  vi.spyOn(AppV2Project, "updateOne").mockImplementation(
    async (query, update) => {
      const requiredOperation = nestedValue(
        query,
        "githubPushLease.operationId",
      );
      if (
        requiredOperation &&
        project.githubPushLease?.operationId !== requiredOperation
      ) {
        return { matchedCount: 0 } as never;
      }
      applyUpdate(
        project as unknown as Record<string, unknown>,
        update as Record<string, Record<string, unknown>>,
      );
      return { matchedCount: 1, modifiedCount: 1 } as never;
    },
  );
  vi.spyOn(AppV2Project, "find").mockResolvedValue([project] as never);
  vi.spyOn(AppV2ChatRemote, "findOne").mockImplementation(async query => {
    if (!state.remote) return null;
    return matchesRemote(
      state.remote,
      query as unknown as Record<string, unknown>,
    )
      ? state.remote
      : null;
  });
  vi.spyOn(AppV2ChatRemote, "findById").mockImplementation(async () => {
    return state.remote;
  });
  vi.spyOn(AppV2ChatRemote, "findOneAndUpdate").mockImplementation(
    async (query, update) => {
      if (
        !state.remote ||
        !matchesRemote(
          state.remote,
          query as unknown as Record<string, unknown>,
        )
      ) {
        return null;
      }
      applyUpdate(
        state.remote as unknown as Record<string, unknown>,
        update as unknown as Record<string, Record<string, unknown>>,
      );
      return state.remote;
    },
  );
  vi.spyOn(AppV2ChatRemote, "updateOne").mockImplementation(
    async (query, update, options) => {
      if (!state.remote && options?.upsert) {
        const inserted = (
          update as unknown as {
            $setOnInsert: Record<string, unknown>;
          }
        ).$setOnInsert;
        state.remote = {
          _id: new Types.ObjectId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...inserted,
        } as unknown as IAppV2ChatRemote;
        return { matchedCount: 1, modifiedCount: 1 } as never;
      }
      if (
        !state.remote ||
        !matchesRemote(
          state.remote,
          query as unknown as Record<string, unknown>,
        )
      ) {
        return { matchedCount: 0, modifiedCount: 0 } as never;
      }
      applyUpdate(
        state.remote as unknown as Record<string, unknown>,
        update as unknown as Record<string, Record<string, unknown>>,
      );
      return { matchedCount: 1, modifiedCount: 1 } as never;
    },
  );
}

function fakeClient() {
  let branchSha: string | undefined;
  let treeSha = "base-tree";
  let pushCount = 0;
  let failCommits = false;
  let failRefUpdateBeforeApply = false;
  let failRefUpdateAfterApply = false;
  let beforeCommitReturn: ((sha: string) => Promise<void>) | undefined;
  const commits: Array<{ changes: TreeChange[]; parentSha: string }> = [];
  const client: AppV2GitHubClient = {
    getRepoInfo: vi.fn(async () => ({
      fullName: "mako/app",
      owner: "mako",
      name: "app",
      defaultBranch: "main",
      private: true,
    })),
    getBranchHeadSha: vi.fn(async () => "base-sha"),
    getRefCommit: vi.fn(async () => {
      if (!branchSha) throw new GitHubApiError(404, "missing");
      return { commitSha: branchSha, treeSha };
    }),
    getRepoTree: vi.fn(async () => ({
      sha: treeSha,
      truncated: false,
      entries: [
        { path: "mirror/stale.bin", type: "blob", sha: "stale" },
        { path: "outside.txt", type: "blob", sha: "outside" },
      ],
    })),
    createBlob: vi.fn(async (_owner, _repo, base64) => `blob-${base64}`),
    createBranch: vi.fn(async (_owner, _repo, branch, fromSha) => {
      expect(branch).toBe(remoteBranch);
      branchSha = fromSha;
    }),
    prepareCommit: vi.fn(async (_owner, _repo, params) => {
      if (failCommits) throw new GitHubApiError(500, "unavailable");
      commits.push({ changes: params.changes, parentSha: params.parentSha });
      pushCount += 1;
      return `remote-${pushCount}`;
    }),
    updateBranchRef: vi.fn(async (_owner, _repo, branch, commitSha) => {
      expect(branch).toBe(remoteBranch);
      if (failRefUpdateBeforeApply) {
        throw new GitHubApiError(500, "ref unavailable");
      }
      branchSha = commitSha;
      treeSha = `tree-${pushCount}`;
      await beforeCommitReturn?.(commitSha);
      if (failRefUpdateAfterApply) {
        throw new GitHubApiError(500, "ambiguous ref response");
      }
    }),
  };
  return {
    client,
    commits,
    branchSha: () => branchSha,
    advanceRemote: (sha: string) => {
      branchSha = sha;
    },
    setFailCommits: (value: boolean) => {
      failCommits = value;
    },
    setBeforeCommitReturn: (callback: (sha: string) => Promise<void>) => {
      beforeCommitReturn = callback;
    },
    setFailRefUpdateBeforeApply: (value: boolean) => {
      failRefUpdateBeforeApply = value;
    },
    setFailRefUpdateAfterApply: (value: boolean) => {
      failRefUpdateAfterApply = value;
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(mongoose, "startSession").mockResolvedValue({
    withTransaction: async (operation: () => Promise<void>) => operation(),
    endSession: async () => undefined,
  } as never);
  vi.spyOn(AppV2ChatRemote, "deleteMany").mockResolvedValue({
    deletedCount: 0,
  } as never);
  publishRealtimeEvent.mockClear();
  process.env.APPS_V2_GITHUB_PUSH_ENABLED = "true";
  worktree.lastAgentCommitSha = localSha;
  worktree.wipOid = localSha;
  project.githubBindingGeneration = 1;
  project.githubPushLease = undefined;
  project.github = {
    installationId: 42,
    owner: "mako",
    repo: "app",
    baseBranch: "main",
    bindingFingerprint,
    subdirectory: "mirror",
    autoPushOnTurnEnd: true,
    boundAt: new Date(),
    boundBy: "owner",
  };
  graph.getReadable.mockResolvedValue(project);
  graph.getWritable.mockResolvedValue(project);
  graph.tree.mockResolvedValue([
    {
      path: "bin/data",
      oid: "blob-local",
      size: 2,
      mode: "regular",
    },
    {
      path: "run.sh",
      oid: "blob-exec",
      size: 4,
      mode: "executable",
    },
  ]);
  graph.readFile.mockImplementation(async (_repo, _sha, path) => ({
    content: path === "bin/data" ? Buffer.from([0, 255]) : Buffer.from("run\n"),
    entry: {},
  }));
});

describe("Apps v2 GitHub binding", () => {
  it("requires workspace admin plus project management and rejects foreign installations", async () => {
    const service = new AppV2GitHubPushService(
      fakeClient().client,
      async () => "token",
    );
    const input = {
      installationId: 42,
      owner: "mako",
      repo: "app",
      baseBranch: "main",
      autoPushOnTurnEnd: true,
    };

    await expect(
      service.bind(
        workspaceId.toString(),
        projectId.toString(),
        {
          userId: "owner",
          memberRole: "member",
        },
        input,
      ),
    ).rejects.toThrow("Project not found");
    await expect(
      service.bind(
        workspaceId.toString(),
        projectId.toString(),
        {
          userId: "manager",
          memberRole: "member",
        },
        input,
      ),
    ).rejects.toThrow("Project not found");

    vi.spyOn(GitHubInstallation, "findOne").mockResolvedValueOnce(null);
    await expect(
      service.bind(
        workspaceId.toString(),
        projectId.toString(),
        { userId: "owner", memberRole: "admin" },
        input,
      ),
    ).rejects.toThrow("installation not found");

    vi.spyOn(GitHubInstallation, "findOne").mockResolvedValueOnce({} as never);
    const update = vi
      .spyOn(AppV2Project, "findOneAndUpdate")
      .mockResolvedValue({
        ...project,
        github: { ...project.github, baseBranchHeadSha: "base-sha" },
      } as never);
    await expect(
      service.bind(
        workspaceId.toString(),
        projectId.toString(),
        { userId: "owner", memberRole: "admin" },
        { ...input, subdirectory: "/mirror/" },
      ),
    ).resolves.toMatchObject({ github: { installationId: 42 } });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        githubBindingGeneration: 1,
        $or: expect.any(Array),
      }),
      expect.objectContaining({
        $inc: expect.objectContaining({ githubBindingGeneration: 1 }),
      }),
      expect.objectContaining({ new: true, session: expect.any(Object) }),
    );
    expect(AppV2ChatRemote.deleteMany).toHaveBeenCalledWith(
      { projectId },
      { session: expect.any(Object) },
    );
  });

  it("fences bind and unbind while a project push lease is active", async () => {
    vi.spyOn(GitHubInstallation, "findOne").mockResolvedValue({} as never);
    vi.spyOn(AppV2Project, "findOneAndUpdate").mockResolvedValue(null);
    const service = new AppV2GitHubPushService(
      fakeClient().client,
      async () => "token",
    );
    const actor = { userId: "owner", memberRole: "admin" };

    await expect(
      service.bind(workspaceId.toString(), projectId.toString(), actor, {
        installationId: 42,
        owner: "mako",
        repo: "app",
        baseBranch: "main",
        autoPushOnTurnEnd: true,
      }),
    ).rejects.toThrow(/push is in progress/);
    await expect(
      service.unbind(workspaceId.toString(), projectId.toString(), actor),
    ).rejects.toThrow(/push is in progress/);
  });
});

describe("Apps v2 GitHub conversation pushes", () => {
  it("creates a project-scoped branch, preserves bytes/modes/deletes, fast-forwards, and skips duplicates", async () => {
    const github = fakeClient();
    const state: FakeRemoteState = { remote: null };
    mockPersistence(state);
    const service = new AppV2GitHubPushService(
      github.client,
      async () => "token",
      async () => undefined,
      () => "operation-1",
    );
    const input = {
      workspaceId: workspaceId.toString(),
      projectId: projectId.toString(),
      chatId,
      actor: { userId: "owner" },
      localSha,
      wipOid: localSha,
      requireAutoPush: true,
    };

    await expect(service.pushConversation(input)).resolves.toMatchObject({
      status: "pushed",
      remoteSha: "remote-1",
      remoteBranch,
    });
    expect(github.commits[0].parentSha).toBe("base-sha");
    expect(github.commits[0].changes).toEqual(
      expect.arrayContaining([
        {
          path: "mirror/bin/data",
          sha: `blob-${Buffer.from([0, 255]).toString("base64")}`,
          mode: "100644",
        },
        {
          path: "mirror/run.sh",
          sha: `blob-${Buffer.from("run\n").toString("base64")}`,
          mode: "100755",
        },
        { path: "mirror/stale.bin", sha: null },
      ]),
    );
    expect(github.commits[0].changes).not.toContainEqual(
      expect.objectContaining({ path: "outside.txt" }),
    );

    await expect(service.pushConversation(input)).resolves.toMatchObject({
      status: "pushed",
      skipped: true,
    });
    expect(github.commits).toHaveLength(1);

    const nextSha = "b".repeat(40);
    worktree.lastAgentCommitSha = nextSha;
    worktree.wipOid = nextSha;
    await expect(
      service.pushConversation({ ...input, localSha: nextSha }),
    ).resolves.toMatchObject({ status: "pushed", remoteSha: "remote-2" });
    expect(github.commits[1].parentSha).toBe("remote-1");
  });

  it("reconciles a pending own webhook without a false conflict", async () => {
    const github = fakeClient();
    const state: FakeRemoteState = { remote: null };
    mockPersistence(state);
    github.setBeforeCommitReturn(async sha => {
      await handleAppsV2GitHubPushEvent({
        owner: "mako",
        repo: "app",
        branch: remoteBranch,
        after: sha,
        installationId: 42,
      });
    });
    const service = new AppV2GitHubPushService(
      github.client,
      async () => "token",
      async () => undefined,
      () => "race-operation",
    );

    await expect(
      service.pushConversation({
        workspaceId: workspaceId.toString(),
        projectId: projectId.toString(),
        chatId,
        actor: { userId: "owner" },
        localSha,
      }),
    ).resolves.toMatchObject({ status: "pushed", remoteSha: "remote-1" });
    expect(state.remote?.observedRemoteShas).toContain("remote-1");
    expect(state.remote?.pushStatus).toBe("pushed");
  });

  it("marks external advances as conflicts without forcing", async () => {
    const github = fakeClient();
    const state: FakeRemoteState = { remote: null };
    mockPersistence(state);
    const service = new AppV2GitHubPushService(
      github.client,
      async () => "token",
    );
    const input = {
      workspaceId: workspaceId.toString(),
      projectId: projectId.toString(),
      chatId,
      actor: { userId: "owner" },
      localSha,
    };
    await service.pushConversation(input);
    github.advanceRemote("external-sha");
    const nextSha = "c".repeat(40);
    worktree.lastAgentCommitSha = nextSha;
    worktree.wipOid = nextSha;

    await expect(
      service.pushConversation({ ...input, localSha: nextSha }),
    ).resolves.toMatchObject({ status: "conflict" });
    expect(github.commits).toHaveLength(1);
    expect(state.remote?.pushStatus).toBe("conflict");
  });

  it("rejects concurrent remote operations before resolving a token", async () => {
    const github = fakeClient();
    const state: FakeRemoteState = {
      remote: {
        _id: new Types.ObjectId(),
        workspaceId,
        projectId,
        chatId,
        actorId: "owner",
        remoteBranch,
        pushStatus: "failed",
        generation: 4,
        bindingGeneration: 1,
        bindingFingerprint,
        operationId: "other-operation",
        operationExpiresAt: new Date(Date.now() + 60_000),
        observedRemoteShas: [],
      } as unknown as IAppV2ChatRemote,
    };
    mockPersistence(state);
    const token = vi.fn(async () => "token");
    const service = new AppV2GitHubPushService(github.client, token);

    await expect(
      service.pushConversation({
        workspaceId: workspaceId.toString(),
        projectId: projectId.toString(),
        chatId,
        actor: { userId: "owner" },
        localSha,
      }),
    ).rejects.toThrow(/already owns/);
    expect(token).not.toHaveBeenCalled();
    expect(github.client.getRefCommit).not.toHaveBeenCalled();
  });

  it("revalidates the binding generation before creating a remote ref", async () => {
    const github = fakeClient();
    const state: FakeRemoteState = { remote: null };
    mockPersistence(state);
    vi.mocked(AppV2Project.updateOne).mockImplementation(
      async (_query, update) => {
        const mutation = update as unknown as {
          $set?: Record<string, unknown>;
        };
        return {
          matchedCount: mutation.$set?.["githubPushLease.expiresAt"] ? 0 : 1,
        } as never;
      },
    );
    const service = new AppV2GitHubPushService(
      github.client,
      async () => "token",
    );

    await expect(
      service.pushConversation({
        workspaceId: workspaceId.toString(),
        projectId: projectId.toString(),
        chatId,
        actor: { userId: "owner" },
        localSha,
      }),
    ).resolves.toMatchObject({
      status: "remote_failed",
      error: expect.stringContaining("binding changed"),
    });
    expect(github.client.createBranch).not.toHaveBeenCalled();
    expect(github.client.prepareCommit).not.toHaveBeenCalled();
  });

  it("supersedes an older failed SHA and pushes the latest local commit", async () => {
    const github = fakeClient();
    const state: FakeRemoteState = { remote: null };
    mockPersistence(state);
    const service = new AppV2GitHubPushService(
      github.client,
      async () => "token",
      async () => undefined,
    );
    const input = {
      workspaceId: workspaceId.toString(),
      projectId: projectId.toString(),
      chatId,
      actor: { userId: "owner" },
      localSha,
    };
    github.setFailCommits(true);
    await expect(service.pushConversation(input)).resolves.toMatchObject({
      status: "remote_failed",
      localSha,
    });

    const latestSha = "d".repeat(40);
    worktree.lastAgentCommitSha = latestSha;
    worktree.wipOid = latestSha;
    github.setFailCommits(false);
    await expect(service.pushConversation(input)).resolves.toMatchObject({
      status: "pushed",
      localSha: latestSha,
    });
    expect(state.remote).toMatchObject({
      lastSupersededLocalSha: localSha,
      lastPushedLocalSha: latestSha,
    });
    expect(graph.tree).toHaveBeenLastCalledWith(
      project.repositoryId,
      latestSha,
    );
  });

  it("pushes the same local SHA again when the binding identity changes", async () => {
    const github = fakeClient();
    const state: FakeRemoteState = {
      remote: {
        _id: new Types.ObjectId(),
        workspaceId,
        projectId,
        chatId,
        actorId: "owner",
        remoteBranch,
        lastPushedLocalSha: localSha,
        lastPushedRemoteSha: "old-remote",
        pushStatus: "pushed",
        generation: 3,
        bindingGeneration: 0,
        bindingFingerprint: "old-binding",
        observedRemoteShas: [],
      } as unknown as IAppV2ChatRemote,
    };
    mockPersistence(state);
    const service = new AppV2GitHubPushService(
      github.client,
      async () => "token",
    );

    await expect(
      service.pushConversation({
        workspaceId: workspaceId.toString(),
        projectId: projectId.toString(),
        chatId,
        actor: { userId: "owner" },
        localSha,
      }),
    ).resolves.toMatchObject({ status: "pushed" });

    expect(github.client.prepareCommit).toHaveBeenCalledOnce();
    expect(state.remote).toMatchObject({
      bindingGeneration: 1,
      bindingFingerprint,
      lastPushedLocalSha: localSha,
      lastPushedRemoteSha: "remote-1",
    });
  });

  it("reconciles an ambiguous successful PATCH without recreating its commit", async () => {
    const github = fakeClient();
    github.setFailRefUpdateAfterApply(true);
    const state: FakeRemoteState = { remote: null };
    mockPersistence(state);
    const service = new AppV2GitHubPushService(
      github.client,
      async () => "token",
      async () => undefined,
    );

    await expect(
      service.pushConversation({
        workspaceId: workspaceId.toString(),
        projectId: projectId.toString(),
        chatId,
        actor: { userId: "owner" },
        localSha,
      }),
    ).resolves.toMatchObject({ status: "pushed", remoteSha: "remote-1" });

    expect(github.client.prepareCommit).toHaveBeenCalledOnce();
    expect(state.remote).toMatchObject({
      pushStatus: "pushed",
      lastPushedRemoteSha: "remote-1",
    });
  });

  it("retries only the persisted ref update when PATCH failed before applying", async () => {
    const github = fakeClient();
    github.setFailRefUpdateBeforeApply(true);
    const state: FakeRemoteState = { remote: null };
    mockPersistence(state);
    const service = new AppV2GitHubPushService(
      github.client,
      async () => "token",
      async () => undefined,
    );
    const input = {
      workspaceId: workspaceId.toString(),
      projectId: projectId.toString(),
      chatId,
      actor: { userId: "owner" },
      localSha,
    };

    await expect(service.pushConversation(input)).resolves.toMatchObject({
      status: "remote_failed",
    });
    expect(state.remote).toMatchObject({
      intendedRemoteSha: "remote-1",
      intendedRemoteParentSha: "base-sha",
    });
    github.setFailRefUpdateBeforeApply(false);

    await expect(service.pushConversation(input)).resolves.toMatchObject({
      status: "pushed",
      remoteSha: "remote-1",
    });
    expect(github.client.prepareCommit).toHaveBeenCalledOnce();
  });

  it("conflicts when a prepared commit's parent advances before retry", async () => {
    const github = fakeClient();
    github.setFailRefUpdateBeforeApply(true);
    const state: FakeRemoteState = { remote: null };
    mockPersistence(state);
    const service = new AppV2GitHubPushService(
      github.client,
      async () => "token",
      async () => undefined,
    );
    const input = {
      workspaceId: workspaceId.toString(),
      projectId: projectId.toString(),
      chatId,
      actor: { userId: "owner" },
      localSha,
    };
    await service.pushConversation(input);
    github.setFailRefUpdateBeforeApply(false);
    github.advanceRemote("external-sha");

    await expect(service.pushConversation(input)).resolves.toMatchObject({
      status: "conflict",
    });
    expect(github.client.prepareCommit).toHaveBeenCalledOnce();
  });
});

describe("Apps v2 GitHub push webhooks", () => {
  it("requires installation scope, ignores own pushes, and records base movement", async () => {
    const remote = {
      _id: new Types.ObjectId(),
      workspaceId,
      projectId,
      chatId,
      actorId: "owner",
      remoteBranch,
      lastPushedRemoteSha: "own-sha",
      pushStatus: "pushed",
      generation: 2,
      bindingGeneration: 1,
      bindingFingerprint,
      observedRemoteShas: [],
    } as unknown as IAppV2ChatRemote;
    const state = { remote };
    mockPersistence(state);

    await expect(
      handleAppsV2GitHubPushEvent({
        owner: "mako",
        repo: "app",
        branch: remoteBranch,
        after: "external-sha",
        installationId: 99,
      }),
    ).resolves.toEqual({ matched: 0, conflicts: 0 });
    expect(remote.pushStatus).toBe("pushed");

    await handleAppsV2GitHubPushEvent({
      owner: "mako",
      repo: "app",
      branch: remoteBranch,
      after: "own-sha",
      installationId: 42,
    });
    expect(remote.pushStatus).toBe("pushed");

    await expect(
      handleAppsV2GitHubPushEvent({
        owner: "mako",
        repo: "app",
        branch: remoteBranch,
        after: "external-sha",
        installationId: 42,
      }),
    ).resolves.toEqual({ matched: 1, conflicts: 1 });
    expect(remote.pushStatus).toBe("conflict");
    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      workspaceId.toString(),
      expect.objectContaining({
        type: "app-v2.github.conflict",
        projectId: projectId.toString(),
        forUserId: "owner",
      }),
    );

    await handleAppsV2GitHubPushEvent({
      owner: "mako",
      repo: "app",
      branch: "main",
      after: "new-base",
      installationId: 42,
    });
    expect(project.github?.baseBranchHeadSha).toBe("new-base");
  });
});
