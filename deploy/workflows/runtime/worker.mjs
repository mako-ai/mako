// One Hatchet worker running the workflows of one commit, started by
// entrypoint.mjs. A workflow is `workflows/<name>/workflow.ts` whose default
// export is the workflow named `<name>`. A preview (PREVIEW=1) gets prefixed
// names and no schedules or event triggers: it runs only when started.
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
  if (process.env.PREVIEW) {
    for (const trigger of ["on", "onCrons", "onEvents"]) {
      delete workflow.definition[trigger];
    }
  }
  workflows.push(workflow);
}

if (workflows.length === 0) {
  // Nothing to run is a mistake in the layout, not a deploy: say where the
  // files are, so a file one folder too deep is seen at once.
  const found = readdirSync(dir, { recursive: true })
    .filter(file => String(file).endsWith("workflow.ts"))
    .map(file => `workflows/${file}`);
  console.error(
    "No workflow found. A workflow is the file workflows/<name>/workflow.ts." +
      (found.length ? ` Found instead: ${found.join(", ")}` : ""),
  );
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
