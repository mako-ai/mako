/**
 * Read sessions (session-isolation.ts) against a real Linux box: E2B's own
 * `e2bdev/base` image (Debian 12) in local Docker. No E2B account.
 *
 * Gated like run-isolation.docker.test.ts: runs with RUN_DB_INTEGRATION=1 or
 * RUN_CONNECTOR_ISOLATION_DOCKER=1.
 *
 *   RUN_CONNECTOR_ISOLATION_DOCKER=1 pnpm --filter api exec vitest run \
 *     --config vitest.destinations.config.ts src/connectors/workspace/session-isolation.docker.test.ts
 *
 * Each case drives the scripts the API sends to E2B, verbatim. A "connector"
 * is a shell command run as the run user where node would run; it speaks
 * the session protocol (a hello, then batches ending in STATE). The
 * supervisor is the real one, on the image's Node.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ISOLATED_INCOMING,
  ISOLATED_RUNS,
  incomingPath,
  prepareBoxScript,
  runLayout,
  shellQuote,
} from "./run-isolation";
import {
  ISOLATED_SESSIONS,
  ackScript,
  batchPath,
  closeScript,
  sessionLayout,
  startScript,
  waitScript,
  type SessionLayout,
  type SessionLimits,
} from "./session-isolation";

const run = promisify(execFile);
const ENABLED =
  process.env.RUN_DB_INTEGRATION === "1" ||
  process.env.RUN_CONNECTOR_ISOLATION_DOCKER === "1";
const suite = ENABLED ? describe : describe.skip;
const IMAGE = process.env.CONNECTOR_ISOLATION_IMAGE ?? "e2bdev/base:latest";

let container = "";
let node = "";

interface Sh {
  code: number;
  stdout: string;
  stderr: string;
}

async function root(script: string, timeoutMs = 60_000): Promise<Sh> {
  try {
    const { stdout, stderr } = await run(
      "docker",
      ["exec", container, "sh", "-c", script],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const LIMITS: SessionLimits = {
  maxBytes: 4 * 1024 * 1024,
  maxMessages: 50_000,
  buffer: 2,
  idleMs: 60_000,
  maxAgeMs: 10 * 60_000,
};

let counter = 0;
function layout(): SessionLayout {
  counter++;
  return sessionLayout(
    runLayout(
      randomBytes(8).toString("hex"),
      `mkc${randomBytes(6).toString("hex")}`,
      400_000 + counter * 1_000 + Math.floor(Math.random() * 900),
      600_000 + counter * 1_000 + Math.floor(Math.random() * 900),
    ),
  );
}

/** The protocol helpers a shell connector prints with. */
const PRELUDE = `hello() { echo '{"type":"MAKO_SESSION","session":{"version":1}}'; }
record() { printf '{"type":"RECORD","record":{"stream":"s","data":{"v":"%s"}}}\\n' "$1"; }
state() { printf '{"type":"STATE","state":{"type":"STREAM","stream":{"stream_descriptor":{"name":"s"},"stream_state":{"n":%s}},"mako":{"hasMore":%s}}}\\n' "$1" "$2"; }
`;

/** Start a session whose connector is `snippet`, with `secret` as its config. */
async function start(
  s: SessionLayout,
  snippet: string,
  options: {
    secret?: string;
    limits?: Partial<SessionLimits>;
    waitMs?: number;
  } = {},
): Promise<Sh> {
  const config = `${s.run.dir}/config.json`;
  const secret = options.secret ?? `sk_${randomBytes(8).toString("hex")}`;
  // The API's one write: the input into the root-only inbox, default mode.
  const write = await root(
    `umask 022; mkdir -p ${shellQuote(`${ISOLATED_INCOMING}/${s.id}`)} && printf %s ${shellQuote(secret)} > ${shellQuote(incomingPath(s.id, "config.json"))}`,
  );
  expect(write.code, write.stderr).toBe(0);
  const command = `sh -c ${shellQuote(`${PRELUDE}\n${snippet}`)} connector ${shellQuote(config)}`;
  return root(
    startScript({
      layout: s,
      inputs: [config],
      command,
      node,
      limits: { ...LIMITS, ...options.limits },
      waitMs: options.waitMs ?? 20_000,
    }),
  );
}

const marker = (sh: Sh) =>
  sh.stdout
    .split("\n")
    .filter(line => line.startsWith("MAKO_SESSION "))
    .at(-1)
    ?.slice("MAKO_SESSION ".length);

const wait = async (s: SessionLayout, seq: number, ack = seq - 1) =>
  marker(await root(waitScript(s.id, seq, ack, 20_000)));

const batch = async (s: SessionLayout, seq: number) =>
  (await root(`cat ${shellQuote(batchPath(s.id, seq))}`)).stdout;

/** Live threads (not zombies) of a uid, from /proc, as the cleanup reads them. */
async function liveThreads(uid: number): Promise<number> {
  const res = await root(
    `printf '%s\\n' /proc/[0-9]*/task/[0-9]*/status | xargs cat 2>/dev/null | awk -v n=${uid} '/^State:/ { st = $2 } /^Uid:/ { if (st != "Z" && st != "X") for (i = 2; i <= 5; i++) if ($i == n) { c++; break } } END { print c + 0 }'`,
  );
  return Number(res.stdout.trim());
}

/** Everything a finished run must not leave: user, dirs, threads, files. */
async function expectGone(s: SessionLayout) {
  expect((await root(`id -u ${s.run.user}`)).code).not.toBe(0);
  expect(
    (
      await root(
        `ls -d ${shellQuote(s.run.dir)} ${shellQuote(s.dir)} ${shellQuote(`${ISOLATED_INCOMING}/${s.id}`)} 2>/dev/null`,
      )
    ).stdout,
  ).toBe("");
  expect(await liveThreads(s.run.uid)).toBe(0);
  expect(
    (
      await root(
        `find /tmp /var/tmp /dev/shm -xdev -uid ${s.run.uid} 2>/dev/null`,
      )
    ).stdout,
  ).toBe("");
}

async function until(check: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(200);
  }
  return false;
}

beforeAll(async () => {
  if (!ENABLED) return;
  const { stdout } = await run("docker", [
    "run",
    "-d",
    "--rm",
    "--init",
    IMAGE,
    "sleep",
    "infinity",
  ]);
  container = stdout.trim();
  await root("id user >/dev/null 2>&1 || useradd -m -s /bin/bash user");
  node = (await root("command -v node")).stdout.trim();
  const prepared = await root(prepareBoxScript());
  expect(prepared.stdout.trim()).toBe("");
}, 180_000);

afterAll(async () => {
  if (container) await run("docker", ["rm", "-f", container]).catch(() => {});
});

suite("connector read sessions in e2bdev/base (Docker)", () => {
  it("serves batches in order, holds the connector back, and drops the credential once read", async () => {
    // An account with an empty password, as E2B's template ships root.
    await root("useradd -M ghost 2>/dev/null; passwd -d ghost >/dev/null");
    const s = layout();
    const secret = `sk_${randomBytes(8).toString("hex")}`;
    // Five batches of about 140 KB: far more than a pipe holds, so a
    // connector that is not held back would finish at once.
    const started = await start(
      s,
      `key=$(cat "$1"); hello
for b in 1 2 3 4 5; do
  i=0; while [ $i -lt 2000 ]; do record "$b-$i-padding-padding-padding-padding"; i=$((i + 1)); done
  [ $b = 1 ] && record "$key"
  if [ $b = 5 ]; then state $b false; else state $b true; fi
done
touch "$HOME/finished"`,
      { secret, limits: { buffer: 1 } },
    );
    expect(marker(started), started.stderr).toMatch(/^ready 1 \d+$/);
    expect(
      (
        await root("awk -F: '$1 == \"ghost\" { print $2 }' /etc/shadow")
      ).stdout.trim(),
    ).toBe("!");

    // The credential was deleted the moment the runner said it had read it.
    expect(
      (await root(`ls ${shellQuote(s.run.dir)}`)).stdout.split("\n"),
    ).not.toContain("config.json");
    // Held back: one batch waits, the connector is blocked writing batch 2.
    await sleep(500);
    expect(
      (await root(`ls ${shellQuote(s.batches)} | grep -c jsonl`)).stdout.trim(),
    ).toBe("1");
    expect(
      (
        await root(
          `test -e ${shellQuote(`${s.run.home}/finished`)} && echo yes`,
        )
      ).stdout,
    ).toBe("");

    const first = await batch(s, 1);
    expect(first).toContain(secret);
    expect(first.trim().split("\n").at(-1)).toContain('"n":1');
    for (let seq = 2; seq <= 5; seq++) {
      expect(await wait(s, seq)).toMatch(new RegExp(`^ready ${seq} `));
      const body = await batch(s, seq);
      expect(body.trim().split("\n").at(-1)).toContain(`"n":${seq}`);
      expect(body.split("\n").filter(Boolean)).toHaveLength(2001);
      // Batch seq - 1 was acknowledged by this wait, and is gone.
      expect(
        (
          await root(
            `test -e ${shellQuote(batchPath(s.id, seq - 1))} && echo yes`,
          )
        ).stdout,
      ).toBe("");
    }
    expect(await wait(s, 6, 5)).toMatch(/^ended done 0 0 none$/);
    expect(marker(await root(closeScript(s.id)))).toBe("closed 0");
    await expectGone(s);
  }, 120_000);

  it("closes a session the API stopped reading early, without waiting out the backpressure", async () => {
    const s = layout();
    // An endless source, held back after one batch.
    const started = await start(
      s,
      `hello; b=1
while :; do
  i=0; while [ $i -lt 2000 ]; do record "$b-$i-padding-padding-padding-padding"; i=$((i + 1)); done
  state $b true; b=$((b + 1))
done`,
      { limits: { buffer: 1 } },
    );
    expect(marker(started), started.stderr).toMatch(/^ready 1 /);
    const t0 = Date.now();
    expect(marker(await root(closeScript(s.id)))).toBe("closed 0");
    expect(Date.now() - t0).toBeLessThan(5_000);
    await expectGone(s);
  }, 60_000);

  it("keeps a concurrent run out of the session's credential, batches and process", async () => {
    const victim = layout();
    const secret = `sk_victim_${randomBytes(8).toString("hex")}`;
    // The victim keeps its key in a live process's environment and memory,
    // as a connector holds its credential between batches.
    const started = await start(
      victim,
      `key=$(cat "$1"); hello; record "$key"; state 1 true
env MAKO_KEY="$key" sleep 30 &
wait`,
      { secret },
    );
    expect(marker(started), started.stderr).toMatch(/^ready 1 /);
    const sleeper = (
      await root(
        `for p in /proc/[0-9]*; do awk -v n=${victim.run.uid} '/^Uid:/ && $2 == n { found = 1 } END { exit !found }' $p/status 2>/dev/null && grep -q sleep $p/cmdline 2>/dev/null && echo \${p#/proc/}; done`,
      )
    ).stdout
      .trim()
      .split("\n")[0];
    expect(sleeper).toMatch(/^\d+$/);

    const thief = layout();
    const probes = [
      `cat ${shellQuote(`${victim.run.dir}/config.json`)} && echo READ-CONFIG`,
      `ls ${shellQuote(victim.run.dir)} && echo LIST-RUN`,
      `ls ${shellQuote(ISOLATED_SESSIONS)} && echo LIST-SESSIONS`,
      `cat ${shellQuote(batchPath(victim.id, 1))} && echo READ-BATCH`,
      `cat /proc/${sleeper}/environ && echo READ-ENVIRON`,
      `head -c 100000 /proc/${sleeper}/mem && echo READ-MEM`,
      `ls /proc/${sleeper}/fd && echo LIST-FD`,
      `kill -9 ${sleeper} && echo KILLED`,
      `su -c id root </dev/null && echo SU-ROOT`,
      `su -c id ghost </dev/null && echo SU-GHOST`,
    ];
    const stolen = await start(
      thief,
      `hello; { ${probes.join("; ")}; } 2>&1 | while IFS= read -r line; do record "$line"; done; state 1 false`,
    );
    expect(marker(stolen), stolen.stderr).toMatch(/^ready 1 /);
    const loot = await batch(thief, 1);
    expect(loot).not.toContain(secret);
    expect(loot).not.toMatch(
      /READ-CONFIG|LIST-RUN|LIST-SESSIONS|READ-BATCH|READ-ENVIRON|READ-MEM|LIST-FD|KILLED|SU-ROOT|SU-GHOST/,
    );
    // The victim is untouched and still serving.
    expect(await liveThreads(victim.run.uid)).toBeGreaterThan(0);
    expect(await batch(victim, 1)).toContain(secret);

    for (const s of [victim, thief]) {
      expect(marker(await root(closeScript(s.id)))).toBe("closed 0");
      await expectGone(s);
    }
  }, 120_000);

  it("leaves nothing of the run behind when the read ends", async () => {
    const s = layout();
    const started = await start(
      s,
      `hello
setsid sh -c 'exec sleep 600' </dev/null >/dev/null 2>&1 &
nohup sh -c 'trap "" TERM HUP; sleep 600' </dev/null >/dev/null 2>&1 &
echo left > /tmp/left-by-run; echo left > /dev/shm/left-by-run
record a; state 1 false`,
    );
    expect(marker(started), started.stderr).toMatch(/^ready 1 /);
    // The read is over: the wrapper's cleanup runs without being asked.
    expect(await wait(s, 2, 1)).toBe("ended done 0 0 none");
    expect(await liveThreads(s.run.uid)).toBe(0);
    expect((await root(`id -u ${s.run.user}`)).code).not.toBe(0);
    expect(marker(await root(closeScript(s.id)))).toBe("closed 0");
    await expectGone(s);
  }, 60_000);

  it("cleans up after an API that died mid-read: the session's own watchdog", async () => {
    const s = layout();
    const started = await start(
      s,
      `key=$(cat "$1"); hello; record a; state 1 true
env MAKO_KEY="$key" sleep 600`,
      { limits: { idleMs: 1_500 } },
    );
    expect(marker(started), started.stderr).toMatch(/^ready 1 /);
    // The API is gone: nothing acknowledges, nothing waits.
    expect(
      await until(
        async () => (await root(`id -u ${s.run.user}`)).code !== 0,
        15_000,
      ),
    ).toBe(true);
    await expectGone(s);
  }, 60_000);

  it("reaps a session whose supervisor died, at the next start in the box", async () => {
    const s = layout();
    const started = await start(
      s,
      `key=$(cat "$1"); hello; record a; state 1 true
env MAKO_KEY="$key" sleep 600`,
      { limits: { idleMs: 1_000 } },
    );
    expect(marker(started), started.stderr).toMatch(/^ready 1 /);
    // The supervisor and its wrapper die (OOM, say); the connector lives on.
    const killed = await root(
      `for p in /proc/[0-9]*; do
  [ "\${p#/proc/}" = "$$" ] && continue
  if grep -qa -e session-supervisor -e ${shellQuote(`${s.dir}/run.sh`)} $p/cmdline 2>/dev/null; then kill -9 \${p#/proc/}; fi
done`,
    );
    expect(killed.code).toBe(0);
    await sleep(300);
    expect(await liveThreads(s.run.uid)).toBeGreaterThan(0);
    await root(`touch -d @1 ${shellQuote(`${s.dir}/heartbeat`)}`);

    const next = layout();
    const nextStart = await start(next, `hello; record b; state 1 false`, {
      limits: { idleMs: 1_000 },
    });
    expect(marker(nextStart), nextStart.stderr).toMatch(/^ready 1 /);
    await expectGone(s);
    expect(marker(await root(closeScript(next.id)))).toBe("closed 0");
    await expectGone(next);
  }, 60_000);

  it("never reaps a session another start is still creating", async () => {
    // A session directory caught between its creation and its first beat.
    const creating = `${ISOLATED_SESSIONS}/ffffffffffffffff`;
    await root(`mkdir -p ${shellQuote(creating)}/batches`);
    const s = layout();
    const out = await start(s, `hello; record a; state 1 false`, {
      limits: { idleMs: 1_000 },
    });
    expect(marker(out), out.stderr).toMatch(/^ready 1 /);
    expect(
      (await root(`test -d ${shellQuote(creating)} && echo yes`)).stdout.trim(),
    ).toBe("yes");
    await root(`rm -rf ${shellQuote(creating)}`);
    expect(marker(await root(closeScript(s.id)))).toBe("closed 0");
    await expectGone(s);
  }, 60_000);

  it("ends a session at its deadline, and its complete batches stay readable", async () => {
    const s = layout();
    const started = await start(
      s,
      `hello; record a; state 1 true
sleep 600`,
      { limits: { maxAgeMs: 2_000 } },
    );
    expect(marker(started), started.stderr).toMatch(/^ready 1 /);
    expect(
      await until(
        async () => (await root(`id -u ${s.run.user}`)).code !== 0,
        15_000,
      ),
    ).toBe(true);
    expect(await batch(s, 1)).toContain('"v":"a"');
    expect(await wait(s, 2, 0)).toMatch(/^ended deadline 137 0 none$/);
    expect(marker(await root(closeScript(s.id)))).toBe("closed 0");
    await expectGone(s);
  }, 60_000);

  it("refuses a runner that ignores --session, and a batch over the cap", async () => {
    const old = layout();
    const refused = await start(old, `record a; state 1 false; sleep 600`);
    expect(marker(refused)).toMatch(/^ended unsupported \d+ 0 none$/);
    expect(marker(await root(closeScript(old.id)))).toBe("closed 0");
    await expectGone(old);

    const big = layout();
    const capped = await start(
      big,
      `hello; record "$(head -c 3000 /dev/zero | tr '\\0' x)"; state 1 false; sleep 600`,
      { limits: { maxBytes: 2_000 } },
    );
    expect(marker(capped)).toMatch(/^ended too-large-bytes \d+ 0 none$/);
    expect(marker(await root(closeScript(big.id)))).toBe("closed 0");
    await expectGone(big);
  }, 60_000);

  it("reports a failed read with its TRACE and exit code, and a close ends a live session", async () => {
    const failed = layout();
    const out = await start(
      failed,
      `hello; record a; state 1 true
echo '{"type":"TRACE","trace":{"type":"ERROR","error":{"message":"401 revoked"}}}'
echo boom >&2; exit 3`,
    );
    expect(marker(out)).toMatch(/^ready 1 /);
    const ended = await root(waitScript(failed.id, 2, 1, 20_000));
    expect(marker(ended)).toMatch(/^ended done 3 0 \d+$/);
    expect(ended.stderr).toContain("boom");
    expect(
      (await root(`cat ${shellQuote(`${failed.batches}/2.tail`)}`)).stdout,
    ).toContain("401 revoked");
    expect(marker(await root(closeScript(failed.id)))).toBe("closed 0");
    await expectGone(failed);

    const live = layout();
    const liveStart = await start(
      live,
      `key=$(cat "$1"); hello; record a; state 1 true
env MAKO_KEY="$key" sleep 600`,
    );
    expect(marker(liveStart)).toMatch(/^ready 1 /);
    await root(ackScript(live.id, 1));
    expect(marker(await root(closeScript(live.id)))).toBe("closed 0");
    await expectGone(live);
    // And the runs directory holds nothing of either.
    expect((await root(`ls ${shellQuote(ISOLATED_RUNS)}`)).stdout).not.toMatch(
      new RegExp(`${failed.id}|${live.id}`),
    );
  }, 60_000);
});
