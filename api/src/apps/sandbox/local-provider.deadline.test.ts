import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  execFile: vi.fn(),
}));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: { ...actual, mkdir: mocks.mkdir, writeFile: mocks.writeFile },
  };
});
vi.mock("node:child_process", async original => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: mocks.execFile,
}));

import { LaunchDeadlineError } from "./launch-deadline";
import { localSandboxProvider as provider } from "./local-provider";
const ctx = { sessionKey: "synthetic-deadline" };
const options = (deadline: number) => ({
  timeoutMs: 30_000,
  remainingMs: () => deadline - Date.now(),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
  mocks.mkdir.mockReset();
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.writeFile.mockReset();
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.execFile.mockReset();
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
    callback(null, "ok", "");
  });
});

describe("local provider file write deadline", () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it("refuses a file write after directory setup expires", async () => {
    const deadline = Date.now() + 10_000;
    mocks.mkdir.mockImplementationOnce(async () => {
      vi.setSystemTime(deadline + 1);
    });

    await expect(
      provider.writeFile(ctx, `${provider.scratch(ctx)}/config.json`, bytes, {
        remainingMs: () => deadline - Date.now(),
      }),
    ).rejects.toBeInstanceOf(LaunchDeadlineError);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("checks each file in a batch", async () => {
    const deadline = Date.now() + 10_000;
    mocks.writeFile.mockImplementationOnce(async () => {
      vi.setSystemTime(deadline + 1);
    });
    const files = ["config.json", "catalog.json"].map(name => ({
      path: `${provider.scratch(ctx)}/${name}`,
      bytes,
    }));

    await expect(
      provider.writeFiles?.(ctx, files, {
        remainingMs: () => deadline - Date.now(),
      }),
    ).rejects.toBeInstanceOf(LaunchDeadlineError);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
  });
});
afterEach(() => vi.useRealTimers());

describe("local provider launch deadline", () => {
  it("refuses to start after directory setup expires", async () => {
    const deadline = Date.now() + 10_000;
    mocks.mkdir.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 10_001);
    });
    const result = await provider.exec(ctx, "synthetic", options(deadline));
    expect(result.timedOut).toBe(true);
    expect(result.preLaunchDeadline).toBe(true);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it("caps the launch timeout after setup", async () => {
    const deadline = Date.now() + 15_000;
    mocks.mkdir.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 5_000);
    });
    const result = await provider.exec(ctx, "synthetic", options(deadline));
    expect(result.exitCode).toBe(0);
    expect(mocks.execFile.mock.calls[0][2].timeout).toBe(10_000);
  });
  it("keeps the existing timeout with no deadline", async () => {
    expect(
      (await provider.exec(ctx, "synthetic", { timeoutMs: 30_000 })).exitCode,
    ).toBe(0);
    expect(mocks.execFile.mock.calls[0][2].timeout).toBe(30_000);
  });
});
