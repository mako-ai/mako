import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createProvider: vi.fn(() => ({ name: "fake-provider" })),
  executorConstructions: [] as unknown[][],
  sessionConstructions: [] as unknown[][],
}));

vi.mock("./app-project.service", () => ({
  AppV2ProjectService: class {},
}));

vi.mock("./worktree.service", () => ({
  AppV2WorktreeService: class {
    constructor(_projects: unknown) {}
  },
}));

vi.mock("./cloud-session-executor", () => ({
  CloudSessionExecutor: class {
    constructor(...arguments_: unknown[]) {
      mocks.executorConstructions.push(arguments_);
    }
  },
}));

vi.mock("./session.service", () => ({
  AppV2SessionService: class {
    constructor(...arguments_: unknown[]) {
      mocks.sessionConstructions.push(arguments_);
    }
  },
}));

vi.mock("./providers/sandbox-provider-factory", () => ({
  createAppsV2SandboxProvider: mocks.createProvider,
}));

import { getAppV2Services } from "./service-factory";

describe("Apps v2 service factory", () => {
  it("shares one provider and executor across callers", () => {
    const first = getAppV2Services();
    const second = getAppV2Services();

    expect(second).toEqual(first);
    expect(mocks.createProvider).toHaveBeenCalledOnce();
    expect(mocks.executorConstructions).toHaveLength(1);
    expect(mocks.sessionConstructions).toHaveLength(1);
    expect(first.sessionExecutor).toBeDefined();
    expect(mocks.sessionConstructions[0][1]).toBe(first.sessionExecutor);
  });
});
