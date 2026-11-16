#!/usr/bin/env node
// Driver of the load test (README.md, "Load test").
//
//   node run.mjs setup                         a tenant token, in .token.env
//   node run.mjs run --runs 200 [--pace 0] [--step-ms 5000] [--timeout-min 60]
//
// `run` starts runs the way a webhook does (one POST each; `--pace` is the
// milliseconds between two, 0 for all at once, 20 in flight), then follows
// Hatchet until nothing is queued or running, and prints one line of JSON.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

const API = process.env.HATCHET_API_URL ?? "http://localhost:18086";
const [command, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = rest.indexOf(`--${name}`);
  return at < 0 ? fallback : Number(rest[at + 1]);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(path, { token, cookie, body, timeoutMs = 20_000 } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok)
    throw new Error(
      `${path}: ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  return res;
}

async function setup() {
  let login;
  for (let attempt = 0; ; attempt++) {
    try {
      login = await api("/api/v1/users/login", {
        body: { email: "admin@example.com", password: "Admin123!!" },
      });
      break;
    } catch (err) {
      if (attempt > 60) throw err;
      await sleep(2000);
    }
  }
  const cookie = login.headers
    .getSetCookie()
    .map(c => c.split(";")[0])
    .join("; ");
  const memberships = await (
    await api("/api/v1/users/memberships", { cookie })
  ).json();
  const tenantId = memberships.rows[0].tenant.metadata.id;
  const { token } = await (
    await api(`/api/v1/tenants/${tenantId}/api-tokens`, {
      cookie,
      body: { name: "loadtest", expiresIn: "24h" },
    })
  ).json();
  writeFileSync(
    new URL(".token.env", import.meta.url),
    `HATCHET_CLIENT_TOKEN=${token}\n`,
  );
  console.log(`Tenant ${tenantId}: token written to .token.env`);
}

async function run() {
  const token = process.env.HATCHET_CLIENT_TOKEN;
  if (!token) throw new Error("Set HATCHET_CLIENT_TOKEN (source .token.env)");
  const tenantId = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url"),
  ).sub;
  const runs = flag("runs", 50);
  const pace = flag("pace", 0);
  const stepMs = flag("step-ms", 5000);
  const deadline = Date.now() + flag("timeout-min", 60) * 60_000;
  const since = new Date().toISOString();
  const started = Date.now();
  let startErrors = 0;
  const startTimes = [];
  const start = async () => {
    const at = Date.now();
    try {
      await api(`/api/v1/stable/tenants/${tenantId}/workflow-runs/trigger`, {
        token,
        body: {
          workflowName: process.env.LOADTEST_WORKFLOW ?? "burst",
          input: { stepMs },
          additionalMetadata: { trigger: "loadtest" },
        },
      });
      startTimes.push(Date.now() - at);
    } catch (err) {
      startErrors++;
      if (startErrors <= 3) console.log(`  start failed: ${err.message}`);
    }
  };
  if (pace > 0) {
    const pending = [];
    for (let i = 0; i < runs; i++) {
      pending.push(start());
      await sleep(pace);
    }
    await Promise.all(pending);
  } else {
    let next = 0;
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        while (next++ < runs) await start();
      }),
    );
  }
  const startedIn = (Date.now() - started) / 1000;
  startTimes.sort((a, b) => a - b);
  console.log(
    `Started ${runs - startErrors}/${runs} runs in ${startedIn.toFixed(1)} s` +
      ` (start p50 ${startTimes[Math.floor(startTimes.length / 2)]} ms, max ${startTimes.at(-1)} ms)`,
  );

  // Two readings. `live` is the engine's own queue (task-stats): what is
  // queued or running now. `tasks` and `runs` are the read model the API and
  // Mako show, straight from this stack's Postgres: under load it can lag or
  // lose a run's last status, which is a failure of its own.
  const psql = sql =>
    execFileSync(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "hatchet",
        "-d",
        "hatchet",
        "-At",
        "-F",
        "=",
        "-c",
        sql,
      ],
      { cwd: here, encoding: "utf8", timeout: 60_000 },
    );
  const byStatus = table =>
    Object.fromEntries(
      psql(`select readable_status, count(*) from ${table} group by 1`)
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(line => line.split("="))
        .map(([status, count]) => [status, Number(count)]),
    );
  const usage = () => {
    const out = execFileSync(
      "docker",
      [
        "stats",
        "--no-stream",
        "--format",
        "{{.Name}} {{.CPUPerc}} {{.MemUsage}}",
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    return Object.fromEntries(
      out
        .split("\n")
        .filter(line => line.startsWith("mako-wf-loadtest-"))
        .map(line => {
          const [name, cpu, mem] = line.split(" ");
          return [
            name.replace("mako-wf-loadtest-", "").replace(/-\d+$/, ""),
            { cpu: parseFloat(cpu), mem },
          ];
        }),
    );
  };
  let unreachable = 0;
  let idlePolls = 0;
  let peakQueued = 0;
  let peakRunning = 0;
  const peak = {};
  let last = "";
  for (;;) {
    let live = null;
    try {
      const stats = await (
        await api(`/api/v1/tenants/${tenantId}/task-stats`, { token })
      ).json();
      live = { queued: 0, running: 0 };
      for (const task of Object.values(stats)) {
        live.queued += task.queued?.total ?? 0;
        live.running += task.running?.total ?? 0;
      }
    } catch {
      unreachable++;
    }
    if (live) {
      peakQueued = Math.max(peakQueued, live.queued);
      peakRunning = Math.max(peakRunning, live.running);
      idlePolls = live.queued + live.running === 0 ? idlePolls + 1 : 0;
    }
    try {
      for (const [name, now] of Object.entries(usage())) {
        if (!peak[name] || now.cpu > peak[name].cpu) peak[name] = now;
      }
    } catch {
      // A sample missed.
    }
    const line = JSON.stringify(live);
    if (line !== last)
      console.log(`  ${((Date.now() - started) / 1000).toFixed(0)} s ${line}`);
    last = line;
    // A run's next step is queued a moment after the one before it ends.
    if (idlePolls >= 3) break;
    if (Date.now() > deadline) {
      console.log("  timed out");
      break;
    }
    await sleep(5000);
  }
  const seconds = (Date.now() - started) / 1000 - 10;
  // The read model gets a minute to catch up before it is judged.
  await sleep(60_000);
  const tasks = byStatus("v1_tasks_olap");
  const runsNow = byStatus("v1_runs_olap");
  const completed = tasks.COMPLETED ?? 0;
  const stub = await (async () => {
    try {
      return JSON.parse(
        execFileSync(
          "docker",
          [
            "compose",
            "exec",
            "-T",
            "mako",
            "node",
            "-e",
            "fetch('http://localhost:8080/stats').then(r=>r.text()).then(console.log)",
          ],
          { cwd: here, encoding: "utf8" },
        ),
      );
    } catch {
      return null;
    }
  })();
  console.log(
    JSON.stringify({
      runs,
      stepMs,
      startErrors,
      startSeconds: Number(startedIn.toFixed(1)),
      seconds: Math.round(seconds),
      stepsExpected: runs * 5,
      tasks,
      runsReadModel: runsNow,
      stepsPerMinute: Math.round((completed / seconds) * 60),
      runsPerMinute: Math.round((completed / 5 / seconds) * 60),
      peakQueued,
      peakRunning,
      hatchetUnreachablePolls: unreachable,
      passes: stub,
      peak,
    }),
  );
}

if (command === "setup") await setup();
else if (command === "run") await run();
else
  console.error(
    "usage: run.mjs setup | run --runs <n> [--pace <ms>] [--step-ms <ms>]",
  );
