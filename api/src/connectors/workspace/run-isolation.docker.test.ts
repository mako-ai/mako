/**
 * The per-run isolation scripts (run-isolation.ts) against a real Linux box:
 * E2B's own `e2bdev/base` image (Debian 12) in local Docker. No E2B account.
 *
 * Gated like the other Docker suites: runs only with RUN_DB_INTEGRATION=1
 * (the nightly destination-integration workflow sets it and has Docker).
 *
 *   RUN_DB_INTEGRATION=1 pnpm --filter api exec vitest run \
 *     --config vitest.destinations.config.ts src/connectors/workspace/run-isolation.docker.test.ts
 *
 * Each case drives the scripts the API sends to E2B, verbatim. A "connector"
 * here is a shell command run through `launchScript`, exactly where node
 * would run, as the run user.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHUNK_MARKER,
  INPUTS_MISSING_EXIT,
  ISOLATED_INCOMING,
  ISOLATED_RUNS,
  chunkScript,
  cleanupScript,
  incomingPath,
  prepareBoxScript,
  resultPath,
  launchScript,
  runLayout,
  setupScript,
  shellQuote,
  snapshotScript,
  stagedPath,
  type RunLayout,
} from "./run-isolation";

const run = promisify(execFile);
// Nightly (RUN_DB_INTEGRATION) and on every PR (the api-contract workflow's
// "Connector run isolation (Docker)" step sets RUN_CONNECTOR_ISOLATION_DOCKER).
const ENABLED =
  process.env.RUN_DB_INTEGRATION === "1" ||
  process.env.RUN_CONNECTOR_ISOLATION_DOCKER === "1";
const suite = ENABLED ? describe : describe.skip;
const IMAGE = process.env.CONNECTOR_ISOLATION_IMAGE ?? "e2bdev/base:latest";

let container = "";

interface Sh {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a script in the container as root (the API's `asRoot`). */
async function root(script: string, timeoutMs = 60_000): Promise<Sh> {
  try {
    const { stdout, stderr } = await run(
      "docker",
      ["exec", container, "sh", "-c", script],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
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

let counter = 0;
async function open(): Promise<RunLayout> {
  counter++;
  const layout = runLayout(
    randomBytes(8).toString("hex"),
    `mkc${randomBytes(6).toString("hex")}`,
    300_000 + counter * 1_000 + Math.floor(Math.random() * 900),
    500_000 + counter * 1_000 + Math.floor(Math.random() * 900),
  );
  const setup = await root(setupScript(layout));
  expect(setup, setup.stderr).toMatchObject({ code: 0 });
  return layout;
}

/**
 * Write an input as root, the way `writeFile(..., { asRoot: true })` does:
 * into the stage, with the default 0644 mode. Returns its final path.
 */
async function writeInput(l: RunLayout, name: string, body: string) {
  const file = `${l.dir}/${name}`;
  const res = await root(
    `umask 022; printf %s ${shellQuote(body)} > ${shellQuote(stagedPath(l, file))}`,
  );
  expect(res.code).toBe(0);
  return file;
}

/** Run `connector` (a shell snippet) as the run user via launchScript. */
function connector(l: RunLayout, inputs: string[], snippet: string) {
  return root(launchScript(l, inputs, `sh -c ${shellQuote(snippet)}`));
}

async function bounded(l: RunLayout): Promise<string> {
  const snap = await root(snapshotScript(l, 1024 * 1024));
  expect(snap.code).toBe(0);
  if (snap.stdout.trim() === "missing") return "";
  return (await root(`cat ${shellQuote(l.boundedFile)}`)).stdout;
}

beforeAll(async () => {
  if (!ENABLED) return;
  const { stdout } = await run("docker", [
    "run",
    "-d",
    "--rm",
    // E2B boxes have a real init that reaps orphans; so does this one.
    "--init",
    IMAGE,
    "sleep",
    "infinity",
  ]);
  container = stdout.trim();
  // E2B's template user, as in a real box.
  await root("id user >/dev/null 2>&1 || useradd -m -s /bin/bash user");
}, 180_000);

afterAll(async () => {
  if (container) await run("docker", ["rm", "-f", container]).catch(() => {});
});

suite("connector run isolation in e2bdev/base (Docker)", () => {
  it("keeps two concurrent runs out of each other's inputs", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    const secretA = `sk_a_${randomBytes(8).toString("hex")}`;
    const secretB = `sk_b_${randomBytes(8).toString("hex")}`;
    const fileA = await writeInput(a, "config.json", secretA);
    const fileB = await writeInput(b, "config.json", secretB);

    const probe = (other: RunLayout, file: string) =>
      [
        `cat ${shellQuote(file)} && echo READ-OK`,
        `ls ${shellQuote(other.dir)} && echo LIST-OK`,
        `ls ${shellQuote(ISOLATED_RUNS)} && echo LISTALL-OK`,
        `cat ${shellQuote(`${other.dir}/out/out.jsonl`)} && echo OUT-OK`,
        "true",
      ].join("; ");
    // Both run at once, each trying everything against the other.
    await Promise.all([
      connector(a, [fileA], `cat ${shellQuote(fileA)}; ${probe(b, fileB)}`),
      connector(b, [fileB], `cat ${shellQuote(fileB)}; ${probe(a, fileA)}`),
    ]);
    const [outA, outB] = await Promise.all([bounded(a), bounded(b)]);

    expect(outA).toContain(secretA);
    expect(outB).toContain(secretB);
    expect(outA).not.toContain(secretB);
    expect(outB).not.toContain(secretA);
    for (const out of [outA, outB]) {
      expect(out).not.toMatch(/READ-OK|LIST-OK|LISTALL-OK|OUT-OK/);
    }
    expect((await root(cleanupScript(a))).code).toBe(0);
    expect((await root(cleanupScript(b))).code).toBe(0);
  }, 120_000);

  it("never lets root write through a symlink the run user plants", async () => {
    const l = await open();
    // A file root owns that a hostile connector wants overwritten.
    await root("printf original > /root/victim && chmod 0644 /root/victim");
    const hostile = [
      // Every path root later opens, replaced by a symlink to the victim.
      `ln -sf /root/victim ${shellQuote(l.outputFile)} && echo PLANT-OUT`,
      `ln -sf /root/victim ${shellQuote(l.boundedFile)} && echo PLANT-BOUNDED`,
      `rm -rf ${shellQuote(`${l.dir}/out`)} && echo REMOVED-OUT`,
      `ln -sf /root/victim ${shellQuote(`${l.dir}/out`)} && echo PLANT-DIR`,
      `echo '{"type":"STATE","state":{}}'`,
    ].join("; ");
    await connector(l, [], hostile);
    const out = await bounded(l);

    expect(out).toContain('"type":"STATE"');
    expect(out).not.toMatch(/PLANT-|REMOVED-OUT/);
    expect((await root("cat /root/victim")).stdout).toBe("original");
    expect(
      (await root(`test -L ${shellQuote(l.boundedFile)} && echo LINK`)).stdout,
    ).toBe("");
    expect((await root(cleanupScript(l))).code).toBe(0);
  }, 60_000);

  it("never lets a symlink turn the output read into another run's credential", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    const secretB = `sk_b_${randomBytes(8).toString("hex")}`;
    const fileB = await writeInput(b, "config.json", secretB);
    await root(launchScript(b, [fileB], "true"));
    // A tries to point its own output at B's config.
    await connector(
      a,
      [],
      `ln -sf ${shellQuote(fileB)} ${shellQuote(a.outputFile)}; ln -sf ${shellQuote(fileB)} ${shellQuote(`${a.home}/out.jsonl`)}; echo done`,
    );
    const out = await bounded(a);
    expect(out).not.toContain(secretB);
    expect(out).toContain("done");
    await root(cleanupScript(a));
    await root(cleanupScript(b));
  }, 60_000);

  it("kills a fork-hopping process and removes every trace of the run", async () => {
    const l = await open();
    // Detached, re-forking every 10 ms, writing into every shared dir, and
    // holding a SysV message queue and a POSIX shm file.
    await connector(
      l,
      [],
      [
        "touch /tmp/mkc-left /var/tmp/mkc-left /dev/shm/mkc-left /run/lock/mkc-left",
        "ipcmk -Q >/dev/null 2>&1 || true",
        "nohup sh -c 'while :; do sh -c \"sleep 30 & exit 0\"; sleep 0.01; done' >/dev/null 2>&1 &",
        "nohup sh -c 'while :; do sleep 1; done' >/dev/null 2>&1 &",
        "echo started",
      ].join("\n"),
    );
    await new Promise(resolve => setTimeout(resolve, 500));
    const before = await root(`ps -o pid= -u ${l.uid} | wc -l`);
    expect(Number(before.stdout.trim())).toBeGreaterThan(0);

    const cleanup = await root(cleanupScript(l));
    expect(cleanup, cleanup.stderr).toMatchObject({ code: 0 });

    const after = await root(
      `ps -o pid= -u ${l.uid} | wc -l; find /tmp /var/tmp /dev/shm /run/lock -uid ${l.uid} | wc -l; awk -v n=${l.uid} 'NR > 1 && $8 == n' /proc/sysvipc/msg | wc -l; id ${shellQuote(l.user)} >/dev/null 2>&1 && echo USER-LEFT; test -e ${shellQuote(l.dir)} && echo DIR-LEFT; true`,
    );
    expect(
      after.stdout
        .split("\n")
        .slice(0, 3)
        .map(s => s.trim()),
    ).toEqual(["0", "0", "0"]);
    expect(after.stdout).not.toMatch(/USER-LEFT|DIR-LEFT/);
  }, 60_000);

  it("cleans up without pkill or pgrep installed", async () => {
    await root("rm -f /usr/bin/pkill /usr/bin/pgrep");
    const l = await open();
    await connector(l, [], "nohup sleep 300 >/dev/null 2>&1 & echo ok");
    const cleanup = await root(cleanupScript(l));
    expect(cleanup, cleanup.stderr).toMatchObject({ code: 0 });
    expect((await root(`ps -o pid= -u ${l.uid} | wc -l`)).stdout.trim()).toBe(
      "0",
    );
  }, 60_000);

  const liveThreads = async (uid: number) =>
    Number(
      (
        await root(
          `cat /proc/[0-9]*/task/[0-9]*/status 2>/dev/null | awk -v n=${uid} '/^State:/{st=$2} /^Uid:/{if(st!="Z"&&$2==n)c++} END{print c+0}'`,
        )
      ).stdout.trim(),
    );

  it("kills a process whose main thread called pthread_exit (state Z, threads alive)", async () => {
    const l = await open();
    await connector(
      l,
      [],
      [
        "nohup python3 -c '",
        "import threading, time, ctypes",
        "threading.Thread(target=lambda: time.sleep(600)).start()",
        "time.sleep(0.2)",
        "ctypes.CDLL(None).pthread_exit(None)' >/dev/null 2>&1 &",
        "sleep 0.8; echo started",
      ].join("\n"),
    );
    expect(await liveThreads(l.uid)).toBeGreaterThan(0);

    const cleanup = await root(cleanupScript(l));
    expect(cleanup, cleanup.stderr).toMatchObject({ code: 0 });
    expect(await liveThreads(l.uid)).toBe(0);
  }, 60_000);

  it("kills a non-dumpable process, whose /proc entry root owns", async () => {
    const l = await open();
    await connector(
      l,
      [],
      "nohup python3 -c 'import ctypes, time; ctypes.CDLL(None).prctl(4, 0, 0, 0, 0); time.sleep(600)' >/dev/null 2>&1 &\nsleep 0.5; echo started",
    );
    expect(await liveThreads(l.uid)).toBeGreaterThan(0);
    const cleanup = await root(cleanupScript(l));
    expect(cleanup, cleanup.stderr).toMatchObject({ code: 0 });
    expect(await liveThreads(l.uid)).toBe(0);
  }, 60_000);

  it("removes the credential and fails when a survivor cannot be killed, and the survivor cannot read the next run", async () => {
    const thief = await open();
    // The survivor scans every process's --config and tries to read it.
    const thiefCode = [
      "import glob, time",
      "while True:",
      "    for c in glob.glob('/proc/[0-9]*/cmdline'):",
      "        try:",
      "            a = open(c, 'rb').read().split(bytes(1))",
      "            if b'--config' in a:",
      "                p = a[a.index(b'--config') + 1].decode()",
      "                open('/tmp/stolen', 'a').write(p + ' => ' + open(p).read() + chr(10))",
      "        except Exception:",
      "            pass",
      "    time.sleep(0.02)",
    ].join("\n");
    await root(
      `printf '%s' ${shellQuote(thiefCode)} > /opt/thief.py && chmod 0644 /opt/thief.py`,
    );
    await connector(
      thief,
      [],
      "nohup python3 /opt/thief.py >/dev/null 2>&1 &\necho started",
    );
    const config = await writeInput(thief, "config.json", "sk_thief_own");
    expect(await liveThreads(thief.uid)).toBeGreaterThan(0);
    // Make the kill fail: a runuser that ignores `kill` (the script's PATH
    // puts /usr/local/sbin first). Everything else still runs.
    await root(
      `printf '%s\\n' '#!/bin/sh' 'case "$*" in *kill*) exit 0;; esac' 'exec /usr/sbin/runuser "$@"' > /usr/local/sbin/runuser && chmod 0755 /usr/local/sbin/runuser`,
    );
    let cleanup: Sh;
    try {
      cleanup = await root(cleanupScript(thief), 120_000);
    } finally {
      await root("rm -f /usr/local/sbin/runuser");
    }
    // Fails closed, but the run's directory and credential are gone anyway.
    expect(cleanup.code).toBe(3);
    expect(cleanup.stderr).toContain("survived");
    expect(
      (await root(`test -e ${shellQuote(config)} || echo GONE`)).stdout,
    ).toContain("GONE");
    expect(
      (await root(`test -e ${shellQuote(thief.dir)} || echo GONE`)).stdout,
    ).toContain("GONE");
    expect(await liveThreads(thief.uid)).toBeGreaterThan(0);

    // The next run, with the survivor still alive: a different random uid
    // and gid, and an input only the new run user can read.
    const next = await open();
    expect(next.gid).not.toBe(thief.gid);
    const secret = `sk_next_${randomBytes(8).toString("hex")}`;
    const file = await writeInput(next, "config.json", secret);
    await root(
      launchScript(
        next,
        [file],
        `sh -c 'sleep 2' connector --config ${shellQuote(file)}`,
      ),
    );
    const stolen = await root("cat /tmp/stolen 2>/dev/null; true");
    expect(stolen.stdout).not.toContain(secret);

    await root(`runuser -u ${shellQuote(thief.user)} -- kill -9 -1; true`);
    expect((await root(cleanupScript(next))).code).toBe(0);
  }, 180_000);

  it("lets no concurrent run read an input in the gap between the write and the launch", async () => {
    // A watcher run, alive the whole time, polls every 5 ms: every path any
    // process names after --config, every file under the runs directory it
    // can list, and the victim's stage and final paths directly.
    const watcher = await open();
    const victim = await open();
    const watchCode = [
      "import glob, time, os",
      `victim = ${JSON.stringify(victim.dir)}`,
      "end = time.time() + 6",
      "hits = open(os.environ['HOME'] + '/hits', 'a')",
      "while time.time() < end:",
      "    paths = [victim + '/config.json', victim + '/stage/config.json']",
      "    paths += glob.glob('/var/lib/mako-connectors/runs/*/*.json')",
      "    paths += glob.glob('/var/lib/mako-connectors/runs/*/stage/*')",
      "    for c in glob.glob('/proc/[0-9]*/cmdline'):",
      "        try:",
      "            a = open(c, 'rb').read().split(bytes(1))",
      "            if b'--config' in a: paths.append(a[a.index(b'--config') + 1].decode())",
      "        except Exception: pass",
      "    for p in paths:",
      "        try:",
      "            hits.write(p + ' => ' + open(p).read() + chr(10)); hits.flush()",
      "        except Exception: pass",
      "    time.sleep(0.005)",
    ].join("\n");
    await root(
      `printf '%s' ${shellQuote(watchCode)} > /opt/watch.py && chmod 0644 /opt/watch.py`,
    );
    const watching = connector(watcher, [], "python3 /opt/watch.py; echo done");

    const secret = `sk_victim_${randomBytes(8).toString("hex")}`;
    const file = await writeInput(victim, "config.json", secret);
    // The write left the input 0644, as an API write may. 100 ms gap.
    expect(
      (
        await root(`stat -c %a ${shellQuote(stagedPath(victim, file))}`)
      ).stdout.trim(),
    ).toBe("644");
    await new Promise(resolve => setTimeout(resolve, 100));
    await root(
      launchScript(
        victim,
        [file],
        `sh -c 'sleep 1' connector --config ${shellQuote(file)}`,
      ),
    );
    await watching;

    const hits = await root(
      `cat ${shellQuote(`${watcher.home}/hits`)} 2>/dev/null; true`,
    );
    expect(hits.stdout).not.toContain(secret);
    expect(hits.stdout).toBe("");
    expect((await root(cleanupScript(victim))).code).toBe(0);
    expect((await root(cleanupScript(watcher))).code).toBe(0);
  }, 60_000);

  it("finds and kills a thread flood that overflows a single argv", async () => {
    // 6,000 threads under a 256 KB stack limit: one `cat` over every status
    // path fails with E2BIG there (a check that would report nothing alive).
    const l = await open();
    await root(
      `printf '%s\\n' 'import threading, time' 'threading.stack_size(262144)' '[threading.Thread(target=time.sleep, args=(600,)).start() for _ in range(6000)]' 'time.sleep(600)' > /opt/flood.py && chmod 0644 /opt/flood.py`,
    );
    await connector(
      l,
      [],
      "nohup python3 /opt/flood.py >/dev/null 2>&1 &\nsleep 8; echo started",
    );
    const old = await root(
      "ulimit -s 256; cat /proc/[0-9]*/task/[0-9]*/status >/dev/null; echo exit=$?",
    );
    expect(old.stdout + old.stderr).toMatch(/Argument list too long|exit=126/);
    expect(await liveThreads(l.uid)).toBeGreaterThan(5000);

    const cleanup = await root(`ulimit -s 256\n${cleanupScript(l)}`, 120_000);
    expect(cleanup, cleanup.stderr).toMatchObject({ code: 0 });
    expect(await liveThreads(l.uid)).toBe(0);
  }, 180_000);

  it("refuses to start a run without useradd", async () => {
    await root("mv /usr/sbin/useradd /usr/sbin/useradd.off");
    try {
      const l = runLayout(
        randomBytes(8).toString("hex"),
        "mkcnouseradd1",
        299_999,
      );
      const setup = await root(setupScript(l));
      expect(setup.code).not.toBe(0);
      expect(setup.stderr).toContain("missing tools: useradd");
    } finally {
      await root("mv /usr/sbin/useradd.off /usr/sbin/useradd");
    }
  }, 60_000);

  // The chunk path: setup, launch, bounding and cleanup in ONE root command.
  describe("one chunk in one command (chunkScript)", () => {
    const fresh = () => {
      counter++;
      return runLayout(
        randomBytes(8).toString("hex"),
        `mkc${randomBytes(6).toString("hex")}`,
        310_000 + counter * 1_000 + Math.floor(Math.random() * 900),
        510_000 + counter * 1_000 + Math.floor(Math.random() * 900),
      );
    };
    /** Write an input into the root-only inbox, as the API's one writeFiles does. */
    const toInbox = async (l: RunLayout, name: string, body: string) => {
      const target = incomingPath(l.runId, name);
      const res = await root(
        `umask 022; mkdir -p ${shellQuote(target.replace(/\/[^/]+$/, ""))} && printf %s ${shellQuote(body)} > ${shellQuote(target)}`,
      );
      expect(res.code).toBe(0);
      return `${l.dir}/${name}`;
    };
    const marker = (stdout: string) =>
      stdout
        .split("\n")
        .filter(line => line.startsWith(`${CHUNK_MARKER} `))
        .at(-1)
        ?.split(" ")
        .slice(1);

    beforeAll(async () => {
      if (!ENABLED) return;
      const prep = await root(prepareBoxScript());
      expect(prep.stdout.trim()).toBe("");
      expect(prep.code).toBe(0);
    });

    it("keeps the inbox root-only, so no run reads an input before its own launch", async () => {
      const mode = await root(
        `stat -c '%U %a' ${shellQuote(ISOLATED_INCOMING)}`,
      );
      expect(mode.stdout.trim()).toBe("root 700");
      const victim = fresh();
      const secret = `sk_v_${randomBytes(8).toString("hex")}`;
      await toInbox(victim, "config.json", secret);
      // A concurrent run, as its own user, tries to read it.
      const thief = fresh();
      const res = await root(
        chunkScript(
          thief,
          [],
          `sh -c ${shellQuote(`cat ${shellQuote(incomingPath(victim.runId, "config.json"))} && echo READ-OK; ls ${shellQuote(ISOLATED_INCOMING)} && echo LIST-OK; true`)}`,
          1024 * 1024,
        ),
      );
      const [size, cleanup] = marker(res.stdout) ?? [];
      expect(cleanup).toBe("0");
      const out = (await root(`cat ${shellQuote(resultPath(thief.runId))}`))
        .stdout;
      expect(Number(size)).toBe(out.length);
      expect(out).not.toMatch(/READ-OK|LIST-OK/);
      expect(out).not.toContain(secret);
      await root(
        `rm -rf ${shellQuote(`${ISOLATED_INCOMING}/${victim.runId}`)} ${shellQuote(resultPath(thief.runId))}`,
      );
    }, 120_000);

    it("runs a connector end to end and leaves only its bounded output", async () => {
      const l = fresh();
      const secret = `sk_c_${randomBytes(8).toString("hex")}`;
      const file = await toInbox(l, "config.json", secret);
      // The connector reads its credential, leaves a child behind, exits 0.
      const res = await root(
        chunkScript(
          l,
          [file],
          `sh -c ${shellQuote(`printf 'got %s' "$(cat ${shellQuote(file)})"; (sleep 300 &) ; true`)}`,
          1024 * 1024,
        ),
      );
      expect(res.code, res.stderr).toBe(0);
      const [size, cleanup] = marker(res.stdout) ?? [];
      expect(cleanup).toBe("0");
      const out = (await root(`cat ${shellQuote(resultPath(l.runId))}`)).stdout;
      expect(out).toBe(`got ${secret}`);
      expect(Number(size)).toBe(out.length);
      // Nothing of the run is left but that output: no user, no directory,
      // no inbox, no process.
      expect((await root(`id ${shellQuote(l.user)}`)).code).not.toBe(0);
      expect((await root(`test -e ${shellQuote(l.dir)}`)).code).not.toBe(0);
      expect(
        (await root(`test -e ${shellQuote(`${ISOLATED_INCOMING}/${l.runId}`)}`))
          .code,
      ).not.toBe(0);
      const procs = await root(
        `awk '/^Uid:/ && $2 == ${l.uid}' /proc/[0-9]*/status 2>/dev/null | wc -l`,
      );
      expect(procs.stdout.trim()).toBe("0");
      await root(`rm -f ${shellQuote(resultPath(l.runId))}`);
    }, 120_000);

    it("bounds the output at the cap", async () => {
      const l = fresh();
      const res = await root(
        chunkScript(
          l,
          [],
          `sh -c ${shellQuote("head -c 5000 /dev/zero")}`,
          1000,
        ),
      );
      const [size, cleanup] = marker(res.stdout) ?? [];
      expect(size).toBe("1001");
      expect(cleanup).toBe("0");
      await root(`rm -f ${shellQuote(resultPath(l.runId))}`);
    }, 120_000);

    it("refuses to launch when its inputs never reached this box, and still cleans up", async () => {
      const l = fresh();
      const res = await root(
        chunkScript(
          l,
          [`${l.dir}/config.json`],
          `sh -c ${shellQuote("echo SHOULD-NOT-RUN")}`,
          1024 * 1024,
        ),
      );
      expect(res.code).toBe(INPUTS_MISSING_EXIT);
      expect(marker(res.stdout)).toEqual(["inputs-missing", "0"]);
      expect(res.stdout).not.toContain("SHOULD-NOT-RUN");
      expect((await root(`id ${shellQuote(l.user)}`)).code).not.toBe(0);
      expect((await root(`test -e ${shellQuote(l.dir)}`)).code).not.toBe(0);
    }, 120_000);
  });
});
