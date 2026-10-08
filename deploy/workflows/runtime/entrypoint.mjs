// Workflow worker entrypoint. One container serves one workspace and follows
// the commit Mako names for it:
//
//   1. ask Mako what to run:   GET /api/workflows/runtime/head
//   2. when the commit changes, fetch `workflows/` at it and typecheck it
//   3. start a worker for the new commit; once it is up, tell the old worker
//      to finish its running tasks and exit
//   4. report the commit now running, or the build error, to Mako
//
// A commit that fails its typecheck or cannot start is reported and skipped,
// and the worker for the previous commit keeps running.
//
// Env: MAKO_URL, MAKO_API_KEY. The Hatchet token comes from Mako, so the
// container holds one credential.
// Dev: WORKFLOWS_SOURCE_DIR + HATCHET_CLIENT_TOKEN run a local folder once,
// without Mako.
import { execFileSync, fork } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = process.env.WORKFLOWS_TMP_DIR ?? "/tmp";
const READY_FILE = join(TMP_DIR, "ready");
const SOURCE_ROOT = join(TMP_DIR, "src");
const POLL_MS = Number(process.env.WORKFLOWS_POLL_MS ?? 10_000);
const START_TIMEOUT_MS = 60_000;
const auth = { Authorization: `Bearer ${process.env.MAKO_API_KEY}` };

function mako(path, init = {}) {
  return fetch(`${process.env.MAKO_URL}/api/workflows/runtime${path}`, {
    ...init,
    headers: { ...auth, ...init.headers },
  });
}

async function report(sha, error) {
  await mako("/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(error === undefined ? { sha } : { sha, error }),
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

/** Typecheck `workflows/` under `root`. Returns the errors, or null. */
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
    return null;
  } catch (err) {
    return err.stdout?.toString() || err.message;
  }
}

/** Start a worker process. Resolves once it is up; rejects with its output. */
function startWorker(root, sha, hatchetToken) {
  return new Promise((resolve, reject) => {
    const child = fork(join(RUNTIME_DIR, "worker.mjs"), {
      env: {
        ...process.env,
        WORKFLOWS_ROOT: root,
        GIT_SHA: sha,
        ...(hatchetToken ? { HATCHET_CLIENT_TOKEN: hatchetToken } : {}),
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

/** The running worker: its process and what it was started from. */
let current = null;
/** A target that failed, so it is not rebuilt on every poll. */
let failed = null;

async function switchTo(head) {
  const key = `${head.tree}:${head.hatchetToken}`;
  if (current?.key === key || failed === key) return;
  console.log(`Switching to ${head.sha}`);
  let root;
  let child;
  try {
    root = await fetchSource(head.sha);
    const errors = typecheck(root);
    if (errors) throw new Error(errors);
    child = await startWorker(root, head.sha, head.hatchetToken);
  } catch (err) {
    failed = key;
    if (root) rmSync(root, { recursive: true, force: true });
    console.error(`Build failed at ${head.sha}:\n${err.message}`);
    await report(head.sha, err.message);
    return;
  }
  const previous = current;
  current = { key, child };
  failed = null;
  child.once("exit", () => {
    rmSync(root, { recursive: true, force: true });
    // If this worker died on its own, the next poll starts it again.
    if (current?.child === child) current = null;
  });
  previous?.child.kill("SIGTERM");
  writeFileSync(READY_FILE, head.sha);
  await report(head.sha);
}

async function poll() {
  try {
    const res = await mako("/head");
    if (!res.ok) throw new Error(`head: ${res.status} ${await res.text()}`);
    const head = await res.json();
    if (head.sha && head.hatchetToken) await switchTo(head);
  } catch (err) {
    console.error("Poll failed:", err.message);
  }
}

process.on("SIGTERM", () => {
  console.log("SIGTERM: finishing running tasks");
  if (!current) process.exit(0);
  current.child.once("exit", () => process.exit(0));
  current.child.kill("SIGTERM");
});

if (process.env.WORKFLOWS_SOURCE_DIR) {
  const root = process.env.WORKFLOWS_SOURCE_DIR;
  const errors = typecheck(root);
  if (errors) {
    console.error(`Build failed:\n${errors}`);
    process.exit(1);
  }
  const child = await startWorker(root, "dev");
  current = { key: "dev", child };
  child.once("exit", code => process.exit(code ?? 1));
} else {
  for (;;) {
    await poll();
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}
