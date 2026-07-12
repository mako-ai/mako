import { afterEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import {
  AppV2ChatTurn,
  AppV2Session,
  Chat,
  type IAppV2ChatTurn,
  type IAppV2ChatTurnProject,
  type IAppV2Project,
  type IAppV2Worktree,
} from "../database/workspace-schema";
import {
  finalizeAppsV2ChatTurn,
  requiresSessionReconciliation,
  type AppsV2ChatTurnFinalizerDependencies,
} from "./chat-turn-finalizer";
import { claimAppsV2ChatTurnFinalization } from "./chat-turn.service";

const workspaceId = new Types.ObjectId();
const projectId = new Types.ObjectId();
const worktreeId = new Types.ObjectId();
const chatId = new Types.ObjectId().toString();
const turnId = "turn-123";
const actorId = "agent-user";
const initialOid = "a".repeat(40);

const project = {
  _id: projectId,
  workspaceId,
  repositoryId: projectId.toString(),
  defaultBranch: "main",
  headSha: initialOid,
} as unknown as IAppV2Project;

function worktree(revision = 1, wipOid = "b".repeat(40)): IAppV2Worktree {
  return {
    _id: worktreeId,
    workspaceId,
    projectId,
    actorId,
    kind: "agent",
    contextKey: `chat:${chatId}`,
    chatId,
    activeTurnId: turnId,
    branch: `mako/chat/${chatId}`,
    baseSha: initialOid,
    wipRef: `refs/mako/worktrees/${worktreeId.toString()}`,
    wipOid,
    leaseRef: `refs/mako/leases/${worktreeId.toString()}`,
    leaseOid: "c".repeat(40),
    revision,
    leaseEpoch: 1,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as IAppV2Worktree;
}

function harness(
  options: {
    flushFails?: boolean;
    recoveryRef?: string;
    newerRevision?: boolean;
    noSessionProvider?: boolean;
    pushFails?: boolean;
    crashAfterLocalPersist?: boolean;
    crashAfterLocalCommit?: boolean;
  } = {},
) {
  let clean = false;
  let claimed = false;
  let current = worktree(options.newerRevision ? 2 : 1);
  const touched: IAppV2ChatTurnProject = {
    projectId,
    worktreeId,
    expectedRevision: 1,
    status: "pending",
  };
  const turn = {
    workspaceId,
    chatId,
    turnId,
    actorId,
    status: "active",
    touchedProjects: [touched],
    isAborted: false,
    attemptCount: 0,
  } as unknown as IAppV2ChatTurn;
  let commitMessage = "";
  const commit = vi.fn(async (...args: unknown[]) => {
    commitMessage = String(args[3]);
    clean = true;
    const committedSha = "d".repeat(40);
    current = {
      ...worktree(current.revision + 1, committedSha),
      activeTurnId: turnId,
      baseSha: committedSha,
      lastAgentCommitSha: committedSha,
    } as IAppV2Worktree;
    return { worktree: current, sha: committedSha };
  });
  const flush = options.flushFails
    ? vi.fn(async () => {
        throw new Error("sandbox missing");
      })
    : vi.fn(async () => ({
        worktree: current,
        flush: options.recoveryRef
          ? {
              durability: {
                status: "conflict" as const,
                recoveryRef: options.recoveryRef,
              },
            }
          : {
              durability: {
                status: "durable" as const,
                revision: {
                  wipOid: current.wipOid,
                  revision: current.revision,
                },
              },
            },
      }));
  const persist = vi.fn(
    async (_identity: unknown, result: IAppV2ChatTurnProject) => {
      turn.touchedProjects = [result];
    },
  );
  const finish = vi.fn(async (_identity: unknown, status: string) => {
    turn.status = status as IAppV2ChatTurn["status"];
  });
  const push = options.pushFails
    ? vi.fn(async () => ({
        status: "remote_failed" as const,
        error: "GitHub unavailable",
      }))
    : vi.fn(async () => ({ status: "local_only" as const, skipped: true }));
  let shouldCrash = options.crashAfterLocalPersist ?? false;
  const dependencies = {
    services: () => ({
      projects: {
        getWritable: vi.fn(async () => project),
        git: {
          resolveBranch: vi.fn(async () => current.lastAgentCommitSha),
          getCommit: vi.fn(async (_repositoryId, sha) => ({
            sha,
            treeSha: "expected-tree",
            parentShas:
              sha === current.lastAgentCommitSha ? [initialOid] : [initialOid],
            message: sha === current.lastAgentCommitSha ? commitMessage : "WIP",
          })),
        },
      },
      worktrees: {
        getById: vi.fn(async () => current),
        status: vi.fn(async () => ({ clean, changes: clean ? [] : [{}] })),
        commit,
      },
      sessions: options.noSessionProvider
        ? undefined
        : {
            ensure: vi.fn(async () => ({ session: {}, worktree: current })),
            flush,
          },
    }),
    shouldFlush: vi.fn(async () => true),
    actor: vi.fn(async () => ({ userId: actorId })),
    assertOwnership: vi.fn(async () => undefined),
    claim: vi.fn(async (_identity, _isAborted, retry) => {
      if (claimed && !retry) return null;
      claimed = true;
      turn.status = "finalizing";
      return turn;
    }),
    get: vi.fn(async () => turn),
    persist,
    finish,
    release: vi.fn(async () => undefined),
    push,
    afterLocalResultPersisted: vi.fn(async () => {
      if (!shouldCrash) return;
      shouldCrash = false;
      throw new Error("injected process crash");
    }),
    afterLocalCommit: vi.fn(async () => {
      if (options.crashAfterLocalCommit) {
        options.crashAfterLocalCommit = false;
        throw new Error("injected crash after Git commit");
      }
    }),
    publish: vi.fn(),
  } as unknown as AppsV2ChatTurnFinalizerDependencies;
  return { dependencies, turn, commit, flush, persist, push };
}

const input = {
  workspaceId: workspaceId.toString(),
  chatId,
  turnId,
  actorId,
  isAborted: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Apps v2 durable chat turn finalization", () => {
  it("reconciles every session state except destroyed and revoked", async () => {
    const exists = vi.spyOn(AppV2Session, "exists").mockResolvedValue(null);

    await requiresSessionReconciliation(worktreeId.toString());

    expect(exists).toHaveBeenCalledWith({
      worktreeId,
      status: { $nin: ["destroyed", "revoked"] },
    });
  });

  it("commits a fenced dirty revision once and replays the persisted result", async () => {
    const test = harness();
    const first = await finalizeAppsV2ChatTurn(input, test.dependencies);
    const duplicate = await finalizeAppsV2ChatTurn(input, test.dependencies);

    expect(first).toMatchObject({
      status: "completed",
      projects: [{ status: "committed", expectedRevision: 1 }],
    });
    expect(duplicate.projects).toMatchObject([{ status: "committed" }]);
    expect(test.commit).toHaveBeenCalledOnce();
    expect(test.push).toHaveBeenCalledWith(
      expect.objectContaining({
        localSha: "d".repeat(40),
        requireAutoPush: true,
      }),
    );
  });

  it("keeps the local commit durable when remote push fails and retries without recommitting", async () => {
    const test = harness({ pushFails: true });
    const first = await finalizeAppsV2ChatTurn(input, test.dependencies);
    expect(first).toMatchObject({
      status: "remote_failed",
      projects: [
        {
          status: "committed",
          localOutcome: "committed_local",
          remoteStatus: "remote_failed",
          remoteError: "GitHub unavailable",
        },
      ],
    });
    expect(test.commit).toHaveBeenCalledOnce();

    test.turn.status = "remote_failed";
    test.push.mockResolvedValueOnce({
      status: "pushed",
      remoteSha: "e".repeat(40),
    });
    const retried = await finalizeAppsV2ChatTurn(
      {
        ...input,
        retry: true,
        retryLeaseId: "retry-remote",
        allowRemoteOnlyRetry: true,
      },
      test.dependencies,
    );
    expect(retried).toMatchObject({
      status: "completed",
      projects: [{ status: "committed", remoteStatus: "pushed" }],
    });
    expect(test.commit).toHaveBeenCalledOnce();
    expect(test.push).toHaveBeenCalledTimes(2);
    expect(test.dependencies.claim).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowRemoteOnlyRetry: true }),
      false,
      true,
    );
  });

  it("recovers a crash after durable local-result persistence without recommitting", async () => {
    const test = harness({ crashAfterLocalPersist: true });

    await expect(
      finalizeAppsV2ChatTurn(input, test.dependencies),
    ).rejects.toThrow("injected process crash");
    expect(test.turn.touchedProjects[0]).toMatchObject({
      status: "committed",
      sha: "d".repeat(40),
      localOutcome: "committed_local",
      remoteStatus: "local_only",
    });
    expect(test.commit).toHaveBeenCalledOnce();
    expect(test.push).not.toHaveBeenCalled();

    test.push.mockResolvedValueOnce({
      status: "pushed",
      remoteSha: "e".repeat(40),
    });
    const retried = await finalizeAppsV2ChatTurn(
      { ...input, retry: true, retryLeaseId: "crash-retry" },
      test.dependencies,
    );

    expect(retried).toMatchObject({
      status: "completed",
      projects: [{ status: "committed", remoteStatus: "pushed" }],
    });
    expect(test.commit).toHaveBeenCalledOnce();
    expect(test.push).toHaveBeenCalledOnce();
  });

  it("recovers the exact marked commit after a crash before local-result persistence", async () => {
    const test = harness({ crashAfterLocalCommit: true });

    await expect(
      finalizeAppsV2ChatTurn(input, test.dependencies),
    ).rejects.toThrow("injected crash after Git commit");
    expect(test.turn.touchedProjects[0]).toMatchObject({
      status: "pending",
      commitIntent: {
        turnId,
        expectedRevision: 1,
        expectedWipOid: "b".repeat(40),
        expectedBaseSha: initialOid,
      },
    });
    expect(test.commit).toHaveBeenCalledOnce();

    const retried = await finalizeAppsV2ChatTurn(
      { ...input, retry: true, retryLeaseId: "post-git-crash" },
      test.dependencies,
    );

    expect(retried).toMatchObject({
      status: "completed",
      projects: [
        {
          status: "committed",
          sha: "d".repeat(40),
          localOutcome: "committed_local",
        },
      ],
    });
    expect(test.commit).toHaveBeenCalledOnce();
    expect(test.push).toHaveBeenCalledOnce();
  });

  it("keeps an ambiguous post-intent advance fenced for recovery", async () => {
    const test = harness({ crashAfterLocalCommit: true });
    await expect(
      finalizeAppsV2ChatTurn(input, test.dependencies),
    ).rejects.toThrow("injected crash after Git commit");
    const current = await test.dependencies
      .services()
      .worktrees.getById(project, worktreeId.toString(), { userId: actorId });
    current.lastAgentCommitSha = "e".repeat(40);
    current.baseSha = "e".repeat(40);
    current.wipOid = "e".repeat(40);
    current.revision += 1;

    const retried = await finalizeAppsV2ChatTurn(
      { ...input, retry: true, retryLeaseId: "ambiguous-crash" },
      test.dependencies,
    );

    expect(retried).toMatchObject({
      status: "recoverable",
      projects: [{ status: "recoverable" }],
    });
    expect(test.dependencies.release).not.toHaveBeenCalled();
    expect(test.commit).toHaveBeenCalledOnce();
  });

  it("commits a superseded predecessor from its recorded revision during handoff", async () => {
    const test = harness();
    test.turn.status = "superseded";

    const result = await finalizeAppsV2ChatTurn(
      {
        ...input,
        retry: true,
        retryLeaseId: "handoff-lease",
        allowSupersededRetry: true,
      },
      test.dependencies,
    );

    expect(result).toMatchObject({
      status: "completed",
      projects: [{ status: "committed", expectedRevision: 1 }],
    });
    expect(test.commit).toHaveBeenCalledOnce();
  });

  it("passes superseded-retry identity to the real claim service", async () => {
    const test = harness();
    test.turn.status = "superseded";
    const ownerLookup = vi.spyOn(Chat, "exists");
    const claim = vi
      .spyOn(AppV2ChatTurn, "findOneAndUpdate")
      .mockResolvedValue(null);
    test.dependencies.claim = claimAppsV2ChatTurnFinalization;

    await finalizeAppsV2ChatTurn(
      {
        ...input,
        retry: true,
        retryLeaseId: "real-service-lease",
        allowSupersededRetry: true,
      },
      test.dependencies,
    );

    expect(ownerLookup).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        $and: expect.arrayContaining([
          expect.objectContaining({ status: "superseded" }),
        ]),
      }),
      expect.any(Object),
      { new: true },
    );
  });

  it("requires durable chat ownership after claiming finalization", async () => {
    const test = harness();
    test.dependencies.assertOwnership = vi.fn(async () => {
      throw new Error("A newer chat turn superseded finalization");
    });

    await expect(
      finalizeAppsV2ChatTurn(input, test.dependencies),
    ).rejects.toThrow(/superseded finalization/);
    expect(test.commit).not.toHaveBeenCalled();
  });

  it("marks a newer worktree revision superseded without committing it", async () => {
    const test = harness({ newerRevision: true });
    const result = await finalizeAppsV2ChatTurn(input, test.dependencies);

    expect(result).toMatchObject({
      status: "superseded",
      projects: [{ status: "superseded" }],
    });
    expect(test.commit).not.toHaveBeenCalled();
    expect(test.flush).not.toHaveBeenCalled();
  });

  it("fails closed when sandbox flush fails", async () => {
    const test = harness({ flushFails: true });
    const result = await finalizeAppsV2ChatTurn(
      { ...input, isAborted: true },
      test.dependencies,
    );

    expect(result).toMatchObject({
      status: "failed",
      projects: [{ status: "failed", error: "sandbox missing" }],
    });
    expect(test.commit).not.toHaveBeenCalled();
  });

  it("fails closed when a live session cannot be reconciled", async () => {
    const test = harness({ noSessionProvider: true });
    const result = await finalizeAppsV2ChatTurn(input, test.dependencies);

    expect(result).toMatchObject({
      status: "failed",
      projects: [
        {
          status: "failed",
          error: expect.stringContaining("provider is unavailable"),
        },
      ],
    });
    expect(test.commit).not.toHaveBeenCalled();
  });

  it("persists recovery refs without committing older WIP", async () => {
    const recoveryRef = `refs/mako/recovery/${worktreeId}/abc`;
    const test = harness({ recoveryRef });
    const result = await finalizeAppsV2ChatTurn(input, test.dependencies);

    expect(result).toMatchObject({
      status: "recoverable",
      projects: [{ status: "recoverable", recoveryRef }],
    });
    expect(test.commit).not.toHaveBeenCalled();
  });
});
