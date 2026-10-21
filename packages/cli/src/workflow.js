// `mako workflow run <name>`: a test run of workflows/<name>/workflow.ts on
// this machine, against real Mako with your login (or MAKO_API_KEY), the
// same way in a sandbox. Prints each log line as it is written and keeps the
// whole run in a JSON file; `--task <step>` reruns one step from it.
import fs from "node:fs";
import path from "node:path";
import { getAccessToken } from "@makoai/app-sdk/credentials";
import { loadWorkflow, runWorkflow } from "./workflow-runner.js";

const USAGE =
  "usage: mako workflow run <name> [--input '<json>'] [--task <step>] [--out <file>]";

function parseInput(text) {
  if (text === undefined) return {};
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("--input is not valid JSON");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("--input must be a JSON object");
  }
  return input;
}

const time = at => (at ?? new Date().toISOString()).slice(11, 19);

export async function workflow(ctx, positional, flags, io) {
  const [verb, name] = positional;
  if (verb !== "run" || !name) {
    io.log(USAGE);
    return 2;
  }
  if (!ctx.repoRoot) {
    io.log(
      "run inside a workspace checkout (no .mako/workspace.json or .git here)",
    );
    return 2;
  }
  const out = path.resolve(
    flags.out ?? path.join(ctx.repoRoot, ".mako", "runs", `${name}.json`),
  );
  const task = typeof flags.task === "string" ? flags.task : undefined;
  let saved;
  if (task) {
    if (!fs.existsSync(out)) {
      io.log(`--task needs an earlier run's result: ${out} does not exist`);
      return 1;
    }
    saved = JSON.parse(fs.readFileSync(out, "utf8"));
  }
  const input =
    flags.input !== undefined ? parseInput(flags.input) : (saved?.input ?? {});

  const token =
    ctx.apiKey || (await getAccessToken(ctx.apiUrl, ctx.workspaceId));
  if (!token) {
    io.log(
      `not signed in to ${ctx.apiUrl}: run \`mako login\` or set MAKO_API_KEY`,
    );
    return 1;
  }
  // lib/mako.ts reads these when the workflow imports it.
  process.env.MAKO_URL = ctx.apiUrl;
  process.env.MAKO_API_KEY = token;

  const loaded = await loadWorkflow(ctx.repoRoot, name);
  io.log(
    `${task ? `Step ${task} of` : "Running"} ${name} against ${ctx.apiUrl} (${ctx.apiKey ? "API key" : "your login"})`,
  );
  const result = await runWorkflow(loaded, {
    input,
    task,
    saved,
    onLog: line =>
      io.log(
        `${time(line.at)} ${line.task} ${line.level.padEnd(5)} ${line.message}`,
      ),
  });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  // The runs folder stays out of the repository.
  const ignore = path.join(path.dirname(out), ".gitignore");
  if (!flags.out && !fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  fs.writeFileSync(out, JSON.stringify(result, null, 2));

  for (const step of result.tasks) {
    const seconds =
      step.durationMs !== undefined
        ? ` ${(step.durationMs / 1000).toFixed(1)}s`
        : "";
    const children = step.children ?? [];
    const failed = children.filter(c => c.status !== "COMPLETED").length;
    const spawned = children.length
      ? ` (${children.length} child run${children.length === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""})`
      : "";
    io.log(
      `  ${step.status.padEnd(9)} ${step.name}${seconds}${spawned}${step.error ? `: ${step.error.split("\n")[0]}` : ""}`,
    );
  }
  io.log(
    `${result.status}. The whole run: ${path.relative(process.cwd(), out) || out}`,
  );
  return result.status === "COMPLETED" ? 0 : 1;
}
