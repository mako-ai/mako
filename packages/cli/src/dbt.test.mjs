/**
 * `mako dbt run`: what leaves the laptop, and what the terminal shows.
 *
 * Pinned: uncommitted edits (staged, unstaged, untracked, deleted, and
 * committed-but-unpushed) are all in the upload, relative to the commit the
 * checkout forked from main; generated folders never are; without a fork
 * point the whole tree goes; the log streams; the exit code is dbt's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectLocalDbtChanges, projectPath } from "./dbt-files.js";
import { dbt, loginCanRunDbt, NEEDS_WAREHOUSE_WRITE } from "./dbt.js";
import { loginScopes } from "./login.js";

function sh(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A "workspace repo" on origin with main, and a clone that forked from it. */
function checkout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mako-dbt-cli-"));
  const origin = path.join(base, "origin");
  const seed = path.join(base, "seed");
  fs.mkdirSync(seed);
  sh(seed, "init", "-q", "-b", "main");
  write(seed, "dbt/dbt_project.yml", "name: demo\n");
  write(seed, "dbt/models/a.sql", "select 1\n");
  write(seed, "dbt/models/b.sql", "select 2\n");
  write(seed, "dbt/models/gone.sql", "select 3\n");
  write(seed, "apps/x/package.json", "{}\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-qm", "init");
  sh(base, "clone", "-q", "--bare", seed, origin);
  const repo = path.join(base, "repo");
  sh(base, "clone", "-q", origin, repo);
  const forkPoint = sh(repo, "rev-parse", "HEAD");
  return {
    repo,
    forkPoint,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test("projectPath keeps dbt sources and drops generated folders", () => {
  assert.equal(projectPath("dbt/models/a.sql"), "models/a.sql");
  assert.equal(projectPath("dbt/target/manifest.json"), null);
  assert.equal(projectPath("dbt/dbt_packages/x/y.sql"), null);
  assert.equal(projectPath("dbt/logs/dbt.log"), null);
  assert.equal(projectPath("apps/x/package.json"), null);
});

test("the upload is every local difference from the fork point, committed or not", () => {
  const { repo, forkPoint, cleanup } = checkout();
  try {
    sh(repo, "checkout", "-qb", "feat/x");
    // Committed on the branch, never pushed.
    write(repo, "dbt/models/committed.sql", "select 'c'\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "wip");
    // Staged, unstaged, untracked, deleted.
    write(repo, "dbt/models/a.sql", "select 10\n");
    sh(repo, "add", "dbt/models/a.sql");
    write(repo, "dbt/models/b.sql", "select 20\n");
    write(repo, "dbt/models/new.sql", "select 'n'\n");
    fs.rmSync(path.join(repo, "dbt/models/gone.sql"));
    // Generated and binary: never uploaded.
    write(repo, "dbt/target/manifest.json", "{}");
    write(repo, "dbt/seeds/blob.csv", "a\0b");
    // Outside dbt/: not dbt's business.
    write(repo, "apps/x/package.json", '{"changed":true}\n');

    const out = collectLocalDbtChanges(repo);
    assert.equal(out.baseSha, forkPoint);
    assert.equal(out.branch, "feat/x");
    assert.deepEqual(Object.keys(out.files).sort(), [
      "models/a.sql",
      "models/b.sql",
      "models/committed.sql",
      "models/new.sql",
    ]);
    assert.equal(out.files["models/a.sql"], "select 10\n");
    assert.equal(out.files["models/b.sql"], "select 20\n");
    assert.deepEqual(out.deletes, ["models/gone.sql"]);
    assert.deepEqual(out.skipped, [
      { path: "seeds/blob.csv", reason: "binary" },
    ]);
  } finally {
    cleanup();
  }
});

test("a clean checkout uploads nothing but still names its base", () => {
  const { repo, forkPoint, cleanup } = checkout();
  try {
    const out = collectLocalDbtChanges(repo);
    assert.equal(out.baseSha, forkPoint);
    assert.deepEqual(out.files, {});
    assert.deepEqual(out.deletes, []);
  } finally {
    cleanup();
  }
});

test("without a fork point from origin, the whole dbt/ tree goes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-dbt-cli-nogit-"));
  try {
    write(dir, "dbt/dbt_project.yml", "name: demo\n");
    write(dir, "dbt/models/a.sql", "select 1\n");
    write(dir, "dbt/target/run_results.json", "{}");
    const out = collectLocalDbtChanges(dir);
    assert.equal(out.baseSha, undefined);
    assert.deepEqual(Object.keys(out.files).sort(), [
      "dbt_project.yml",
      "models/a.sql",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a checkout without dbt/dbt_project.yml is refused before any request", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-dbt-cli-empty-"));
  try {
    assert.throws(() => collectLocalDbtChanges(dir), /no dbt project/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// No separate warehouse opt-in: any login may run dbt (the server checks the
// workspace role), and every login asks for the full scope set.
test("any login may run dbt; login asks for everything", async () => {
  assert.equal(loginCanRunDbt({ scopes: ["mcp", "query:read"] }), true);
  assert.equal(loginCanRunDbt({ scopes: ["mcp", "warehouse:write"] }), true);
  assert.equal(loginCanRunDbt({}), true);
  const all = ["mcp", "query:read", "warehouse:write", "connections:write"];
  assert.deepEqual(loginScopes({}), all);
  // The old flag is still accepted and changes nothing.
  assert.deepEqual(loginScopes({ "warehouse-write": true }), all);
  assert.match(NEEDS_WAREHOUSE_WRITE, /mako login/);
  assert.doesNotMatch(NEEDS_WAREHOUSE_WRITE, /--warehouse-write/);
});

/** Stub the dbt REST routes: the POST answer, then GET answers in order. */
function stubServer({ start, polls, status = 200 }) {
  const calls = [];
  const original = globalThis.fetch;
  let poll = 0;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    calls.push({
      method: init.method,
      path: u.pathname + u.search,
      body: init.body ? JSON.parse(init.body) : null,
    });
    if (init.method === "POST" && u.pathname.endsWith("/local-runs")) {
      return new Response(JSON.stringify(start), { status });
    }
    if (init.method === "POST")
      return new Response(JSON.stringify({ success: true }));
    const body = polls[Math.min(poll++, polls.length - 1)];
    return new Response(JSON.stringify({ success: true, run: body }));
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const CTX = {
  apiUrl: "https://mako.test",
  apiKey: "revops_test",
  workspaceId: "ws1",
  repoRoot: "/repo",
};
const LOCAL = {
  baseSha: "a".repeat(40),
  branch: "feat/x",
  files: { "models/a.sql": "select 10\n" },
  deletes: ["models/gone.sql"],
  skipped: [],
};

async function runDbt(positional, flags, server) {
  const lines = [];
  const code = await dbt(
    CTX,
    positional,
    flags,
    { log: l => lines.push(l) },
    {
      collect: () => LOCAL,
      pollMs: 1,
      signals: {},
    },
  );
  server.restore();
  return { code, output: lines.join("\n"), calls: server.calls };
}

test("run uploads the checkout, streams the log, and exits 0 on success", async () => {
  const server = stubServer({
    start: {
      success: true,
      runId: "r1",
      projectId: "p1",
      environment: "joan",
      commands: ["build --select stg_orders+"],
      defer: true,
    },
    polls: [
      {
        status: "running",
        logs: [{ line: "$ dbt build --select stg_orders+" }],
        logCursor: 1,
      },
      {
        status: "success",
        environment: "joan",
        logs: [{ line: "Completed successfully" }],
        logCursor: 2,
        stepResults: [{ name: "stg_orders", status: "success" }],
      },
    ],
  });
  const { code, output, calls } = await runDbt(
    ["build"],
    { s: "stg_orders+", "full-refresh": true },
    server,
  );
  assert.equal(code, 0);
  assert.deepEqual(calls[0], {
    method: "POST",
    path: "/api/workspaces/ws1/dbt/local-runs",
    body: {
      command: "build",
      select: "stg_orders+",
      fullRefresh: true,
      sourceLabel: "feat/x",
      baseSha: LOCAL.baseSha,
      files: LOCAL.files,
      deletes: LOCAL.deletes,
    },
  });
  // The log cursor advances: the second poll asks only for new lines.
  assert.equal(
    calls[2].path,
    "/api/workspaces/ws1/dbt/local-runs/r1?logsSince=1",
  );
  assert.match(output, /\$ dbt build --select stg_orders\+/);
  assert.match(output, /Completed successfully/);
  assert.match(output, /succeeded in "joan"/);
});

test("a failed run exits non-zero and names the failing node", async () => {
  const server = stubServer({
    start: {
      success: true,
      runId: "r2",
      projectId: "p1",
      environment: "joan",
      commands: ["run --select m"],
    },
    polls: [
      {
        status: "error",
        environment: "joan",
        error: "dbt exited with code 1",
        logs: [],
        logCursor: 0,
        stepResults: [
          {
            name: "m",
            status: "error",
            message: "Name call_source not found inside calls",
          },
        ],
      },
    ],
  });
  const { code, output } = await runDbt(["run"], { select: "m" }, server);
  assert.equal(code, 1);
  assert.match(output, /✗ m — Name call_source not found inside calls/);
  assert.match(output, /failed: dbt exited with code 1/);
});

test("the server's refusal (a shared environment) is shown, exit 1", async () => {
  const server = stubServer({
    status: 403,
    start: {
      success: false,
      error:
        '"dev" is a shared environment; this sign-in may only build your personal environment (omit --env).',
    },
    polls: [],
  });
  const { code, output } = await runDbt(
    ["run"],
    { s: "m", env: "dev" },
    server,
  );
  assert.equal(code, 1);
  assert.match(output, /"dev" is a shared environment/);
});

test("bad invocations never reach the server", async () => {
  for (const [positional, flags] of [
    [["deploy"], { s: "m" }],
    [["run"], {}],
    [["test"], { s: "m", "full-refresh": true }],
  ]) {
    const server = stubServer({ start: {}, polls: [] });
    const { code, calls } = await runDbt(positional, flags, server);
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
  }
});

// Review finding (#1013): the server caps stored log lines; a follower that
// fell behind is told how many it missed instead of silently skipping them.
test("a log gap reported by the server is shown, not swallowed", async () => {
  const server = stubServer({
    start: {
      success: true,
      runId: "r3",
      projectId: "p1",
      environment: "joan",
      commands: ["run --select m"],
    },
    polls: [
      {
        status: "success",
        environment: "joan",
        logs: [{ line: "tail line" }],
        logCursor: 7001,
        logsSkipped: 2000,
      },
    ],
  });
  const { code, output } = await runDbt(["run"], { s: "m" }, server);
  assert.equal(code, 0);
  assert.match(output, /… 2000 log lines not retained …\ntail line/);
});
