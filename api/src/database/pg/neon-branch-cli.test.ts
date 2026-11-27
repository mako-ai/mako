import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const NEON_BRANCH_SCRIPT = path.join(REPO_ROOT, "scripts/neon-branch.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");

describe("scripts/neon-branch.ts guards", () => {
  it("rejects shared/protected branches in neon-branch.ts and masks URLs before writing GITHUB_OUTPUT", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-neon-branch-"));
    const fakeBinDir = path.join(tmpDir, "bin");
    const callLogFile = path.join(tmpDir, "neonctl.log");
    const githubOutputFile = path.join(tmpDir, "github-output.txt");
    fs.mkdirSync(fakeBinDir);

    const fakeNeonctl = path.join(fakeBinDir, "neonctl");
    fs.writeFileSync(
      fakeNeonctl,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLogFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "branches" && args[1] === "list") {
  console.log(JSON.stringify([
    { id: "br-main", name: "production", default: true },
    { id: "br-test", name: "test", default: false },
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
      for (const [cmd, branch] of [
        ["reset-dev", "test"],
        ["reset-dev", "staging"],
        ["reset-dev", "main"],
        ["reset-dev", "master"],
        ["reset-dev", "production"],
        ["reset-dev", "prod"],
        ["reset-dev", "integration"],
        ["create-dev", "main"],
        ["create-dev", "test"],
        ["create-dev", "staging"],
        ["create-dev", "custom-branch"],
        ["resolve-integration", "main"],
        ["resolve-integration", "test"],
        ["resolve-integration", "staging"],
      ]) {
        const res = runCli([cmd, branch]);
        expect(res.exitCode).not.toBe(0);
        expect(res.stderr).toMatch(/refusing|must start with "dev-"/i);
      }
      expect(fs.existsSync(callLogFile)).toBe(false);

      const resetOk = runCli(["reset-dev", "dev-alice"]);
      expect(resetOk.exitCode).toBe(0);
      expect(resetOk.stdout).toMatch(
        /Resetting Neon branch dev-alice to its parent branch/,
      );
      expect(fs.readFileSync(path.join(tmpDir, ".env"), "utf8")).toContain(
        "POSTGRES_URL=postgresql://neondb_owner:super-secret-pass@ep-cool-pooler.neon.tech/neondb?sslmode=require",
      );

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
