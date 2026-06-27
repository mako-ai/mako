/**
 * Runner cancellation integration test — exercises the REAL runDbt /
 * execDbtCommand subprocess path (no Inngest, no DB) using a fake "dbt" binary
 * pointed at via DBT_VENV_BIN. Verifies that an AbortSignal stops an in-flight
 * dbt subprocess promptly, and that a process which ignores SIGTERM is escalated
 * to SIGKILL after the (env-shortened) grace window.
 */
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { mkdtemp, writeFile, chmod, rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDbtCommand } from "./commands";
import { runDbt } from "./runner.service";
import type { RenderedProfile } from "./adapter-map";

const profile: RenderedProfile = {
  adapterPackage: "dbt-postgres",
  secretEnv: {},
  keyfiles: [],
  profilesYml: "mako:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n",
};

const files = [{ path: "dbt_project.yml", content: "name: probe\n" }];

let scriptDir: string;
const prevVenv = process.env.DBT_VENV_BIN;
const prevGrace = process.env.DBT_KILL_GRACE_MS;

beforeEach(async () => {
  scriptDir = await mkdtemp(join(tmpdir(), `dbt-fake-${randomUUID()}-`));
});

afterEach(async () => {
  process.env.DBT_VENV_BIN = prevVenv;
  process.env.DBT_KILL_GRACE_MS = prevGrace;
  await rm(scriptDir, { recursive: true, force: true });
});

async function installFakeDbt(body: string): Promise<void> {
  const bin = join(scriptDir, "dbt");
  await writeFile(bin, `#!/usr/bin/env bash\n${body}\n`, "utf8");
  await chmod(bin, 0o755);
  process.env.DBT_VENV_BIN = bin;
}

describe("runDbt cancellation", () => {
  it(
    "SIGTERM stops a subprocess that exits cleanly on the signal",
    async () => {
      // Honors SIGTERM — emit a log line then `exec sleep` so the signal hits
      // the sleeping process directly (a bare `sleep` under bash would defer it,
      // unlike real dbt's Python process which handles SIGTERM itself).
      await installFakeDbt(
        'echo \'{"info":{"ts":"2026-01-01T00:00:00Z","level":"info","msg":"fake dbt started"}}\'\n' +
          "exec sleep 120\n",
      );

      const controller = new AbortController();
      const logs: string[] = [];
      const started = Date.now();
      setTimeout(() => controller.abort("test cancel"), 500);

      const result = await runDbt({
        files,
        profile,
        commands: [parseDbtCommand("run --select x")],
        signal: controller.signal,
        onLog: line => logs.push(line.line),
      });

      const elapsed = Date.now() - started;
      expect(result.success).toBe(false);
      // Aborted well before the fake's 120s sleep.
      expect(elapsed).toBeLessThan(10_000);
      expect(logs.some(l => l.includes("fake dbt started"))).toBe(true);
      expect(logs.some(l => l.includes("SIGTERM"))).toBe(true);
    },
    20_000,
  );

  it(
    "escalates to SIGKILL when the subprocess ignores SIGTERM",
    async () => {
      process.env.DBT_KILL_GRACE_MS = "500";
      // Traps + ignores SIGTERM, so only SIGKILL can stop it.
      await installFakeDbt(
        "trap '' TERM\n" +
          'echo \'{"info":{"ts":"2026-01-01T00:00:00Z","level":"info","msg":"ignoring sigterm"}}\'\n' +
          "while true; do sleep 1; done\n",
      );

      const controller = new AbortController();
      const logs: string[] = [];
      const started = Date.now();
      setTimeout(() => controller.abort("test cancel"), 300);

      const result = await runDbt({
        files,
        profile,
        commands: [parseDbtCommand("run --select x")],
        signal: controller.signal,
        onLog: line => logs.push(line.line),
      });

      const elapsed = Date.now() - started;
      expect(result.success).toBe(false);
      // SIGTERM (~300ms) + 500ms grace + reap → comfortably under 8s.
      expect(elapsed).toBeLessThan(8_000);
      expect(logs.some(l => l.includes("SIGKILL"))).toBe(true);
    },
    20_000,
  );
});
