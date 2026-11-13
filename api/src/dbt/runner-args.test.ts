import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RenderedProfile } from "./adapter-map";
import { parseDbtCommand } from "./commands";
import { dbtRunLabelEnv } from "./dbt-run-labels";
import {
  buildExtraDbtArgs,
  filterDbtExtraEnv,
  invocationIdFromLogLine,
  invocationIdFromRunResults,
  runDbt,
} from "./runner.service";

describe("buildExtraDbtArgs — --defer/--state", () => {
  it("adds --defer --state for state-aware subcommands when a stateDir exists", () => {
    for (const sub of ["run", "build", "test", "compile", "seed", "snapshot"]) {
      expect(
        buildExtraDbtArgs({ subcommand: sub, argv: [sub], stateDir: "/s" }),
      ).toEqual(["--defer", "--state", "/s"]);
    }
  });

  it("omits defer args without a stateDir", () => {
    expect(
      buildExtraDbtArgs({ subcommand: "run", argv: ["run"], stateDir: null }),
    ).toEqual([]);
    expect(buildExtraDbtArgs({ subcommand: "run", argv: ["run"] })).toEqual([]);
  });

  it("omits defer args for non-state-aware subcommands (e.g. ls, parse)", () => {
    expect(
      buildExtraDbtArgs({ subcommand: "ls", argv: ["ls"], stateDir: "/s" }),
    ).toEqual([]);
  });
});

describe("buildExtraDbtArgs — environment --vars", () => {
  it("injects --vars as compact JSON when the env defines vars", () => {
    const out = buildExtraDbtArgs({
      subcommand: "run",
      argv: ["run"],
      vars: { start_date: "2024-01-01", is_test: true },
    });
    expect(out).toEqual([
      "--vars",
      JSON.stringify({ start_date: "2024-01-01", is_test: true }),
    ]);
  });

  it("skips --vars for empty/undefined var maps", () => {
    expect(
      buildExtraDbtArgs({ subcommand: "run", argv: ["run"], vars: {} }),
    ).toEqual([]);
    expect(buildExtraDbtArgs({ subcommand: "run", argv: ["run"] })).toEqual([]);
  });

  it("never injects --vars on retry (it replays prior argv)", () => {
    expect(
      buildExtraDbtArgs({
        subcommand: "retry",
        argv: ["retry"],
        vars: { a: 1 },
      }),
    ).toEqual([]);
  });

  it("does not double-inject when the command already supplies --vars", () => {
    expect(
      buildExtraDbtArgs({
        subcommand: "run",
        argv: ["run", "--vars", '{"a":1}'],
        vars: { b: 2 },
      }),
    ).toEqual([]);
  });

  it("combines defer + vars in that order", () => {
    expect(
      buildExtraDbtArgs({
        subcommand: "build",
        argv: ["build"],
        stateDir: "/s",
        vars: { a: 1 },
      }),
    ).toEqual(["--defer", "--state", "/s", "--vars", JSON.stringify({ a: 1 })]);
  });
});

describe("buildExtraDbtArgs: run vars merged over environment vars", () => {
  it("passes the merged map as one --vars argument, the run value winning", () => {
    const environmentVars = { start_date: "2024-01-01", region: "emea" };
    const runVars = { start_date: "2026-01-01", days: [1, 2] };
    expect(
      buildExtraDbtArgs({
        subcommand: "build",
        argv: ["build", "--select", "a"],
        vars: { ...environmentVars, ...runVars },
      }),
    ).toEqual([
      "--vars",
      JSON.stringify({
        start_date: "2026-01-01",
        region: "emea",
        days: [1, 2],
      }),
    ]);
  });

  it("keeps a quoted job --vars as the only --vars", () => {
    const parsed = parseDbtCommand(`run --vars '{"a": 1}'`);
    expect(
      buildExtraDbtArgs({
        subcommand: parsed.subcommand,
        argv: parsed.argv,
        vars: { b: 2 },
      }),
    ).toEqual([]);
  });
});

describe("filterDbtExtraEnv", () => {
  it("passes MAKO_DBT_* and MAKO_TRIGGER, bare and under DBT_ENV_CUSTOM_ENV_", () => {
    const env = {
      MAKO_DBT_JOB: "nightly",
      MAKO_DBT_RUN: "r1",
      MAKO_DBT_FUTURE_2: "x",
      MAKO_TRIGGER: "schedule",
      DBT_ENV_CUSTOM_ENV_MAKO_DBT_JOB: "nightly",
      DBT_ENV_CUSTOM_ENV_MAKO_DBT_RUN: "r1",
      DBT_ENV_CUSTOM_ENV_MAKO_TRIGGER: "schedule",
    };
    expect(filterDbtExtraEnv(env)).toEqual(env);
  });

  it("drops every other name", () => {
    expect(
      filterDbtExtraEnv({
        MAKO_DBT_RUN: "r1",
        PATH: "/evil",
        HOME: "/evil",
        ENCRYPTION_KEY: "secret",
        DATABASE_URL: "mongodb://x",
        DBT_PROFILES_DIR: "/evil",
        DBT_ENV_SECRET_TOKEN: "secret",
        DBT_ENV_CUSTOM_ENV_OTHER: "x",
        DBT_ENV_CUSTOM_ENV_: "x",
        MAKO_DBT_: "x",
        MAKO_TRIGGER_EXTRA: "x",
        MAKO_SECRET: "x",
        mako_dbt_run: "lowercase",
        XMAKO_DBT_RUN: "x",
        "MAKO_DBT_RUN ": "x",
        "MAKO_DBT_A=B": "x",
        PYTHONPATH: "/evil",
        LD_PRELOAD: "/evil.so",
      }),
    ).toEqual({ MAKO_DBT_RUN: "r1" });
  });

  it("returns an empty map for undefined or empty input, and drops non-strings", () => {
    expect(filterDbtExtraEnv(undefined)).toEqual({});
    expect(filterDbtExtraEnv({})).toEqual({});
    expect(
      filterDbtExtraEnv({
        MAKO_DBT_RUN: 7,
        MAKO_TRIGGER: undefined,
      } as unknown as Record<string, string>),
    ).toEqual({});
  });
});

describe("invocation id parsing", () => {
  const ID = "1fe4bc7d-f77c-4f1e-bab2-3f6938f196d0";

  it("reads info.invocation_id from a dbt JSON log line", () => {
    expect(
      invocationIdFromLogLine(
        JSON.stringify({
          data: {},
          info: {
            invocation_id: ID,
            level: "info",
            msg: "Running with dbt=1.9.10",
            name: "MainReportVersion",
          },
        }),
      ),
    ).toBe(ID);
  });

  it("returns undefined for plain text, bad JSON and lines without an id", () => {
    for (const raw of [
      "Installed 3 packages",
      "{not json",
      "{}",
      '{"info":{}}',
      '{"info":{"invocation_id":""}}',
      '{"info":{"invocation_id":42}}',
      '{"info":null}',
      "",
    ]) {
      expect(invocationIdFromLogLine(raw), raw).toBeUndefined();
    }
  });

  it("reads metadata.invocation_id from run_results.json", () => {
    expect(
      invocationIdFromRunResults(
        Buffer.from(
          JSON.stringify({ metadata: { invocation_id: ID }, results: [] }),
        ),
      ),
    ).toBe(ID);
    expect(invocationIdFromRunResults(undefined)).toBeUndefined();
    expect(invocationIdFromRunResults(Buffer.from("{corrupt"))).toBeUndefined();
    expect(
      invocationIdFromRunResults(Buffer.from('{"results":[]}')),
    ).toBeUndefined();
    expect(
      invocationIdFromRunResults(
        Buffer.from('{"metadata":{"invocation_id":7}}'),
      ),
    ).toBeUndefined();
  });
});

/**
 * The real runDbt subprocess path with a fake `dbt` binary (DBT_VENV_BIN):
 * what the child's environment holds, and which invocation id each command
 * reports.
 */
describe("runDbt: extraEnv passthrough and invocation ids", () => {
  const profile: RenderedProfile = {
    adapterPackage: "dbt-postgres",
    secretEnv: { DBT_ENV_SECRET_PASSWORD: "from-connection" },
    keyfiles: [],
    profilesYml:
      "mako:\n  target: dev\n  outputs:\n    dev:\n      type: postgres\n",
  };
  const files = [{ path: "dbt_project.yml", content: "name: probe\n" }];

  let scriptDir: string;
  const previousVenv = process.env.DBT_VENV_BIN;
  const previousSecret = process.env.MAKO_WP3_SERVER_SECRET;

  beforeEach(async () => {
    scriptDir = await mkdtemp(join(tmpdir(), `dbt-fake-${randomUUID()}-`));
    // A server-side variable the child must never see.
    process.env.MAKO_WP3_SERVER_SECRET = "server-only";
  });

  afterEach(async () => {
    if (previousVenv === undefined) delete process.env.DBT_VENV_BIN;
    else process.env.DBT_VENV_BIN = previousVenv;
    if (previousSecret === undefined) delete process.env.MAKO_WP3_SERVER_SECRET;
    else process.env.MAKO_WP3_SERVER_SECRET = previousSecret;
    await rm(scriptDir, { recursive: true, force: true });
  });

  /**
   * Fake dbt: appends its environment to env-<n>.txt in scriptDir, then runs
   * `body` with $SUB set to the subcommand and $N to the call number.
   */
  async function installFakeDbt(body: string): Promise<void> {
    const bin = join(scriptDir, "dbt");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env bash",
        `DIR=${JSON.stringify(scriptDir)}`,
        'N=$(ls "$DIR" | grep -c "^env-")',
        'env > "$DIR/env-$N.txt"',
        'SUB="$1"',
        body,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(bin, 0o755);
    process.env.DBT_VENV_BIN = bin;
  }

  async function childEnv(call: number): Promise<Record<string, string>> {
    const raw = await readFile(join(scriptDir, `env-${call}.txt`), "utf8");
    const env: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const index = line.indexOf("=");
      if (index > 0) env[line.slice(0, index)] = line.slice(index + 1);
    }
    return env;
  }

  /** A bash `echo` of one dbt JSON event. Double-quoted so $SUB / $N expand. */
  const logLine = (id: string, msg: string) => {
    const event = JSON.stringify({
      info: {
        invocation_id: id,
        level: "info",
        msg,
        ts: "2026-01-01T00:00:00Z",
      },
    });
    return `echo "${event.replace(/"/g, '\\"')}"`;
  };

  it("hands the run identity to the dbt child and nothing else", async () => {
    await installFakeDbt(logLine("inv-1", "ok"));
    const labelEnv = dbtRunLabelEnv({
      runId: "6650f0c2a1b2c3d4e5f60718",
      trigger: "schedule",
      jobId: "6650f0c2a1b2c3d4e5f60700",
      jobSlug: "Nightly Build",
    });

    const result = await runDbt({
      files,
      profile,
      commands: [parseDbtCommand("run --select x")],
      extraEnv: {
        ...labelEnv,
        // None of these may reach the child or replace a real value.
        ENCRYPTION_KEY: "leak",
        HOME: "/evil-home",
        DBT_ENV_SECRET_PASSWORD: "overridden",
        DBT_SEND_ANONYMOUS_USAGE_STATS: "true",
      },
    });

    expect(result.success).toBe(true);
    const env = await childEnv(0);
    expect(env.MAKO_DBT_JOB).toBe("6650f0c2a1b2c3d4e5f60700");
    expect(env.MAKO_DBT_JOB_SLUG).toBe("nightly_build");
    expect(env.MAKO_DBT_RUN).toBe("6650f0c2a1b2c3d4e5f60718");
    expect(env.MAKO_TRIGGER).toBe("schedule");
    expect(env.DBT_ENV_CUSTOM_ENV_MAKO_DBT_JOB).toBe(
      "6650f0c2a1b2c3d4e5f60700",
    );
    expect(env.DBT_ENV_CUSTOM_ENV_MAKO_DBT_JOB_SLUG).toBe("nightly_build");
    expect(env.DBT_ENV_CUSTOM_ENV_MAKO_DBT_RUN).toBe(
      "6650f0c2a1b2c3d4e5f60718",
    );
    expect(env.DBT_ENV_CUSTOM_ENV_MAKO_TRIGGER).toBe("schedule");

    expect(env).not.toHaveProperty("ENCRYPTION_KEY");
    expect(env).not.toHaveProperty("MAKO_WP3_SERVER_SECRET");
    expect(env.HOME).not.toBe("/evil-home");
    expect(env.DBT_ENV_SECRET_PASSWORD).toBe("from-connection");
    expect(env.DBT_SEND_ANONYMOUS_USAGE_STATS).toBe("false");
  });

  it("sets no MAKO_* variable when the request has no extraEnv", async () => {
    await installFakeDbt(logLine("inv-1", "ok"));
    await runDbt({ files, profile, commands: [parseDbtCommand("parse")] });
    const env = await childEnv(0);
    expect(Object.keys(env).filter(name => name.includes("MAKO_"))).toEqual([]);
  });

  it("gives every command, and the deps step, the same identity", async () => {
    await installFakeDbt(logLine("inv-$N", "ok"));
    await runDbt({
      files: [
        ...files,
        {
          path: "packages.yml",
          content: "packages:\n  - package: dbt-labs/dbt_utils\n",
        },
      ],
      profile,
      commands: [parseDbtCommand("seed"), parseDbtCommand("run")],
      extraEnv: dbtRunLabelEnv({ runId: "r1", trigger: "manual" }),
    });
    // Call 0 is `dbt deps`, 1 is seed, 2 is run.
    for (const call of [0, 1, 2]) {
      const env = await childEnv(call);
      expect(env.MAKO_DBT_RUN, `call ${call}`).toBe("r1");
      expect(env.MAKO_TRIGGER, `call ${call}`).toBe("manual");
      expect(env, `call ${call}`).not.toHaveProperty("MAKO_DBT_JOB");
    }
  });

  it("captures one invocation id per command from the JSON log", async () => {
    await installFakeDbt(
      [
        'echo "plain text before the first event"',
        logLine("inv-$SUB", "first"),
        logLine("inv-other", "a later line never replaces the first id"),
      ].join("\n"),
    );
    const result = await runDbt({
      files,
      profile,
      commands: [
        parseDbtCommand("parse"),
        parseDbtCommand("seed"),
        parseDbtCommand("build --select a"),
      ],
    });
    expect(result.success).toBe(true);
    expect(result.commandResults.map(command => command.invocationId)).toEqual([
      "inv-parse",
      "inv-seed",
      "inv-build",
    ]);
    // The log lines themselves are unchanged by the capture.
    expect(result.commandResults[0].logLines.map(line => line.line)).toEqual([
      "plain text before the first event",
      "first",
      "a later line never replaces the first id",
    ]);
  });

  it("captures the id of a failed command and of an unterminated last line", async () => {
    await installFakeDbt(
      `printf '%s' '${JSON.stringify({ info: { invocation_id: "inv-failed", level: "error", msg: "boom" } })}'\nexit 2`,
    );
    const result = await runDbt({
      files,
      profile,
      commands: [parseDbtCommand("run"), parseDbtCommand("test")],
    });
    expect(result.success).toBe(false);
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0].exitCode).toBe(2);
    expect(result.commandResults[0].invocationId).toBe("inv-failed");
  });

  it("falls back to run_results.json metadata when the log has no id", async () => {
    await installFakeDbt(
      [
        'echo "no structured output"',
        "mkdir -p target",
        `echo '${JSON.stringify({ metadata: { invocation_id: "inv-artifact" }, results: [] })}' > target/run_results.json`,
      ].join("\n"),
    );
    const result = await runDbt({
      files,
      profile,
      commands: [parseDbtCommand("run")],
    });
    expect(result.commandResults[0].invocationId).toBe("inv-artifact");
  });

  it("prefers the logged id over a run_results.json left by another invocation", async () => {
    await installFakeDbt(
      [
        "mkdir -p target",
        `echo '${JSON.stringify({ metadata: { invocation_id: "inv-stale" }, results: [] })}' > target/run_results.json`,
        logLine("inv-live", "ok"),
      ].join("\n"),
    );
    const result = await runDbt({
      files,
      profile,
      commands: [parseDbtCommand("retry")],
    });
    expect(result.commandResults[0].invocationId).toBe("inv-live");
  });

  it("leaves invocationId undefined when dbt reports none", async () => {
    await installFakeDbt('echo "nothing structured"');
    const result = await runDbt({
      files,
      profile,
      commands: [parseDbtCommand("parse")],
    });
    expect(result.commandResults[0].invocationId).toBeUndefined();
  });

  it("reports the deps invocation id when deps fails", async () => {
    await installFakeDbt(`${logLine("inv-deps", "deps failed")}\nexit 1`);
    const result = await runDbt({
      files: [
        ...files,
        {
          path: "packages.yml",
          content: "packages:\n  - package: dbt-labs/dbt_utils\n",
        },
      ],
      profile,
      commands: [parseDbtCommand("run")],
    });
    expect(result.success).toBe(false);
    expect(result.commandResults).toEqual([
      expect.objectContaining({ command: "deps", invocationId: "inv-deps" }),
    ]);
  });
});
