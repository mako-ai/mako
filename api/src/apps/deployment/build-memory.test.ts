/**
 * The publish box memory gate. On 18 Nov 2026 the shared publish box sat at
 * 2,018 of 2,079 MB for 34 min; 19 deploys failed with deadline_exceeded
 * because envd could not start even a 15 s probe. A build must never start
 * into a box that is out of memory.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../env.service", () => ({ resolveAppEnv: vi.fn(async () => ({})) }));

import {
  PUBLISH_BOX_MEMORY_SCRIPT,
  PUBLISH_BUILD_MIN_FREE_MB,
  PUBLISH_ORPHAN_AGE_S,
  PublishBoxLowMemoryError,
  buildApp,
  parseAvailableMb,
} from "./build";
import { PUBLISH_ACTOR, type WorktreeHandle } from "../worktree.service";

function handleFor(userId: string): WorktreeHandle {
  return {
    doc: { userId, workspaceId: "ws1" },
    project: { _id: "app1" },
    repoDir: "/tmp/repo",
    appRoot: "apps/x",
  } as unknown as WorktreeHandle;
}

/** A fake exec that reports `availMb` free and records every command. */
function fakeExec(availMb: number) {
  const commands: string[] = [];
  const exec = vi.fn(async (_handle: WorktreeHandle, command: string) => {
    commands.push(command);
    if (command === PUBLISH_BOX_MEMORY_SCRIPT) {
      return { exitCode: 0, stdout: `avail ${availMb}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return { exec, commands };
}

describe("publish box memory gate", () => {
  it("reads MemAvailable in MiB", () => {
    expect(parseAvailableMb("avail 1736\n")).toBe(1736);
    expect(parseAvailableMb("pruned\navail 58\n")).toBe(58);
    expect(parseAvailableMb("")).toBeNull();
  });

  it("reaps only build tools older than every exec timeout", () => {
    // Older than APPS_EXEC_MAX_TIMEOUT_MS (10 min): its caller gave up.
    expect(PUBLISH_ORPHAN_AGE_S).toBe(15 * 60);
    expect(PUBLISH_BOX_MEMORY_SCRIPT).toContain(`max=${PUBLISH_ORPHAN_AGE_S}`);
    expect(PUBLISH_BOX_MEMORY_SCRIPT).toContain("npm|pnpm|npx|vite|esbuild");
    expect(PUBLISH_BOX_MEMORY_SCRIPT).toContain("/proc/meminfo");
  });

  it("refuses to start a build in a box out of memory (the 18 Nov state)", async () => {
    // 2,079 - 2,018 = 61 MB free.
    const { exec, commands } = fakeExec(61);
    await expect(buildApp(handleFor(PUBLISH_ACTOR), exec)).rejects.toThrow(
      PublishBoxLowMemoryError,
    );
    // Nothing was installed or built.
    expect(commands.some(c => c.includes("npm run build"))).toBe(false);
    expect(commands.some(c => c.includes("node_modules/.mako-installed"))).toBe(
      false,
    );
  });

  it("builds when the box has enough memory", async () => {
    const { exec, commands } = fakeExec(PUBLISH_BUILD_MIN_FREE_MB);
    const result = await buildApp(handleFor(PUBLISH_ACTOR), exec);
    expect(result.ok).toBe(true);
    expect(commands.some(c => c.includes("npm run build"))).toBe(true);
  });

  it("never gates or reaps in a person's box (their dev servers live there)", async () => {
    const { exec, commands } = fakeExec(10);
    const result = await buildApp(handleFor("665f1c2a9b1e8a0012345678"), exec);
    expect(result.ok).toBe(true);
    expect(commands).not.toContain(PUBLISH_BOX_MEMORY_SCRIPT);
  });
});
