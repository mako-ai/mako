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
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = ${JSON.stringify(root)};
const ENV_PATH = ${JSON.stringify(envPath)};
const PORTS = ${JSON.stringify(PORTS_REGISTRY)};
const LOG = ${JSON.stringify(AGENT_LOG)};
const PID = ${JSON.stringify(AGENT_PID)};
// Idle reaper state: last time each dev server had a viewer, and how long a
// server may sit with none before the agent stops it.
const ACTIVE = "/tmp/mako-dev-active.json";
const IDLE_TTL_MS = 20 * 60 * 1000;
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

// Porcelain v1 with -z: NUL-separated, paths UNQUOTED. Without -z git
// C-quotes any path holding a quote, backslash or non-ASCII, and the quoted
// literal is not a path the API can stage or discard. A rename is two
// fields (new, then old); the second is skipped.
function parsePorcelainZ(stdout) {
  const records = stdout.split("\\0");
  let branch = null;
  let ahead = 0;
  const changes = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith("## ")) {
      branch = parseHeader(record);
      ahead = Number(/\\[ahead (\\d+)/.exec(record)?.[1] ?? 0);
      continue;
    }
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    let status = "modified";
    if (xy === "??" || xy.includes("A")) status = "added";
    else if (xy.includes("D")) status = "deleted";
    else if (xy.includes("R") || xy.includes("C")) {
      status = "renamed";
      i++;
    }
    changes.push({
      path,
      status,
      staged: xy[0] !== " " && xy[0] !== "?",
      unstaged: xy === "??" || xy[1] !== " ",
    });
  }
  return { branch, ahead, changes };
}

async function gitState() {
  try {
    const { stdout } = await run(
      "git",
      // --no-optional-locks: a background observer must never take the
      // index lock (status refreshes the index by default) — it raced a
      // git commit typed in the terminal into "index.lock: File exists".
      ["--no-optional-locks", "-C", ROOT, "status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const { branch, ahead, changes } = parsePorcelainZ(stdout);
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
  // Truth is the PORT, not the session socket: a server whose dtach session
  // died (an orphan) still answers, still holds its port, and must still
  // show as running — that is exactly the state a user needs to see and
  // stop. Probe every registered port, AND the dev-port range: a server
  // someone started from a shell (npm run dev) has no registry entry, so
  // ask it which app it serves — vite serves the app root, and the app's
  // package.json name is its folder.
  let ports = {};
  try {
    ports = JSON.parse(readFileSync(PORTS, "utf8"));
  } catch {
    ports = {};
  }
  const bySlug = new Map();
  for (const [key, port] of Object.entries(ports)) {
    if (Number.isInteger(port)) bySlug.set(key.replace(/^apps\\//, ""), port);
  }
  const knownPorts = new Set(bySlug.values());
  // A raw TCP connect that closes at once — NOT an HTTP fetch. fetch keeps its
  // socket in a keep-alive pool, which would linger as an ESTABLISHED
  // connection to the port and make the idle reaper below think a viewer is
  // present on every server the agent probes. A connect/destroy leaves nothing
  // behind, so activeConns() sees only real viewers.
  const probe = port =>
    new Promise(resolve => {
      const sock = connect(port, "127.0.0.1");
      const done = ok => {
        try { sock.destroy(); } catch {}
        resolve(ok);
      };
      sock.setTimeout(800);
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
      sock.once("timeout", () => done(false));
    });
  const out = [];
  for (const [slug, port] of bySlug) {
    if (await probe(port)) out.push({ slug, port });
  }
  for (let port = 5173; port <= 5183; port++) {
    if (knownPorts.has(port)) continue;
    if (!(await probe(port))) continue;
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/package.json", {
        signal: AbortSignal.timeout(800),
      });
      if (!res.ok) continue;
      const pkg = await res.json();
      const name = typeof pkg.name === "string" ? pkg.name : "";
      if (name && existsSync(ROOT + "/apps/" + name) && !out.some(d => d.slug === name)) {
        out.push({ slug: name, port });
      }
    } catch {
      // Something else on that port; not an app.
    }
  }
  return out;
}

// How many viewers are connected to a dev-server port right now. "Viewer" =
// an ESTABLISHED TCP connection to the port — the preview iframe holds one
// open for HMR while it is on screen, and E2B's proxy holds it for as long as
// the browser does. Read from /proc so it costs nothing and needs no tool.
function activeConns(port) {
  let count = 0;
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let data = "";
    try {
      data = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const lines = data.split("\\n");
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\\s+/);
      if (parts.length < 4) continue;
      if (parts[3] !== "01") continue; // TCP_ESTABLISHED
      const lp = parts[1].split(":")[1];
      if (lp && parseInt(lp, 16) === port) count++;
    }
  }
  return count;
}

// Stop an idle dev server: kill the launcher (which is vite), drop its
// session socket, and free its registry slot. A STOP, never a start.
async function reap(slug) {
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) return;
  try {
    await run("/bin/sh", [
      "-c",
      'pkill -f "[m]ako-dev-' + slug + '.mjs" 2>/dev/null; rm -f /tmp/mako-term-dev-' + slug + '.sock',
    ]);
  } catch {
    // pkill exits non-zero when nothing matched; not an error here.
  }
  try {
    let m = {};
    try {
      m = JSON.parse(readFileSync(PORTS, "utf8"));
    } catch {
      m = {};
    }
    delete m["apps/" + slug];
    writeFileSync(PORTS, JSON.stringify(m));
  } catch {
    // Registry rewrite is best effort; a stale entry is probed away next tick.
  }
  log("reaped idle dev server " + slug);
}

// Open terminal session ids, so a shell opened in one browser shows in
// another. The dtach socket names ARE the ids: mako-term-<id>.sock.
function terminals() {
  try {
    return readdirSync("/tmp")
      .filter(f => f.startsWith("mako-term-") && f.endsWith(".sock"))
      .map(f => f.slice("mako-term-".length, -".sock".length));
  } catch {
    return [];
  }
}

let lastSent = "";
let lastSentAt = 0;
let failStreak = 0;

async function tick() {
  const git = await gitState();
  const servers = await devServers();
  // Idle reaper (apps-v2.md §13.9): the box is the authority for liveness and
  // may STOP a dev server no one is watching — it must NEVER start one. A
  // freshly seen server gets a full TTL of grace before it can be reaped.
  let active = {};
  try {
    active = JSON.parse(readFileSync(ACTIVE, "utf8"));
  } catch {
    active = {};
  }
  const now = Date.now();
  const alive = [];
  for (const s of servers) {
    if (activeConns(s.port) > 0 || active[s.slug] == null) active[s.slug] = now;
    if (now - active[s.slug] > IDLE_TTL_MS) {
      await reap(s.slug);
      delete active[s.slug];
    } else {
      alive.push(s);
    }
  }
  for (const k of Object.keys(active)) {
    if (!servers.some(s => s.slug === k)) delete active[k];
  }
  try {
    writeFileSync(ACTIVE, JSON.stringify(active));
  } catch {
    // Best effort; a lost file just restarts the grace window.
  }
  const snapshot = { source: "agent", devServers: alive, terminals: terminals() };
  if (process.env.E2B_SANDBOX_ID) snapshot.sandboxId = process.env.E2B_SANDBOX_ID;
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
