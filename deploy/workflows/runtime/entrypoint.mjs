// Workflow worker entrypoint. One process per workspace pod:
//
//   1. fetch workflows/ at GIT_SHA from the Mako API (or use a local dir in dev)
//   2. typecheck it; on failure print the errors and exit 1 — the pod never
//      becomes ready, so Kubernetes keeps the previous pod and Mako shows these
//      log lines as the build error
//   3. start a Hatchet worker with label git_sha=<sha>, then mark ready
//   4. on SIGTERM, stop taking tasks, finish running ones, exit
//
// Env: GIT_SHA, MAKO_URL, MAKO_API_KEY, HATCHET_CLIENT_TOKEN (from the Secret),
// optional WORKFLOWS_SOURCE_DIR (dev: skip the fetch), WORKER_SLOTS.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
const READY_FILE = "/tmp/ready";
const sha = process.env.GIT_SHA ?? "dev";

async function fetchSource() {
  if (process.env.WORKFLOWS_SOURCE_DIR) return process.env.WORKFLOWS_SOURCE_DIR;
  const dir = "/tmp/src";
  mkdirSync(dir, { recursive: true });
  const res = await fetch(
    `${process.env.MAKO_URL}/api/workflows/runtime/source/${sha}`,
    { headers: { Authorization: `Bearer ${process.env.MAKO_API_KEY}` } },
  );
  if (!res.ok)
    throw new Error(`source fetch failed: ${res.status} ${await res.text()}`);
  const tarball = join(dir, "src.tgz");
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  execFileSync("tar", ["-xzf", tarball, "-C", dir]);
  return dir;
}

function typecheck(root) {
  // Workflow code resolves packages from the runtime image, nowhere else.
  const modules = join(root, "node_modules");
  if (!existsSync(modules))
    symlinkSync(join(RUNTIME_DIR, "node_modules"), modules);
  // Workflow files are ES modules; without this Node loads them as CommonJS.
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const tsconfig = join(root, "tsconfig.workflows.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        types: ["node"],
      },
      include: ["workflows/**/*.ts"],
    }),
  );
  try {
    execFileSync(join(RUNTIME_DIR, "node_modules/.bin/tsc"), ["-p", tsconfig], {
      cwd: root,
      stdio: "pipe",
    });
  } catch (err) {
    console.error(
      `Build failed at ${sha}:\n${err.stdout?.toString() ?? err.message}`,
    );
    process.exit(1);
  }
}

const root = await fetchSource();
typecheck(root);

register();
const { hatchet, workflows } = await import(
  pathToFileURL(join(root, "workflows/index.ts")).href
);
if (!hatchet || !Array.isArray(workflows)) {
  console.error(
    "Build failed: workflows/index.ts must export { hatchet, workflows }",
  );
  process.exit(1);
}

const worker = await hatchet.worker("workspace", {
  workflows,
  slots: Number(process.env.WORKER_SLOTS ?? 50),
  labels: { git_sha: sha },
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM: finishing running tasks");
  await worker.stop();
  process.exit(0);
});

worker.start().catch(err => {
  console.error("Worker stopped:", err);
  process.exit(1);
});
writeFileSync(READY_FILE, sha);
console.log(`Worker started at ${sha} with ${workflows.length} workflows`);
