/**
 * The hourly reconcile deploys apps that lag main. On 2026-11-03 its 04:17 run
 * found an app already deploying that commit and sent a second deploy, which
 * cancelled the run without stopping its step: two walks of one commit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../client", () => ({
  inngest: {
    createFunction: vi.fn(
      (_options: unknown, handler: (ctx: unknown) => unknown) => ({ handler }),
    ),
    send: vi.fn(async () => ({})),
  },
}));
vi.mock("../../database/workspace-schema", () => ({
  AppProject: {
    find: vi.fn(() => ({
      select: () => ({ lean: async () => state.rows }),
    })),
    updateOne: vi.fn(),
  },
}));
vi.mock("../../apps/deployment.service", () => ({
  recordDeployFailure: vi.fn(),
}));
vi.mock("../../apps/deploy-on-push", () => ({
  DeployBindingsError: class extends Error {},
  deployOneApp: vi.fn(),
  appFolderChanged: vi.fn(async () => true),
}));
vi.mock("../../apps/worktree.service", () => ({
  repoForWorkspace: vi.fn(async () => "/repo"),
  resolveProjectRef: vi.fn(),
}));
vi.mock("../../apps/deploy-commit-status", () => ({
  describeDeployFailure: vi.fn(),
  describeDeployOutcome: vi.fn(),
  reportAppDeployStatus: vi.fn(),
}));

const head = "9".repeat(40);
vi.mock("../../apps/repository.service", () => ({
  resolveCommit: vi.fn(async () => "9".repeat(40)),
}));

import { appsDeployReconcileFunction } from "./apps-deploy";

const run = async () => {
  const sendEvent = vi.fn(async () => undefined);
  const stepOutputs = new Map<string, unknown>();
  await (
    appsDeployReconcileFunction as unknown as {
      handler: (ctx: unknown) => Promise<unknown>;
    }
  ).handler({
    step: {
      run: async (name: string, fn: () => unknown) => {
        const out = await fn();
        stepOutputs.set(name, out);
        return out;
      },
      sendEvent,
    },
  });
  return { sendEvent, stepOutputs };
};

const row = (deployProgress?: Record<string, unknown>) => ({
  _id: "app",
  workspaceId: "ws",
  path: "apps/web-performance",
  publishedSha: "1".repeat(40),
  deployProgress,
});

beforeEach(() => {
  state.rows = [];
});

describe("apps-deploy-reconcile", () => {
  it("re-enqueues an app that lags main with nothing in flight", async () => {
    state.rows = [row()];

    const { sendEvent } = await run();

    expect(sendEvent).toHaveBeenCalledWith("deploy", [
      {
        name: "apps/deploy.requested",
        data: {
          workspaceId: "ws",
          appId: "app",
          sha: head,
          reason: "reconcile",
        },
      },
    ]);
  });

  it("leaves a progressing deploy of main alone", async () => {
    const now = new Date();
    state.rows = [
      row({
        sha: head,
        stage: "bindings",
        startedAt: now,
        stageStartedAt: now,
        updatedAt: now,
      }),
    ];

    const { sendEvent } = await run();

    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("takes over when that deploy stopped progressing", async () => {
    const longAgo = new Date(Date.now() - 60 * 60_000);
    state.rows = [
      row({
        sha: head,
        stage: "bindings",
        startedAt: longAgo,
        stageStartedAt: longAgo,
        updatedAt: longAgo,
      }),
    ];

    const { sendEvent } = await run();

    expect(sendEvent).toHaveBeenCalledTimes(1);
  });

  it("projects only minimal non-secret fields in the list-published Inngest step output", async () => {
    state.rows = [
      {
        ...row(),
        slug: "web-performance",
        title: "Web Perf",
        env: [
          {
            key: "DATABASE_SECRET",
            valueEncrypted: "enc:top-secret-env-value",
          },
        ],
        publicShare: {
          enabled: true,
          token: "secret-share-token",
          passwordHash: "$2b$10$secretbcryptpasswordhash",
          passwordEncrypted: "enc:secret-share-password",
        },
        sharedWith: [{ userId: "user-1", role: "editor" }],
      },
    ];

    const { stepOutputs } = await run();
    const listPublished = stepOutputs.get("list-published") as Array<
      Record<string, unknown>
    >;
    expect(listPublished).toHaveLength(1);
    expect(Object.keys(listPublished[0]).sort()).toEqual([
      "deployProgress",
      "id",
      "lastDeployError",
      "path",
      "publishedSha",
      "slug",
      "workspaceId",
    ]);
    const serialized = JSON.stringify(listPublished);
    expect(serialized).not.toContain("top-secret-env-value");
    expect(serialized).not.toContain("secretbcryptpasswordhash");
    expect(serialized).not.toContain("secret-share-password");
    expect(serialized).not.toContain("secret-share-token");
    expect(serialized).not.toContain("sharedWith");
  });
});
