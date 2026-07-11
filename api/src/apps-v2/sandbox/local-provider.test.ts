/**
 * Local sandbox provider — containment behavior tests (dev provider).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localSandboxProvider } from "./local-provider";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "apps-v2-sbx-test-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("localSandboxProvider", () => {
  it("runs commands in the session root with exit codes and output", async () => {
    const ok = await localSandboxProvider.exec(root, "pwd && echo out && echo err >&2");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain(root);
    expect(ok.stdout).toContain("out");
    expect(ok.stderr).toContain("err");

    const fail = await localSandboxProvider.exec(root, "exit 3");
    expect(fail.exitCode).toBe(3);
  });

  it("rejects cwd escaping the session root", async () => {
    await expect(
      localSandboxProvider.exec(root, "pwd", { cwd: "../.." }),
    ).rejects.toThrow(/escapes/);
  });

  it("kills commands at the timeout", async () => {
    const started = Date.now();
    const result = await localSandboxProvider.exec(root, "sleep 30", {
      timeoutMs: 1_000,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("builds the environment from scratch (no API secrets)", async () => {
    process.env.SUPER_SECRET_TEST_VALUE = "do-not-leak";
    try {
      const result = await localSandboxProvider.exec(root, "env");
      expect(result.stdout).not.toContain("do-not-leak");
      expect(result.stdout).toContain("PATH=");
    } finally {
      delete process.env.SUPER_SECRET_TEST_VALUE;
    }
  });

  it("caps runaway output and flags truncation", async () => {
    const result = await localSandboxProvider.exec(
      root,
      "yes 0123456789 | head -c 3000000",
      { timeoutMs: 30_000 },
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1_000_001);
  });
});
