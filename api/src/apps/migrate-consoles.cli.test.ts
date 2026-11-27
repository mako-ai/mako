import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cwd = mkdtempSync(path.join(tmpdir(), "consoles-cli-"));
try {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      path.join(__dirname, "migrate-consoles.cli.ts"),
      "--workspace",
      "6650a1b2c3d4e5f6a7b8c9d0",
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        POSTGRES_URL: "",
        DATABASE_URL: "",
        APPS_GIT_ROOT: cwd,
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^POSTGRES_URL is not set$/m);
  assert.doesNotMatch(result.stdout, /no repo/);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
