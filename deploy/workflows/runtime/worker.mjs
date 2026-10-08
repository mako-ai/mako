// One Hatchet worker running the workflows of one commit. Started and stopped
// by entrypoint.mjs, which passes the source directory and the commit.
//
// A workflow is a folder: `workflows/<name>/workflow.ts`, whose default export
// is the Hatchet workflow named `<name>`. Folders without that file (shared
// code such as `lib/`) are not workflows.
//
// Env: WORKFLOWS_ROOT, GIT_SHA, HATCHET_CLIENT_TOKEN, optional WORKER_SLOTS.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

register();
const dir = join(process.env.WORKFLOWS_ROOT, "workflows");
const load = file => import(pathToFileURL(join(dir, file)).href);

const { hatchet } = await load("hatchet.ts");
if (!hatchet) {
  console.error("workflows/hatchet.ts must export { hatchet }");
  process.exit(1);
}

const workflows = [];
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  const file = join(entry.name, "workflow.ts");
  if (!entry.isDirectory() || !existsSync(join(dir, file))) continue;
  const workflow = (await load(file)).default;
  // The folder name is the workflow's id everywhere, so the two must agree.
  const name = workflow?.definition?.name;
  if (name !== entry.name) {
    console.error(
      `workflows/${file} must default-export the workflow named "${entry.name}"` +
        (name ? `, not "${name}"` : ""),
    );
    process.exit(1);
  }
  workflows.push(workflow);
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
