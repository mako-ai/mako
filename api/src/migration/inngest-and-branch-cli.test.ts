import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NonRetriableError } from "inngest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSyncRetryHandlersForTests,
  dispatchSyncRetry,
  isSyncRetryStale,
  MIGRATION_SYNC_RETRY_CONCURRENCY_KEY,
  migrationMongoSyncRetryFunction,
  migrationPgSyncRetryFunction,
  registerSyncRetryHandler,
} from "../inngest/functions/migration/sync-retry";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const NEON_BRANCH_SCRIPT = path.join(REPO_ROOT, "scripts/neon-branch.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");

function concurrencyOf(fn: unknown): unknown {
  return (fn as { opts: { concurrency?: unknown } }).opts.concurrency;
}

describe("migration Inngest sync-retry & scripts/neon-branch.ts guards", () => {
  afterEach(() => {
    clearSyncRetryHandlersForTests();
  });

  it("configures per-entity concurrency keys on both PG and Mongo sync-retry Inngest functions", () => {
    for (const fn of [
      migrationPgSyncRetryFunction,
      migrationMongoSyncRetryFunction,
    ]) {
      const concurrency = concurrencyOf(fn) as Array<{
        limit: number;
        key?: string;
      }>;
      expect(Array.isArray(concurrency)).toBe(true);
      expect(concurrency).toContainEqual({
        limit: 1,
        key: MIGRATION_SYNC_RETRY_CONCURRENCY_KEY,
      });
      expect(MIGRATION_SYNC_RETRY_CONCURRENCY_KEY).toBe(
        "event.data.domain + ':' + event.data.entityId",
      );
    }
  });

  it("fails loudly with NonRetriableError when no sync-retry handler is registered instead of dropping events", async () => {
    const eventData = {
      target: "pg" as const,
      domain: "unregistered_test_domain",
      operation: "createUser",
      entityId: "user_1",
      idempotencyKey: "0193694c-a920-7000-8000-000000000001",
      updatedAt: "2026-11-27T08:00:00.000Z",
      failedAt: "2026-11-27T08:00:01.000Z",
      errorMessage: "timeout",
    };

    await expect(dispatchSyncRetry("pg", eventData)).rejects.toThrow(
      NonRetriableError,
    );
    await expect(
      dispatchSyncRetry("mongo", { ...eventData, target: "mongo" }),
    ).rejects.toThrow(NonRetriableError);

    // Once registered, replays cleanly and forwards idempotency metadata
    const handler = vi.fn(async () => undefined);
    registerSyncRetryHandler("pg", "unregistered_test_domain", handler);
    const result = await dispatchSyncRetry("pg", eventData);
    expect(result).toEqual({
      status: "replayed",
      domain: "unregistered_test_domain",
      entityId: "user_1",
      idempotencyKey: eventData.idempotencyKey,
    });
    expect(handler).toHaveBeenCalledWith(eventData);

    // Stale-write helper catches older timestamps and allows equal/newer ones
    expect(
      isSyncRetryStale("2026-11-27T08:00:00.000Z", "2026-11-27T08:00:05.000Z"),
    ).toBe(true);
    expect(
      isSyncRetryStale("2026-11-27T08:00:05.000Z", "2026-11-27T08:00:05.000Z"),
    ).toBe(false);
    expect(
      isSyncRetryStale("2026-11-27T08:00:10.000Z", "2026-11-27T08:00:05.000Z"),
    ).toBe(false);
    expect(isSyncRetryStale(undefined, "2026-11-27T08:00:05.000Z")).toBe(false);
  });

  it("rejects shared/protected branches in neon-branch.ts and masks URLs before writing GITHUB_OUTPUT", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-neon-branch-"));
    const fakeBinDir = path.join(tmpDir, "bin");
    const callLogFile = path.join(tmpDir, "neonctl.log");
    const githubOutputFile = path.join(tmpDir, "github-output.txt");
    fs.mkdirSync(fakeBinDir);

    // Create a fake neonctl executable that records every invocation and returns stub JSON/URLs
    const fakeNeonctl = path.join(fakeBinDir, "neonctl");
    fs.writeFileSync(
      fakeNeonctl,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLogFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "branches" && args[1] === "list") {
  console.log(JSON.stringify([
    { id: "br-main", name: "main", default: true },
    { id: "br-staging", name: "staging", default: false },
    { id: "br-dev-alice", name: "dev-alice", default: false }
  ]));
} else if (args[0] === "branches" && args[1] === "create") {
  const nameIdx = args.indexOf("--name");
  console.log(JSON.stringify({ branch: { id: "br-new", name: args[nameIdx + 1], default: false } }));
} else if (args[0] === "branches" && args[1] === "reset") {
  console.log("ok");
} else if (args[0] === "connection-string") {
  const pooled = args.includes("--pooled");
  console.log(pooled
    ? "postgresql://neondb_owner:super-secret-pass@ep-cool-pooler.neon.tech/neondb?sslmode=require"
    : "postgresql://neondb_owner:super-secret-pass@ep-cool.neon.tech/neondb?sslmode=require");
}
`,
      { mode: 0o755 },
    );

    const runCli = (args: string[], extraEnv: Record<string, string> = {}) => {
      try {
        const stdout = execFileSync(TSX_BIN, [NEON_BRANCH_SCRIPT, ...args], {
          cwd: tmpDir,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
            NEON_PROJECT_ID: "proj-test-123",
            ...extraEnv,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { exitCode: 0, stdout, stderr: "" };
      } catch (error) {
        const e = error as {
          status?: number;
          stdout?: string;
          stderr?: string;
        };
        return {
          exitCode: e.status ?? 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
        };
      }
    };

    try {
      // 1. Refuse protected/shared names and non-`dev-` branches in reset-dev & create-dev
      for (const [cmd, branch] of [
        ["reset-dev", "staging"],
        ["reset-dev", "main"],
        ["reset-dev", "master"],
        ["reset-dev", "production"],
        ["reset-dev", "prod"],
        ["reset-dev", "integration"],
        ["create-dev", "main"],
        ["create-dev", "staging"],
        ["create-dev", "custom-branch"],
        ["resolve-integration", "main"],
        ["resolve-integration", "staging"],
      ]) {
        const res = runCli([cmd, branch]);
        expect(res.exitCode).not.toBe(0);
        expect(res.stderr).toMatch(/refusing|must start with "dev-"/i);
      }
      // Protected rejections must NEVER invoke neonctl
      expect(fs.existsSync(callLogFile)).toBe(false);

      // 2. Allowed dev-alice reset-dev succeeds and logs accurate parent message
      const resetOk = runCli(["reset-dev", "dev-alice"]);
      expect(resetOk.exitCode).toBe(0);
      expect(resetOk.stdout).toMatch(
        /Resetting Neon branch dev-alice to its parent branch/,
      );
      expect(fs.readFileSync(path.join(tmpDir, ".env"), "utf8")).toContain(
        "POSTGRES_URL=postgresql://neondb_owner:super-secret-pass@ep-cool-pooler.neon.tech/neondb?sslmode=require",
      );

      // 3. resolve-preview masks connection URLs via ::add-mask:: BEFORE writing GITHUB_OUTPUT
      const preview = runCli(["resolve-preview", "1552"], {
        GITHUB_OUTPUT: githubOutputFile,
      });
      expect(preview.exitCode).toBe(0);
      expect(preview.stdout).toContain(
        "::add-mask::postgresql://neondb_owner:super-secret-pass@ep-cool-pooler.neon.tech/neondb?sslmode=require",
      );
      expect(preview.stdout).toContain(
        "::add-mask::postgresql://neondb_owner:super-secret-pass@ep-cool.neon.tech/neondb?sslmode=require",
      );
      expect(preview.stdout).not.toContain("::add-mask::preview-pr-1552");

      const ghOut = fs.readFileSync(githubOutputFile, "utf8");
      expect(ghOut).toContain("branch=preview-pr-1552\n");
      expect(ghOut).toContain(
        "postgres_url=postgresql://neondb_owner:super-secret-pass@ep-cool-pooler.neon.tech/neondb?sslmode=require\n",
      );
      expect(ghOut).toContain(
        "postgres_direct_url=postgresql://neondb_owner:super-secret-pass@ep-cool.neon.tech/neondb?sslmode=require\n",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
