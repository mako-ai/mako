/**
 * writeFile asks git whether a path is ignored BEFORE writing it, so a
 * refused .env or node_modules/ path never reaches the disk; and the box
 * push lock runs one holder at a time per box.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as string[],
  ignored: new Set<string>(),
}));

vi.mock("../../database/workspace-schema", () => ({ AppWorktree: {} }));
vi.mock("../../logging", () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  return { loggers: new Proxy({}, { get: () => () => logger }) };
});
vi.mock("../repository.service", () => ({ DEFAULT_BRANCH: "main" }));
vi.mock("../app-index.service", () => ({ readIndexedAppsAt: vi.fn() }));
vi.mock("../cloud-repo.service", () => ({ ensureCommitLocally: vi.fn() }));
vi.mock("./worktrees", () => ({
  PUBLISH_ACTOR: "publish",
  syncBranchFromBox: vi.fn(),
}));
vi.mock("./box-session", () => ({
  boxCtx: () => ({ sessionKey: "box" }),
  ensureBox: vi.fn(async () => ({ sessionKey: "box" })),
  lastPull: new Map(),
  isMissingCwd: () => false,
  rehydrateBox: vi.fn(),
}));
vi.mock("../box", () => ({
  boxRoot: () => "/home/user/app",
  sh: (value: string) => `'${value}'`,
  boxWriteFile: vi.fn(async (_ctx: unknown, path: string) => {
    state.events.push(`write ${path}`);
  }),
  boxGlob: vi.fn(),
  boxGrep: vi.fn(),
  boxHasRepo: vi.fn(),
  boxListFiles: vi.fn(),
  boxPull: vi.fn(),
  boxPushIfAhead: vi.fn(),
  boxReadFile: vi.fn(),
}));
vi.mock("../sandbox/provider", () => ({
  getSandboxProvider: () => ({
    exec: vi.fn(async (_ctx: unknown, command: string) => {
      const path = /check-ignore -q '(.+)'$/.exec(command)?.[1] ?? "";
      state.events.push(`check ${path}`);
      return { exitCode: state.ignored.has(path) ? 0 : 1 };
    }),
  }),
}));

const handle = {
  appRoot: "",
  repoDir: "/repo",
  doc: { branch: "main", userId: "u1" },
} as never;

beforeEach(() => {
  state.events = [];
  state.ignored = new Set([".env", "node_modules/x/index.js"]);
});

describe("writeFile", () => {
  it("refuses an ignored path before anything is written", async () => {
    const { writeFile } = await import("./files");
    for (const path of [".env", "node_modules/x/index.js"]) {
      await expect(writeFile(handle, path, "SECRET=1")).rejects.toThrow(
        /ignored by git/,
      );
    }
    expect(state.events.filter(e => e.startsWith("write"))).toEqual([]);
  });

  it("checks first, then writes a tracked path", async () => {
    const { writeFile } = await import("./files");
    await writeFile(handle, "dbt/models/a.sql", "select 1");
    expect(state.events).toEqual([
      "check dbt/models/a.sql",
      "write dbt/models/a.sql",
    ]);
  });
});

describe("withBoxPushLock", () => {
  it("runs one holder at a time per box, in order, and survives a throw", async () => {
    const { withBoxPushLock } = await import("./files");
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withBoxPushLock("box", async () => {
      order.push("first start");
      await new Promise<void>(resolve => (releaseFirst = resolve));
      order.push("first end");
      throw new Error("first failed");
    });
    const second = withBoxPushLock("box", async () => {
      order.push("second");
    });
    const other = withBoxPushLock("other-box", async () => {
      order.push("other box");
    });
    await other;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual(["first start", "other box"]);
    releaseFirst();
    await expect(first).rejects.toThrow(/first failed/);
    await second;
    expect(order).toEqual(["first start", "other box", "first end", "second"]);
  });
});
