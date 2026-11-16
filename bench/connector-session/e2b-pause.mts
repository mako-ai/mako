/**
 * A read session across an E2B pause, in a real E2B box.
 *
 * It drives the scripts the API sends (session-isolation.ts), verbatim and
 * hidden from argv as the API sends them (SandboxExecOptions.hideCommand).
 * The connector is a shell loop run as the per-run user, as in the Docker
 * suite. Two pauses:
 *
 * 1. Full (memory) snapshot, the kind the idle sweep takes. Session A has a
 *    10-minute idle limit and must carry on from batch 2. Session B has a
 *    5-second one and must end itself cleanly, its user and run directory
 *    gone. A bystander process group must survive every close and reap.
 * 2. Filesystem-only snapshot: the box boots again and every pid is reused.
 *    Session C's recorded wrapper pid is pointed at a live bystander with
 *    its real start time, as a reused pid would be. The next start reaps C
 *    and must not kill the bystander.
 *
 * Needs E2B_API_KEY in the environment (never printed). Every box it makes
 * is killed at the end.
 *
 *   cd api
 *   E2B_API_KEY=... pnpm exec tsx ../bench/connector-session/e2b-pause.mts
 *
 * Options: --template <id> (default: the mako-apps dev template),
 * --pause-seconds 20, --out <file>.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, "../../api");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const TEMPLATE = arg("template", "3f2t2qgqsu5m8e42xd5i");
const PAUSE_MS = Number(arg("pause-seconds", "20")) * 1000;
const DATE = new Date().toISOString().slice(0, 10);
const OUT = arg("out", path.join(HERE, "results", `e2b-pause-${DATE}.json`));

if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY is not set");

const mod = (rel: string) => import(pathToFileURL(path.join(API, rel)).href);
const { Sandbox } = await import(
  pathToFileURL(path.join(API, "node_modules/e2b/dist/index.mjs")).href
);
const iso = await mod("src/connectors/workspace/session-isolation.ts");
const runIso = await mod("src/connectors/workspace/run-isolation.ts");
const hiddenCmd = await mod("src/apps/sandbox/hidden-command.ts");

type Sh = { code: number; stdout: string; stderr: string; ms: number };
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  template: TEMPLATE,
  pauseMs: PAUSE_MS,
};
const checks: Array<{ check: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ check: name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let sbx: any = await Sandbox.create(TEMPLATE, {
  timeoutMs: 30 * 60_000,
  metadata: { purpose: "connector-session-pause-test" },
});
const boxId: string = sbx.sandboxId;
console.log(`box ${boxId}`);
report.box = boxId;

async function exec(
  script: string,
  options: { hide?: boolean; timeoutMs?: number } = {},
): Promise<Sh> {
  const run = hiddenCmd.commandToRun(script, { hideCommand: options.hide });
  const t0 = Date.now();
  try {
    const r = await sbx.commands.run(run.command, {
      user: "root",
      envs: run.env,
      timeoutMs: options.timeoutMs ?? 120_000,
    });
    return {
      code: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      ms: Date.now() - t0,
    };
  } catch (error: any) {
    return {
      code: typeof error?.exitCode === "number" ? error.exitCode : 1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? String(error?.message ?? error),
      ms: Date.now() - t0,
    };
  }
}
const root = (script: string, timeoutMs?: number) =>
  exec(script, { timeoutMs });
const hidden = (script: string, timeoutMs?: number) =>
  exec(script, { hide: true, timeoutMs });

const marker = (sh: Sh) =>
  sh.stdout
    .split("\n")
    .filter(line => line.startsWith("MAKO_SESSION "))
    .at(-1)
    ?.slice("MAKO_SESSION ".length);

const PRELUDE = `hello() { echo '{"type":"MAKO_SESSION","session":{"version":1}}'; }
record() { printf '{"type":"RECORD","record":{"stream":"s","data":{"v":"%s"}}}\\n' "$1"; }
state() { printf '{"type":"STATE","state":{"type":"STREAM","stream":{"stream_descriptor":{"name":"s"},"stream_state":{"n":%s}},"mako":{"hasMore":%s}}}\\n' "$1" "$2"; }
`;

const LIMITS = {
  maxBytes: 4 * 1024 * 1024,
  maxMessages: 50_000,
  buffer: 1,
  idleMs: 10 * 60_000,
  maxAgeMs: 30 * 60_000,
};

let node = "";

function layout() {
  return iso.sessionLayout(
    runIso.runLayout(
      randomBytes(8).toString("hex"),
      `mkc${randomBytes(6).toString("hex")}`,
      200_000 + Math.floor(Math.random() * 1_000_000_000),
      200_000 + Math.floor(Math.random() * 1_000_000_000),
    ),
  );
}

async function start(s: any, snippet: string, limits: Partial<typeof LIMITS>) {
  const config = `${s.run.dir}/config.json`;
  const write = await root(
    `umask 022; mkdir -p ${runIso.shellQuote(`${runIso.ISOLATED_INCOMING}/${s.id}`)} && printf %s sk_test > ${runIso.shellQuote(runIso.incomingPath(s.id, "config.json"))}`,
  );
  if (write.code !== 0) throw new Error(`write: ${write.stderr}`);
  const command = `sh -c ${runIso.shellQuote(`${PRELUDE}\n${snippet}`)} connector ${runIso.shellQuote(iso.connectorInput(config))}`;
  return hidden(
    iso.startScript({
      layout: s,
      inputs: [config],
      command,
      node,
      limits: { ...LIMITS, ...limits },
      waitMs: 20_000,
    }),
  );
}

const wait = async (s: any, seq: number, ack = seq - 1) =>
  marker(await hidden(iso.waitScript(s.id, seq, ack, 20_000)));
const close = async (s: any) =>
  marker(await hidden(iso.closeScript(s.id), 90_000));
const batch = async (s: any, seq: number) =>
  (await root(`cat ${runIso.shellQuote(iso.batchPath(s.id, seq))}`)).stdout;

async function recorded(s: any): Promise<string[]> {
  return (
    await root(`cat ${runIso.shellQuote(`${s.dir}/supervisor.pid`)}`)
  ).stdout
    .trim()
    .split(/\s+/);
}
const procStart = async (pid: string) =>
  (
    await root(
      `awk '{ sub(/.*\\) /, ""); print $20 }' /proc/${pid}/stat 2>/dev/null`,
    )
  ).stdout.trim();
const alive = async (pid: string) =>
  (await root(`kill -0 ${pid} 2>/dev/null && echo yes`)).stdout.trim() ===
  "yes";
const bootId = async () =>
  (await root("cat /proc/sys/kernel/random/boot_id")).stdout.trim();
const clock = async () => Number((await root("date +%s")).stdout.trim());

async function gone(s: any): Promise<boolean> {
  const user = await root(`id -u ${s.run.user}`);
  const dirs = await root(
    `ls -d ${runIso.shellQuote(s.run.dir)} ${runIso.shellQuote(s.dir)} 2>/dev/null`,
  );
  return user.code !== 0 && dirs.stdout.trim() === "";
}

async function bystander(): Promise<string> {
  return (
    await root(
      `setsid sh -c 'exec sleep 3000' </dev/null >/dev/null 2>&1 & echo $!`,
    )
  ).stdout.trim();
}

async function pause(mode: "full" | "filesystem") {
  const t0 = Date.now();
  await Sandbox.pause(boxId, { mode });
  const paused = Date.now() - t0;
  await sleep(PAUSE_MS);
  const t1 = Date.now();
  sbx = await Sandbox.connect(boxId, { timeoutMs: 30 * 60_000 });
  // The first command after a resume, as the API's next call would be.
  await root("true");
  const resumed = Date.now() - t1;
  return { pauseCallMs: paused, resumeMs: resumed };
}

const STEADY = `key=$(cat "$1"); hello
b=1
while [ $b -le 6 ]; do
  record "$b-a"; record "$b-b"
  if [ $b = 6 ]; then state $b false; else state $b true; fi
  b=$((b + 1)); sleep 1
done`;

try {
  node = (await root("command -v node")).stdout.trim();
  if (!node) throw new Error("no node in the template");
  const prepared = await root(runIso.prepareBoxScript());
  check("box prepared", prepared.stdout.trim() === "", prepared.stdout.trim());

  // ---------------------------------------------------------------------
  // 1. Full (memory) pause.
  // ---------------------------------------------------------------------
  const by1 = await bystander();
  const A = layout();
  const B = layout();
  const startA = await start(A, STEADY, {});
  check("A started", /^ready 1 /.test(marker(startA) ?? ""), marker(startA));
  const startB = await start(B, STEADY, { idleMs: 10_000 });
  check("B started", /^ready 1 /.test(marker(startB) ?? ""), marker(startB));
  const mounts = await root("grep ' /proc ' /proc/mounts");
  check(
    "/proc mounted with hidepid",
    /hidepid=(2|invisible)/.test(mounts.stdout),
    mounts.stdout.trim(),
  );
  check("A batch 1 read", (await batch(A, 1)).includes('"v":"1-a"'));
  // Batch 2 of A, before the pause.
  check(
    "A batch 2 before pause",
    (await wait(A, 2))?.startsWith("ready 2 ") === true,
  );
  // B's last beat, right before the pause.
  check(
    "B batch 2 before pause",
    (await wait(B, 2))?.startsWith("ready 2 ") === true,
  );
  const [wrapperA, startTicksA, bootA] = await recorded(A);
  const before = { boot: await bootId(), clock: await clock() };
  check(
    "recorded boot id is the box's",
    bootA === before.boot.replace(/-/g, ""),
  );

  const full = await pause("full");
  const after = { boot: await bootId(), clock: await clock() };
  report.full = {
    ...full,
    boxClockJumpS: after.clock - before.clock,
    bootIdKept: before.boot === after.boot,
  };
  console.log("full pause", report.full);
  check("full resume keeps the boot", before.boot === after.boot);
  check(
    "A's wrapper is the same process after resume",
    (await alive(wrapperA)) && (await procStart(wrapperA)) === startTicksA,
  );

  // A carries on where it was.
  const seqs: string[] = [];
  for (let seq = 3; seq <= 6; seq++) {
    const m = (await wait(A, seq)) ?? "";
    seqs.push(m);
    if (!m.startsWith("ready")) break;
  }
  check(
    "A serves batches 3 to 6 after resume",
    seqs.length === 4 && seqs.every(m => m.startsWith("ready")),
    seqs.join(" | "),
  );
  check(
    "A's batch 6 is the last",
    (await batch(A, 6)).includes('"hasMore":false'),
  );
  const endA = await wait(A, 7, 6);
  check("A ended done", /^ended done 0 0/.test(endA ?? ""), endA);
  check("A closed", (await close(A)) === "closed 0");
  check("A left nothing", await gone(A));

  // B: 10 s idle and nothing beats it after the pause. Watch it without
  // beating it (a wait would), until it ends itself.
  const t0 = Date.now();
  let endedAfterMs = -1;
  while (Date.now() - t0 < 60_000) {
    const st = await root(
      `S=${runIso.shellQuote(B.dir)}; if [ ! -d "$S" ]; then echo gone; elif [ -f "$S/status" ]; then cat "$S/status"; else echo running; fi`,
    );
    if (st.stdout.trim() !== "running") {
      endedAfterMs = Date.now() - t0;
      (report.full as any).bEnd = st.stdout.trim();
      break;
    }
    await sleep(500);
  }
  (report.full as any).bEndedAfterResumeMs = endedAfterMs;
  check(
    "B ended itself after the pause",
    endedAfterMs >= 0,
    `${(report.full as any).bEnd} after ${endedAfterMs} ms`,
  );
  const endB = (await wait(B, 3, 0)) ?? "";
  check(
    "B reports gone or abandoned",
    /^gone$|^ended abandoned/.test(endB),
    endB,
  );
  check("B closed", (await close(B)) === "closed 0");
  check("B left nothing", await gone(B));
  check("bystander 1 alive after full pause", await alive(by1));
  await root(`kill -9 ${by1}`);

  // ---------------------------------------------------------------------
  // 2. Filesystem-only pause: the box boots again.
  // ---------------------------------------------------------------------
  const C = layout();
  const startC = await start(C, STEADY, {});
  check("C started", /^ready 1 /.test(marker(startC) ?? ""), marker(startC));
  const [wrapperC] = await recorded(C);
  const bootBefore = await bootId();
  const fsPause = await pause("filesystem");
  const bootAfter = await bootId();
  report.filesystem = { ...fsPause, bootIdChanged: bootBefore !== bootAfter };
  console.log("filesystem pause", report.filesystem);
  check("filesystem resume boots again", bootBefore !== bootAfter);
  const mounts2 = await root("grep ' /proc ' /proc/mounts");
  report.filesystem = {
    ...(report.filesystem as object),
    hidepidAfterBootBeforeNextStart: /hidepid/.test(mounts2.stdout),
  };
  check(
    "C's run user and run directory survived the reboot on disk",
    !(await gone(C)),
  );
  // A live process with C's wrapper pid, as a reboot reuses pids. Take a
  // bystander and point C's record at it with its real start time: only
  // the boot id differs, as it would.
  const by2 = await bystander();
  const by2Start = await procStart(by2);
  const naturalReuse = await alive(wrapperC);
  report.filesystem = {
    ...(report.filesystem as object),
    wrapperPidInUseAfterBoot: naturalReuse,
  };
  await root(
    `printf '%s %s %s\\n' ${by2} ${by2Start} ${bootBefore.replace(/-/g, "")} > ${runIso.shellQuote(`${C.dir}/supervisor.pid`)} && touch -d @1 ${runIso.shellQuote(`${C.dir}/heartbeat`)}`,
  );
  const wrapperCAliveBefore = naturalReuse;
  const wrapperCStartBefore = naturalReuse ? await procStart(wrapperC) : "";
  // The next start reaps C (its heartbeat is old) and must not kill the
  // bystander, nor whatever now holds C's old wrapper pid.
  const D = layout();
  const startD = await start(D, `hello; record d; state 1 false`, {
    idleMs: 2_000,
  });
  check("D started", /^ready 1 /.test(marker(startD) ?? ""), marker(startD));
  check("C reaped: user and run directory gone", await gone(C));
  check("bystander 2 alive after the reap", await alive(by2));
  if (wrapperCAliveBefore) {
    check(
      "the process now holding C's old wrapper pid is alive",
      (await alive(wrapperC)) &&
        (await procStart(wrapperC)) === wrapperCStartBefore,
    );
  }
  check("D closed", (await close(D)) === "closed 0");
  check("D left nothing", await gone(D));
  const mounts3 = await root("grep ' /proc ' /proc/mounts");
  check(
    "hidepid back on after the next start",
    /hidepid=(2|invisible)/.test(mounts3.stdout),
  );
  const users = await root("getent passwd | grep -c '^mkc' || true");
  check(
    "no run user left in the box",
    users.stdout.trim() === "0",
    users.stdout.trim(),
  );
  await root(`kill -9 ${by2}`);
} finally {
  try {
    await Sandbox.kill(boxId);
    console.log(`killed ${boxId}`);
  } catch (error) {
    console.error(`could not kill ${boxId}: ${String(error)}`);
  }
  report.checks = checks;
  report.passed = checks.filter(c => c.ok).length;
  report.failed = checks.filter(c => !c.ok).length;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.passed} passed, ${report.failed} failed -> ${OUT}`);
}
