// A sandbox run: `mako workflow run <name>` in a person's sandbox, the same
// command, the same code as on their laptop (the CLI's workflow files are
// installed next to this file, in cli/). Started detached by Mako
// (api/src/workflows/sandbox.ts); the run's result is the command's own JSON
// file, which Mako reads back. Before it runs, `workflows/` is typechecked
// the way the worker's build does: code that would not deploy fails the run
// with its type errors instead.
//
//   node run.mjs <workflow> <base64 of the JSON input> <result file>
//
// Env: WORKFLOWS_ROOT (the checkout), MAKO_URL, MAKO_API_KEY (the run's key,
// acting as the person who started it).
import { writeFileSync } from "node:fs";

import { typecheckCheckout } from "./build.mjs";
import { workflow } from "./cli/workflow.js";

const [name, encodedInput, out] = process.argv.slice(2);
const input = Buffer.from(encodedInput ?? "", "base64").toString() || "{}";
const startedAt = new Date();
const typeErrors = typecheckCheckout(process.env.WORKFLOWS_ROOT);
if (typeErrors) {
  console.log(typeErrors);
  writeFileSync(
    out,
    JSON.stringify({
      workflow: name,
      input: JSON.parse(input),
      status: "FAILED",
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      typeErrors,
      tasks: [],
    }),
  );
  process.exit(1);
}
const code = await workflow(
  {
    repoRoot: process.env.WORKFLOWS_ROOT,
    apiUrl: process.env.MAKO_URL,
    apiKey: process.env.MAKO_API_KEY,
  },
  ["run", name],
  { input, out },
  { log: console.log },
);
process.exit(code);
