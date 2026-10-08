// One Hatchet worker running the workflows of one commit. Started and stopped
// by entrypoint.mjs, which passes the source directory and the commit.
//
// Env: WORKFLOWS_ROOT, GIT_SHA, HATCHET_CLIENT_TOKEN, optional WORKER_SLOTS.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

register();
const { hatchet, workflows } = await import(
  pathToFileURL(join(process.env.WORKFLOWS_ROOT, "workflows/index.ts")).href
);
if (!hatchet || !Array.isArray(workflows)) {
  console.error("workflows/index.ts must export { hatchet, workflows }");
  process.exit(1);
}

const worker = await hatchet.worker("workspace", {
  workflows,
  slots: Number(process.env.WORKER_SLOTS ?? 50),
  labels: { git_sha: process.env.GIT_SHA },
});

process.on("SIGTERM", async () => {
  console.log(`${process.env.GIT_SHA}: finishing running tasks`);
  await worker.stop();
  process.exit(0);
});

worker.start().catch(err => {
  console.error("Worker stopped:", err);
  process.exit(1);
});
console.log(
  `Worker started at ${process.env.GIT_SHA}: ${workflows.length} workflows`,
);
process.send?.("ready");
