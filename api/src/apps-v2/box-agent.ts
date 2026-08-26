/**
 * The box agent — a small process inside every sandbox that tells Mako what
 * the box looks like, the moment it changes.
 *
 * Polls locally (cheap: `git status` in the box and a look at the dev-session
 * sockets, every 2s) and POSTs a snapshot to the API only when something
 * changed, plus a 30s heartbeat that keeps the API-side snapshot alive. Git
 * hooks in the clone (post-checkout, post-commit, post-merge, post-rewrite)
 * run the same script once, so a branch switch or commit is reported
 * instantly rather than on the next tick.
 *
 * Runs under dtach like every other session in the box (`mako-box-agent`
 * socket), survives pause/resume with the machine, and is re-installed
 * whenever its source changes (a version stamp in the file) or it is found
 * not running. It only ever READS the box and talks to the API with the
 * box's own scoped token — it cannot do anything the box could not already.
 */
import { createHash } from "node:crypto";
import { loggers } from "../logging";
import { boxEnvPath, boxRoot, sh } from "./box";
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "./sandbox/provider";

const logger = loggers.api("apps-v2-box-agent");

const AGENT_PATH = "/tmp/mako-box-agent.mjs";
const AGENT_SOCK = "/tmp/mako-box-agent.sock";
const AGENT_LOG = "/tmp/mako-box-agent.log";
const AGENT_PID = "/tmp/mako-box-agent.pid";
const PORTS_REGISTRY = "/tmp/mako-dev-ports.json";
const HOOKS = ["post-checkout", "post-commit", "post-merge", "post-rewrite"];
/** Re-check the agent this often per box (an exec); on API restart, immediately. */
const ENSURE_INTERVAL_MS = 5 * 60 * 1000;

function agentSource(root: string, envPath: string): string {
  const body = `
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = ${JSON.stringify(root)};
const ENV_PATH = ${JSON.stringify(envPath)};
const PORTS = ${JSON.stringify(PORTS_REGISTRY)};
const LOG = ${JSON.stringify(AGENT_LOG)};
const PID = ${JSON.stringify(AGENT_PID)};
const ONCE = process.argv.includes("--once");

function log(message) {
  try {
    appendFileSync(LOG, new Date().toISOString() + " " + message + "\\n");
  } catch {
    // Logging is best effort.
  }
}

function env() {
  try {
    return Object.fromEntries(
      readFileSync(ENV_PATH, "utf8")
        .split("\\n")
        .filter(Boolean)
        .map(line => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
  } catch {
    return {};
  }
}

// "## main...origin/main [ahead 1]" / "## main" / "## HEAD (no branch)" /
// "## No commits yet on main" — the branch is the first token after "## ",
// up to a dot or space; the "No commits yet" form names it last.
function parseHeader(line) {
  const fresh = /^## No commits yet on (\\S+)/.exec(line);
  if (fresh) return fresh[1];
  const m = /^## ([^. ]+)/.exec(line);
  return m ? m[1] : null;
}

async function gitState() {
  try {
    const { stdout } = await run(
      "git",
      // --no-optional-locks: a background observer must never take the
      // index lock (status refreshes the index by default) — it raced a
      // git commit typed in the terminal into "index.lock: File exists".
      ["--no-optional-locks", "-C", ROOT, "status", "--porcelain=v1", "--branch", "--untracked-files=all"],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    let branch = null;
    let ahead = 0;
    const changes = [];
    for (const line of stdout.split("\\n")) {
      if (!line) continue;
      if (line.startsWith("## ")) {
        branch = parseHeader(line);
        ahead = Number(/\\[ahead (\\d+)/.exec(line)?.[1] ?? 0);
      } else changes.push(line);
    }
    let head = null;
    try {
      head = (await run("git", ["-C", ROOT, "rev-parse", "HEAD"])).stdout.trim() || null;
    } catch {
      head = null;
    }
    return { branch, ahead, head, changes: changes.slice(0, 5000) };
  } catch (error) {
    return null;
  }
}

async function devServers() {
  let ports = {};
  try {
    ports = JSON.parse(readFileSync(PORTS, "utf8"));
  } catch {
    ports = {};
  }
  let files = [];
  try {
    files = readdirSync("/tmp");
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    const m = /^mako-term-dev-(.+)\\.sock$/.exec(file);
    if (!m) continue;
    const port = ports["apps/" + m[1]];
    if (!Number.isInteger(port)) continue;
    // A socket names a session; only a port that ANSWERS is a server.
    const up = await fetch("http://127.0.0.1:" + port + "/", {
      signal: AbortSignal.timeout(800),
    })
      .then(() => true)
      .catch(() => false);
    if (up) out.push({ slug: m[1], port });
  }
  return out;
}

let lastSent = "";
let lastSentAt = 0;
let failStreak = 0;

async function tick() {
  const git = await gitState();
  const servers = await devServers();
  const snapshot = { source: "agent", devServers: servers };
  if (git) {
    if (git.branch) snapshot.branch = git.branch;
    if (git.head) snapshot.head = git.head;
    snapshot.ahead = git.ahead;
    snapshot.changes = git.changes;
  }
  const key = JSON.stringify(snapshot);
  const heartbeatDue = Date.now() - lastSentAt > 30000;
  if (key === lastSent && !heartbeatDue && !ONCE) return;

  const e = env();
  if (!e.MAKO_API || !e.MAKO_WS || !e.MAKO_TOKEN_FILE) return;
  let token;
  try {
    token = readFileSync(e.MAKO_TOKEN_FILE, "utf8").trim();
  } catch {
    return;
  }
  try {
    const res = await fetch(e.MAKO_API + "/api/apps-v2-box/" + e.MAKO_WS + "/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: key,
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error("http " + res.status);
    lastSent = key;
    lastSentAt = Date.now();
    if (failStreak) {
      log("reachable again after " + failStreak + " failures");
      failStreak = 0;
    }
  } catch (error) {
    failStreak += 1;
    if (failStreak === 1 || failStreak % 30 === 0) {
      log("notify failed (" + failStreak + "): " + (error && error.message));
    }
  }
}

if (ONCE) {
  await tick();
  process.exit(0);
}
try {
  writeFileSync(PID, String(process.pid));
} catch {
  // Without a pid file the installer will start a second agent; harmless.
}
log("agent started (pid " + process.pid + ")");
for (;;) {
  await tick();
  // Back off while the API is unreachable; a tunnel restart in development
  // can take a minute to become routable from inside the box.
  const delay = failStreak ? Math.min(2000 * failStreak, 15000) : 2000;
  await new Promise(resolve => setTimeout(resolve, delay));
}
`.trimStart();
  const version = createHash("sha1").update(body).digest("hex").slice(0, 12);
  return `// mako-box-agent v${version}\n${body}`;
}

function hookSource(): string {
  return [
    "#!/bin/sh",
    "# Mako: report the new HEAD/branch right away instead of on the next",
    "# agent tick. Detached and silent: a hook must never slow git down or",
    "# fail a commit because the API was unreachable.",
    `(node ${AGENT_PATH} --once >/dev/null 2>&1 &)`,
    "exit 0",
    "",
  ].join("\n");
}

/** Write the agent + hooks and make sure the agent loop is running. */
export async function installBoxAgent(ctx: SandboxExecContext): Promise<void> {
  const provider = getSandboxProvider();
  const root = boxRoot(ctx);
  const source = agentSource(root, boxEnvPath(ctx));
  const version = source.split("\n")[0];
  const hooksDir = `${root}/.git/hooks`;

  // The agent file is rewritten only when its source changed (the version
  // stamp on line 1); a changed agent is killed so the launch below starts
  // the new one. Hooks are cheap and always rewritten.
  const hookWrites = HOOKS.map(
    name =>
      `cat > ${sh(`${hooksDir}/${name}`)} <<'MAKO_HOOK_EOF'\n${hookSource()}MAKO_HOOK_EOF\nchmod +x ${sh(`${hooksDir}/${name}`)}`,
  ).join("\n");
  // Liveness by pid file, never by pgrep/pkill -f: the installing shell's
  // own command line names the agent file, so a pattern match found the
  // installer itself, concluded "already running", and never launched.
  const alive = `([ -f ${AGENT_PID} ] && kill -0 "$(cat ${AGENT_PID})" 2>/dev/null)`;
  await provider.exec(
    ctx,
    [
      `mkdir -p ${sh(hooksDir)}`,
      `if ! head -n 1 ${AGENT_PATH} 2>/dev/null | grep -qF ${sh(version)}; then cat > ${AGENT_PATH} <<'MAKO_AGENT_EOF'\n${source}\nMAKO_AGENT_EOF\nif ${alive}; then kill "$(cat ${AGENT_PID})" 2>/dev/null; sleep 0.3; fi; rm -f ${AGENT_PID}; fi`,
      hookWrites,
      "echo installed",
    ].join("\n"),
    { timeoutMs: 30_000 },
  );

  // Launch if not running. dtach like every other session in the box; the
  // nohup fallback covers machines without it (the local provider on macOS).
  await provider.execDetached(
    ctx,
    `if ! ${alive}; then rm -f ${AGENT_SOCK} ${AGENT_PID}; if command -v dtach >/dev/null; then dtach -n ${AGENT_SOCK} node ${AGENT_PATH}; else nohup node ${AGENT_PATH} >/dev/null 2>&1 & fi; fi; echo started`,
    { timeoutMs: 30_000 },
  );
}

const ensured = new Map<string, number>();

/**
 * Make sure this box has a running agent — throttled per box, so the hot
 * paths that call it (every ensureBox) pay for one exec every few minutes
 * and immediately after an API restart (the map starts empty).
 */
export async function ensureBoxAgent(
  ctx: SandboxExecContext,
  options: { force?: boolean } = {},
): Promise<void> {
  // Unit tests run the local provider on the developer's machine; they must
  // not leave a daemon polling a temp dir behind.
  if (process.env.VITEST) return;
  const at = ensured.get(ctx.sessionKey) ?? 0;
  if (!options.force && Date.now() - at < ENSURE_INTERVAL_MS) return;
  ensured.set(ctx.sessionKey, Date.now());
  try {
    await installBoxAgent(ctx);
  } catch (error) {
    ensured.delete(ctx.sessionKey);
    logger.warn("Apps v2 box agent could not be installed", {
      sessionKey: ctx.sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The box is gone; the next one needs its own agent. */
export function forgetBoxAgent(sessionKey: string): void {
  ensured.delete(sessionKey);
}
