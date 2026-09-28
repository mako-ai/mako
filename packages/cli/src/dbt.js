// `mako dbt run|build|test -s <selector> [--env <name>] [--full-refresh]`
//
// Runs dbt through Mako's runner — its warehouse credentials, its run
// history — on the dbt/ folder of THIS checkout, uncommitted edits included
// (dbt-files.js). Nothing is committed or pushed: the files ride along with
// the run request. The log streams here; the exit code is dbt's outcome.
//
// Authority: this runs YOUR uploaded dbt code with the target environment's
// warehouse credentials — and dbt code (macros, hooks, schema configs) can
// reach beyond your schema. So it needs `warehouse:write`
// (`mako login --warehouse-write`, a separate unticked consent box), targets
// your own environment unless you pass --env, and never production. The
// server enforces all of it — the CLI only explains.
import { getAccessToken, findCredential } from "@makoai/app-sdk/credentials";
import { collectLocalDbtChanges } from "./dbt-files.js";

export const DBT_COMMANDS = ["run", "build", "test"];

const POLL_MS = 1500;
const TERMINAL = new Set(["success", "error", "cancelled"]);
const short = sha => (typeof sha === "string" ? sha.slice(0, 7) : "?");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const USAGE =
  "usage: mako dbt <run|build|test> -s <selector> [--env <name>] [--full-refresh] [--no-defer] [--project <id>]";

/** Can this stored login run dbt at all? */
export function loginCanRunDbt(entry) {
  if (!entry || !Array.isArray(entry.scopes)) return true; // unknown: let the server decide
  return entry.scopes.includes("warehouse:write");
}

export const NEEDS_WAREHOUSE_WRITE =
  "running dbt from your checkout needs the warehouse:write scope — the uploaded dbt code runs " +
  "with the environment's warehouse credentials, and macros, hooks and schema configs can reach " +
  'beyond your schema. Run `mako login --warehouse-write` and tick "Allow warehouse execution".';

async function request(ctx, token, method, pathname, body) {
  const res = await fetch(`${ctx.apiUrl}/api/workspaces/${ctx.workspaceId}/dbt${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON: reported below */
  }
  if (!res.ok || json?.success === false) {
    const message = json?.error ?? text.slice(0, 300);
    const error = new Error(`HTTP ${res.status}: ${message}`);
    error.status = res.status;
    error.serverMessage = message;
    throw error;
  }
  return json;
}

function explainRefusal(error) {
  // The scoped-route gate answers before the dbt route can: a login without
  // warehouse:write never reaches it.
  if (error.status === 403 && /restricted to the \/api\/mcp endpoint/.test(error.serverMessage ?? "")) {
    return NEEDS_WAREHOUSE_WRITE;
  }
  return error.serverMessage ?? error.message;
}

function printStepSummary(run, io) {
  const steps = run.stepResults ?? [];
  if (steps.length === 0) return;
  const counts = {};
  for (const step of steps) counts[step.status] = (counts[step.status] ?? 0) + 1;
  io.log(
    `\n${steps.length} node${steps.length === 1 ? "" : "s"}: ` +
      Object.entries(counts)
        .map(([status, n]) => `${n} ${status}`)
        .join(", "),
  );
  for (const step of steps) {
    if (step.status === "error" || step.status === "fail") {
      io.log(`  ✗ ${step.name}${step.message ? ` — ${step.message.split("\n")[0]}` : ""}`);
    }
  }
}

export async function dbt(ctx, positional, flags, io = { log: console.log }, deps = {}) {
  const collect = deps.collect ?? collectLocalDbtChanges;
  const sub = positional[0];
  if (!DBT_COMMANDS.includes(sub)) {
    io.log(USAGE);
    return 2;
  }
  const select = flags.select ?? flags.s;
  if (typeof select !== "string" || !select) {
    io.log(`a selector is required (-s <selector>)\n${USAGE}`);
    return 2;
  }
  if (flags["full-refresh"] && sub === "test") {
    io.log("--full-refresh does not apply to dbt test");
    return 2;
  }
  if (!ctx.repoRoot) {
    io.log("run inside a workspace checkout (no .mako/workspace.json or .git above this folder)");
    return 2;
  }
  if (!ctx.workspaceId) {
    io.log("which workspace? this checkout has no .mako/workspace.json — pass --workspace <id>");
    return 2;
  }

  let token = ctx.apiKey;
  if (!token) {
    const entry = findCredential(ctx.apiUrl, ctx.workspaceId);
    if (!entry) {
      io.log(`not signed in to ${ctx.apiUrl} — run \`mako login\``);
      return 1;
    }
    if (!loginCanRunDbt(entry)) {
      io.log(NEEDS_WAREHOUSE_WRITE);
      return 1;
    }
    token = await getAccessToken(ctx.apiUrl, ctx.workspaceId);
  }

  const local = collect(ctx.repoRoot);
  for (const { path, reason } of local.skipped) {
    io.log(`  skipped dbt/${path} (${reason})`);
  }
  const changed = Object.keys(local.files).length + local.deletes.length;
  io.log(
    local.baseSha
      ? `Local checkout${local.branch ? ` on ${local.branch}` : ""}: ${changed} dbt file${changed === 1 ? "" : "s"} differ from ${short(local.baseSha)} (its fork point from main).`
      : `Local checkout: uploading the whole dbt/ folder (${changed} files) — no fork point from origin's main to diff against.`,
  );

  let started;
  try {
    started = await request(ctx, token, "POST", "/local-runs", {
      ...(flags.project ? { projectId: String(flags.project) } : {}),
      command: sub,
      select,
      ...(typeof flags.env === "string" ? { environment: flags.env } : {}),
      ...(flags["full-refresh"] ? { fullRefresh: true } : {}),
      ...(flags.defer === false ? { defer: false } : flags.defer === true ? { defer: true } : {}),
      ...(local.branch ? { sourceLabel: local.branch } : {}),
      ...(local.baseSha ? { baseSha: local.baseSha } : {}),
      files: local.files,
      deletes: local.deletes,
    });
  } catch (error) {
    io.log(`mako dbt ${sub}: ${explainRefusal(error)}`);
    return 1;
  }
  if (started.provisionedEnvironment) {
    io.log(
      `Created your personal environment "${started.provisionedEnvironment.name}" ` +
        `(schema ${started.provisionedEnvironment.targetSchema}).`,
    );
  }
  io.log(
    `dbt ${started.commands.join(" ")} → environment "${started.environment}"` +
      `${started.defer ? " (deferring to prod)" : ""} — run ${started.runId}\n`,
  );

  // Ctrl-C stops the run in Mako too, not just the log tail.
  let interrupted = false;
  const onInterrupt = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    io.log("\nCancelling the run… (Ctrl-C again to leave it running)");
  };
  const signals = deps.signals ?? process;
  signals.on?.("SIGINT", onInterrupt);

  try {
    let cursor = 0;
    let cancelSent = false;
    for (;;) {
      if (interrupted && !cancelSent) {
        cancelSent = true;
        await request(ctx, token, "POST", `/local-runs/${started.runId}/cancel`).catch(error =>
          io.log(`could not cancel: ${error.serverMessage ?? error.message}`),
        );
      }
      let body;
      try {
        body = await request(ctx, token, "GET", `/local-runs/${started.runId}?logsSince=${cursor}`);
      } catch (error) {
        // A transient blip must not abandon a run that is still going.
        if (error.status && error.status < 500) {
          io.log(`mako dbt ${sub}: ${explainRefusal(error)}`);
          return 1;
        }
        await sleep(deps.pollMs ?? POLL_MS);
        continue;
      }
      const run = body.run;
      // The server keeps the last lines only; say so rather than skip silently.
      if (run.logsSkipped) io.log(`… ${run.logsSkipped} log lines not retained …`);
      for (const entry of run.logs ?? []) io.log(entry.line);
      cursor = run.logCursor ?? cursor;
      if (TERMINAL.has(run.status)) {
        printStepSummary(run, io);
        if (run.status === "success") {
          io.log(`\n✓ dbt ${sub} succeeded in "${run.environment}".`);
          return 0;
        }
        io.log(
          `\n✗ dbt ${sub} ${run.status === "cancelled" ? "was cancelled" : "failed"}` +
            `${run.error ? `: ${run.error.split("\n")[0]}` : ""}`,
        );
        return run.status === "cancelled" && interrupted ? 130 : 1;
      }
      await sleep(deps.pollMs ?? POLL_MS);
    }
  } finally {
    signals.off?.("SIGINT", onInterrupt);
  }
}
