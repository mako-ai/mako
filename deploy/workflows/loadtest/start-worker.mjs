// Start worker.mjs on the synthetic workflow, without the entrypoint: no
// commit to follow, no source to fetch.
import { cpSync, mkdirSync } from "node:fs";
import { prepare } from "/runtime/build.mjs";

const root = "/tmp/src/loadtest";
mkdirSync(root, { recursive: true });
cpSync("/loadtest/workflows", `${root}/workflows`, { recursive: true });
prepare(root);
process.env.WORKFLOWS_ROOT = root;
process.env.GIT_SHA = "loadtest";
process.env.WORKER_RUN = `loadtest-${process.pid}`;
for (const name of [
  "WORKFLOWS_MAX_STEPS",
  "WORKFLOWS_MAX_RUNS",
  "WORKFLOWS_RATE_LIMITS",
]) {
  if (!process.env[name]) delete process.env[name];
}
await import("/runtime/worker.mjs");
