// Workflow worker entrypoint. One container serves one workspace: it asks
// Mako which commit to run (GET /api/workflows/runtime/head), fetches and
// typechecks `workflows/` at it, starts a worker, stops the old one, and
// reports. A commit that does not build is reported and the previous one
// keeps running. A preview commit runs the same way in a second process.
//
// Env: MAKO_URL, MAKO_API_KEY. The Hatchet token comes from Mako.
import { execFileSync, fork } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
const READY_FILE = "/tmp/ready";
const SOURCE_ROOT = "/tmp/src";
const POLL_MS = 10_000;
const START_TIMEOUT_MS = 60_000;
// Preview workflows are registered in Hatchet as `preview_<name>`.
const PREVIEW_PREFIX = "preview_";
const auth = { Authorization: `Bearer ${process.env.MAKO_API_KEY}` };

function mako(path, init = {}) {
  return fetch(`${process.env.MAKO_URL}/api/workflows/runtime${path}`, {
    ...init,
    headers: { ...auth, ...init.headers },
  });
}

async function report(slot, sha, error) {
  await mako("/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha, error, preview: slot.preview }),
  }).catch(err => console.error("Could not report to Mako:", err.message));
}

async function fetchSource(sha) {
  // A fresh folder per attempt: the running worker still reads its own.
  const dir = join(SOURCE_ROOT, `${sha}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const res = await mako(`/source/${sha}`);
  if (!res.ok) throw new Error(`source fetch failed: ${res.status}`);
  const tarball = join(dir, "src.tgz");
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  execFileSync("tar", ["-xzf", tarball, "-C", dir]);
  return dir;
}

/**
 * Shared files every workflow imports: the Hatchet client and the Mako
 * helpers. The image supplies them, so a repo needs only its workflow
 * folders; a repo that has its own copy keeps it.
 */
function addDefaults(root) {
  for (const file of ["hatchet.ts", "lib/mako.ts"]) {
    const target = join(root, "workflows", file);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(RUNTIME_DIR, "defaults", file), target);
  }
}

/** Typecheck `workflows/` under `root`. Returns the errors, or null. */
function typecheck(root) {
  addDefaults(root);
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
    return null;
  } catch (err) {
    return err.stdout?.toString() || err.message;
  }
}

/** Start a worker process. Resolves once it is up; rejects with its output. */
function startWorker(slot, root, sha, hatchetToken) {
  return new Promise((resolve, reject) => {
    const child = fork(join(RUNTIME_DIR, "worker.mjs"), {
      env: {
        ...process.env,
        WORKFLOWS_ROOT: root,
        GIT_SHA: sha,
        HATCHET_CLIENT_TOKEN: hatchetToken,
        ...(slot.preview
          ? { PREVIEW: "1", HATCHET_CLIENT_NAMESPACE: PREVIEW_PREFIX }
          : {}),
      },
      stdio: ["ignore", "inherit", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk).slice(-4000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), START_TIMEOUT_MS);
    child.once("message", () => {
      clearTimeout(timer);
      resolve(child);
    });
    child.once("exit", code => {
      clearTimeout(timer);
      reject(new Error(stderr || `worker exited with code ${code}`));
    });
  });
}

/**
 * The two things a worker can run: the live code, and a preview of unmerged
 * work. Each has its running process (`current`) and the target that last
 * failed (`failed`), so a broken commit is not rebuilt on every poll.
 */
const slots = {
  live: { preview: false, current: null, failed: null },
  preview: { preview: true, current: null, failed: null },
};

async function switchTo(slot, target, hatchetToken) {
  const key = `${target.tree}:${hatchetToken}`;
  if (slot.current?.key === key || slot.failed === key) return;
  const label = slot.preview ? "preview" : "live";
  console.log(`Switching ${label} to ${target.sha}`);
  let root;
  let child;
  try {
    root = await fetchSource(target.sha);
    const errors = typecheck(root);
    if (errors) throw new Error(errors);
    child = await startWorker(slot, root, target.sha, hatchetToken);
  } catch (err) {
    console.error(`Build failed (${label}) at ${target.sha}:\n${err.message}`);
    // Source that could not be fetched is tried again on the next poll; a
    // commit that does not build is reported once and left alone.
    if (!root) return;
    slot.failed = key;
    rmSync(root, { recursive: true, force: true });
    await report(slot, target.sha, err.message);
    return;
  }
  const previous = slot.current;
  slot.current = { key, child };
  slot.failed = null;
  child.once("exit", () => {
    rmSync(root, { recursive: true, force: true });
    // If this worker died on its own, the next poll starts it again.
    if (slot.current?.child === child) slot.current = null;
  });
  previous?.child.kill("SIGTERM");
  writeFileSync(READY_FILE, target.sha);
  await report(slot, target.sha);
}

async function poll() {
  try {
    const res = await mako("/head");
    if (!res.ok) throw new Error(`head: ${res.status} ${await res.text()}`);
    const head = await res.json();
    if (!head.hatchetToken) return;
    // A slot Mako no longer names (the preview was merged, `workflows/` was
    // deleted) stops.
    for (const [slot, target] of [
      [slots.live, head.sha ? head : null],
      [slots.preview, head.preview],
    ]) {
      if (target) await switchTo(slot, target, head.hatchetToken);
      else {
        slot.current?.child.kill("SIGTERM");
        slot.current = null;
      }
    }
  } catch (err) {
    console.error("Poll failed:", err.message);
  }
}

process.on("SIGTERM", () => {
  console.log("SIGTERM: finishing running tasks");
  const children = Object.values(slots)
    .map(slot => slot.current?.child)
    .filter(Boolean);
  if (children.length === 0) process.exit(0);
  let left = children.length;
  for (const child of children) {
    child.once("exit", () => --left === 0 && process.exit(0));
    child.kill("SIGTERM");
  }
});

for (;;) {
  await poll();
  await new Promise(resolve => setTimeout(resolve, POLL_MS));
}
