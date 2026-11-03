// Workflow worker entrypoint. One container serves one workspace: it asks
// Mako which commit to run and which workflows are active
// (GET /api/workflows/runtime/head), fetches and typechecks `workflows/` at
// that commit, starts a worker, stops the old one, and reports. A commit that does not build is reported and the previous one
// keeps running.
//
// Env: MAKO_URL, MAKO_API_KEY. The Hatchet token comes from Mako.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepare, startWorker, typecheck } from "./build.mjs";

const READY_FILE = "/tmp/ready";
const SOURCE_ROOT = "/tmp/src";
const POLL_MS = 10_000;
// A failed target is tried again, later: a commit that does not build costs
// a typecheck now and then, and a Hatchet that was down is not waited on
// forever.
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
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
    body: JSON.stringify({ sha, error }),
  }).catch(err => console.error("Could not report to Mako:", err.message));
}

async function fetchSource(sha) {
  // A fresh folder per attempt: the running worker still reads its own.
  const dir = join(SOURCE_ROOT, `${sha}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const res = await mako(`/source/${sha}`);
    if (!res.ok) throw new Error(`source fetch failed: ${res.status}`);
    const tarball = join(dir, "src.tgz");
    writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
    execFileSync("tar", ["-xzf", tarball, "-C", dir]);
    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * The running worker process (`current`) and the target that last failed
 * (`failed`, with when to try it again), so a broken commit is not rebuilt
 * on every poll. A target is a commit plus the set of active workflows: a
 * switch flipped in Mako restarts the worker with the triggers it now needs.
 */
let current = null;
let failed = null;

async function switchTo(target, hatchetToken, active) {
  const key = `${target.tree}:${hatchetToken}:${active.join(",")}`;
  if (current?.key === key) return;
  const lastFailure = failed?.key === key ? failed : null;
  if (lastFailure && Date.now() < lastFailure.retryAt) return;
  console.log(`Switching to ${target.sha} (active: ${active.join(", ")})`);
  let root;
  let child;
  try {
    root = await fetchSource(target.sha);
    prepare(root);
    const errors = typecheck(root);
    if (errors) throw new Error(errors);
    child = await startWorker(root, {
      GIT_SHA: target.sha,
      HATCHET_CLIENT_TOKEN: hatchetToken,
      WORKFLOWS_ACTIVE: active.join(","),
    });
  } catch (err) {
    console.error(`Build failed at ${target.sha}:\n${err.message}`);
    // Source that could not be fetched is tried again on the next poll; a
    // commit that did not build or start is reported and tried again later,
    // each time after a longer wait.
    if (!root) return;
    const attempts = (lastFailure?.attempts ?? 0) + 1;
    const wait = Math.min(RETRY_MIN_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
    failed = { key, attempts, retryAt: Date.now() + wait };
    rmSync(root, { recursive: true, force: true });
    await report(target.sha, err.message);
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
  await report(target.sha);
}

async function poll() {
  try {
    const res = await mako("/head");
    if (!res.ok) throw new Error(`head: ${res.status} ${await res.text()}`);
    const head = await res.json();
    // Ready means this pod reaches Mako with its key; a rollout then
    // finishes whether or not anything is deployed yet.
    writeFileSync(READY_FILE, "");
    if (!head.hatchetToken) return;
    if (head.live) {
      await switchTo(head.live, head.hatchetToken, head.active ?? []);
    } else {
      // Nothing to run (`workflows/` was deleted): stop.
      current?.child.kill("SIGTERM");
      current = null;
    }
  } catch (err) {
    console.error("Poll failed:", err.message);
  }
}

process.on("SIGTERM", () => {
  console.log("SIGTERM: finishing running tasks");
  const child = current?.child;
  if (!child) process.exit(0);
  child.once("exit", () => process.exit(0));
  child.kill("SIGTERM");
});

for (;;) {
  await poll();
  await new Promise(resolve => setTimeout(resolve, POLL_MS));
}
