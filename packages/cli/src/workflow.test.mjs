// mako workflow run: real workflow files in a scratch checkout, run by the
// real runner (tsx, the loader hooks, the workers' lib/mako.ts). Mako is a
// local HTTP server that records what it is sent.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { main } from "./main.js";
import { loadWorkflow, runWorkflow, timeoutMs } from "./workflow-runner.js";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mako-workflow-test-"));
fs.mkdirSync(path.join(repo, ".mako"));
fs.writeFileSync(
  path.join(repo, ".mako", "workspace.json"),
  JSON.stringify({ workspaceId: "ws1" }),
);

const write = (name, source) => {
  fs.mkdirSync(path.join(repo, "workflows", name), { recursive: true });
  fs.writeFileSync(path.join(repo, "workflows", name, "workflow.ts"), source);
};

// Three steps; the last reads its grandparent, as hn-daily-digest does, and
// a package a workflow may import (zod) comes from the CLI's dependencies.
write(
  "chain",
  `import { z } from "zod";
import { hatchet } from "../hatchet";
import { helper } from "./helper";

const wf = hatchet.workflow<{ n: number }>({ name: "chain", on: { cron: "0 5 * * *" } });
const a = wf.task({ name: "a", fn: async (input, ctx) => {
  ctx.logger.info("a got " + input.n);
  return { n: z.number().parse(input.n) + 1, workflow: (globalThis as any).makoWorkflow.getStore() };
} });
const b = wf.task({ name: "b", parents: [a], fn: async (_i, ctx) => ({ n: (await ctx.parentOutput(a)).n * 10 }) });
wf.task({ name: "c", parents: [b], fn: async (_i, ctx) => {
  ctx.logger.warn("c ran");
  return { a: (await ctx.parentOutput(a)).n, b: (await ctx.parentOutput(b)).n, h: helper() };
} });
export default wf;
`,
);
fs.writeFileSync(
  path.join(repo, "workflows", "chain", "helper.ts"),
  `export const helper = (): string => "local import";\n`,
);

write(
  "flaky",
  `import { hatchet } from "../hatchet";
let calls = 0;
const wf = hatchet.workflow({ name: "flaky" });
const once = wf.task({ name: "once", retries: 2, fn: async () => { if (++calls < 2) throw new Error("boom"); return { calls }; } });
const never = wf.task({ name: "never", retries: 1, fn: async () => { throw new Error("always"); } });
wf.task({ name: "after", parents: [never], fn: async () => ({ ran: true }) });
wf.task({ name: "slow", executionTimeout: "1s", fn: () => new Promise(r => setTimeout(r, 3000)) });
wf.task({ name: "runid", fn: async (_i, ctx: any) => ctx.putStream("x") });
export default wf;
`,
);

write(
  "unsupported",
  `import { hatchet } from "../hatchet";
const wf = hatchet.workflow({ name: "unsupported", concurrency: { maxRuns: 1 } } as any);
export default wf;
`,
);

write(
  "misnamed",
  `import { hatchet } from "../hatchet";\nexport default hatchet.workflow({ name: "other" });\n`,
);

// The workers' lib/mako: query() goes to Mako's runtime route with the key
// and the workflow's name.
write(
  "calls",
  `import { hatchet } from "../hatchet";
import { query } from "../lib/mako";
const wf = hatchet.workflow({ name: "calls" });
wf.task({ name: "read", fn: async () => ({ rows: await query("conn1", "SELECT 1") }) });
export default wf;
`,
);

// A model call Mako refuses (as prod refuses a key it does not accept here).
write(
  "model",
  `import { generateText } from "ai";
import { hatchet } from "../hatchet";
import { model } from "../lib/mako";
const wf = hatchet.workflow({ name: "model" });
wf.task({ name: "ask", fn: async () => ({ text: (await generateText({ model: model("anthropic/claude-haiku-4.5"), prompt: "hi" })).text }) });
export default wf;
`,
);

// A parent fanning out to child runs, as Plan B's classifier does: three
// in bulk (one fails), one waited for, one started and awaited later.
write(
  "fanout",
  `import { hatchet } from "../hatchet";

export const batch = hatchet.workflow<{ n: number }>({ name: "fanout-batch" });
batch.task({ name: "label", fn: async (input, ctx: any) => {
  ctx.logger.info("batch " + input.n + " index " + ctx.childIndex() + " key " + ctx.childKey());
  if (input.n === 2) throw new Error("batch 2 broke");
  // The others end after it, as a real call would.
  await new Promise(r => setTimeout(r, 50));
  return { n: input.n * 10, parent: ctx.parentWorkflowRunId() };
} });

const wf = hatchet.workflow({ name: "fanout" });
const ok = wf.task({ name: "ok", fn: async (_i, ctx: any) => {
  const one = await ctx.runChild(batch, { n: 5 }, { key: "five" });
  const ref = await ctx.runNoWaitChild("fanout-batch", { n: 7 });
  // By name only, never imported here: its own folder in the checkout.
  const other = await ctx.runChild("fanout-other", { n: 1 });
  const missing = await ctx.runChild("no-such-flow", {}).catch((e: Error) => e.message);
  return { one, later: await ref.output, other, missing, id: ctx.workflowRunId(), refId: ref.workflowRunId };
} });
wf.task({ name: "bulk", fn: async (_i, ctx: any) =>
  ctx.bulkRunChildren([1, 2, 3].map(n => ({ workflow: batch, input: { n } }))) });
export default wf;
`,
);

write(
  "fanout-other",
  `import { hatchet } from "../hatchet";
const wf = hatchet.workflow<{ n: number }>({ name: "fanout-other" });
wf.task({ name: "x", fn: async input => ({ got: input.n }) });
export default wf;
`,
);

const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => (body += chunk));
  req.on("end", () => {
    seen.push({
      path: req.url,
      headers: req.headers,
      body: JSON.parse(body || "{}"),
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/api/workflows/runtime/ai/")) {
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          error: "MCP OAuth tokens are restricted to the /api/mcp endpoint",
        }),
      );
      return;
    }
    res.end(JSON.stringify({ rows: [{ one: 1 }], rowCount: 1 }));
  });
});
let apiUrl;
before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

test("runs the steps parents first, with ancestors' outputs, logs and the workflow's name", async () => {
  const lines = [];
  const result = await runWorkflow(await loadWorkflow(repo, "chain"), {
    input: { n: 1 },
    onLog: line => lines.push(`${line.task} ${line.level} ${line.message}`),
  });
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(
    result.tasks.map(t => [t.name, t.status]),
    [
      ["a", "COMPLETED"],
      ["b", "COMPLETED"],
      ["c", "COMPLETED"],
    ],
  );
  assert.deepEqual(result.tasks[0].output, { n: 2, workflow: "chain" });
  assert.deepEqual(result.tasks[2].output, { a: 2, b: 20, h: "local import" });
  assert.deepEqual(lines, ["a info a got 1", "c warn c ran"]);
  assert.equal(result.tasks[2].logs[0].level, "warn");
});

test("--task reruns one step from the saved outputs, and needs them", async () => {
  const workflow = await loadWorkflow(repo, "chain");
  const saved = await runWorkflow(workflow, { input: { n: 1 } });
  saved.tasks[1].output = { n: 99 };
  const rerun = await runWorkflow(workflow, {
    input: { n: 1 },
    task: "c",
    saved,
  });
  assert.deepEqual(rerun.tasks.find(t => t.name === "c").output, {
    a: 2,
    b: 99,
    h: "local import",
  });
  assert.equal(rerun.tasks.length, 3, "the rest of the earlier run is kept");
  const alone = await runWorkflow(workflow, { input: {}, task: "c" });
  assert.equal(alone.tasks[0].status, "CANCELLED");
  assert.match(alone.tasks[0].error, /run the whole workflow first/);
  await assert.rejects(
    runWorkflow(workflow, { task: "nope" }),
    /has no step "nope"/,
  );
});

test("retries, a failed parent cancels its children, timeouts, unsupported ctx", async () => {
  const result = await runWorkflow(await loadWorkflow(repo, "flaky"), {});
  const by = Object.fromEntries(result.tasks.map(t => [t.name, t]));
  assert.equal(result.status, "FAILED");
  assert.deepEqual(
    [by.once.status, by.once.attempts, by.once.output],
    ["COMPLETED", 2, { calls: 2 }],
  );
  assert.deepEqual([by.never.status, by.never.attempts], ["FAILED", 2]);
  assert.match(by.never.error, /always/);
  assert.equal(by.after.status, "CANCELLED");
  assert.match(by.slow.error, /executionTimeout \(1s\)/);
  assert.match(
    by.runid.error,
    /ctx\.putStream is not supported in test runs; run it on the workers/,
  );
});

test("what the stand-in does not support, and a misnamed workflow, throw", async () => {
  await assert.rejects(
    loadWorkflow(repo, "unsupported"),
    /hatchet\.workflow\(\{ concurrency \}\) is not supported in test runs/,
  );
  await assert.rejects(
    loadWorkflow(repo, "misnamed"),
    /must default-export the workflow named "misnamed"/,
  );
  await assert.rejects(
    loadWorkflow(repo, "absent"),
    /workflows\/absent\/workflow\.ts does not exist/,
  );
  assert.equal(timeoutMs("5m"), 300_000);
  assert.equal(timeoutMs(), 60_000);
});

test("mako workflow run: real lib/mako calls with the key and the workflow's name; result file", async () => {
  const cwd = process.cwd();
  process.chdir(repo);
  process.env.MAKO_API_KEY = "test-key";
  const logged = [];
  try {
    const code = await main(["workflow", "run", "calls", "--api-url", apiUrl], {
      log: l => logged.push(l),
    });
    assert.equal(code, 0, logged.join("\n"));
  } finally {
    process.chdir(cwd);
    delete process.env.MAKO_API_KEY;
  }
  const call = seen.find(s => s.path === "/api/workflows/runtime/query");
  assert.equal(call.headers.authorization, "Bearer test-key");
  assert.equal(call.headers["x-mako-workflow"], "calls");
  assert.deepEqual(call.body, { connectionId: "conn1", query: "SELECT 1" });
  const file = path.join(repo, ".mako", "runs", "calls.json");
  const result = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(result.tasks[0].output, { rows: [{ one: 1 }] });
  assert.equal(
    fs.readFileSync(path.join(repo, ".mako", "runs", ".gitignore"), "utf8"),
    "*\n",
  );
  assert.ok(logged.at(-1).startsWith("COMPLETED."));
});

test("a model call names the workflow, and Mako's refusal reads as Mako wrote it", async () => {
  const cwd = process.cwd();
  process.chdir(repo);
  process.env.MAKO_API_KEY = "test-key";
  const logged = [];
  try {
    const code = await main(["workflow", "run", "model", "--api-url", apiUrl], {
      log: l => logged.push(l),
    });
    assert.equal(code, 1);
  } finally {
    process.chdir(cwd);
    delete process.env.MAKO_API_KEY;
  }
  const call = seen.find(
    s => s.path === "/api/workflows/runtime/ai/language-model",
  );
  assert.equal(call.headers["x-mako-workflow"], "model");
  const result = JSON.parse(
    fs.readFileSync(path.join(repo, ".mako", "runs", "model.json"), "utf8"),
  );
  assert.match(
    result.tasks[0].error,
    /Mako refused the model call \(403\): MCP OAuth tokens are restricted to the \/api\/mcp endpoint/,
  );
});

test("child runs: runChild, runNoWaitChild, bulkRunChildren, each kept under its parent step", async () => {
  const lines = [];
  const result = await runWorkflow(await loadWorkflow(repo, "fanout"), {
    onLog: line => lines.push(`${line.task}: ${line.message}`),
  });
  const [ok, bulk] = result.tasks;
  // Waited for: its outputs by step name; started and awaited later too.
  assert.equal(ok.status, "COMPLETED");
  assert.deepEqual(ok.output.one, { label: { n: 50, parent: result.runId } });
  assert.deepEqual(ok.output.later, { label: { n: 70, parent: result.runId } });
  assert.equal(ok.output.id, result.runId);
  assert.deepEqual(ok.output.other, { x: { got: 1 } });
  assert.match(
    ok.output.missing,
    /workflows\/no-such-flow\/workflow\.ts does not exist/,
  );
  assert.deepEqual(
    ok.children.map(c => [c.workflow, c.index, c.key, c.status]),
    [
      ["fanout-batch", 0, "five", "COMPLETED"],
      ["fanout-batch", 1, undefined, "COMPLETED"],
      ["fanout-other", 2, undefined, "COMPLETED"],
      ["no-such-flow", 3, undefined, "FAILED"],
    ],
  );
  assert.equal(ok.output.refId, ok.children[1].runId);
  // In bulk, one child fails: the parent step fails as Hatchet's would, and
  // every child keeps its own steps and logs.
  assert.equal(bulk.status, "FAILED");
  assert.match(
    bulk.error,
    /child fanout-batch\[1\] failed in "label": Error: batch 2 broke/,
  );
  assert.deepEqual(
    bulk.children.map(c => [c.index, c.status, c.tasks[0].status]),
    [
      [0, "COMPLETED", "COMPLETED"],
      [1, "FAILED", "FAILED"],
      [2, "COMPLETED", "COMPLETED"],
    ],
  );
  assert.deepEqual(bulk.children[2].tasks[0].output, {
    n: 30,
    parent: result.runId,
  });
  assert.equal(
    bulk.children[0].tasks[0].logs[0].message,
    "batch 1 index 0 key undefined",
  );
  assert.ok(
    lines.includes(
      "bulk › fanout-batch[2] label: batch 3 index 2 key undefined",
    ),
  );
  assert.equal(result.status, "FAILED");
});
