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
  ISOLATED_RUNS,
  cleanupScript,
  launchScript,
  runLayout,
  setupScript,
  shellQuote,
  snapshotScript,
  type RunLayout,
} from "./run-isolation";

const run = promisify(execFile);
const ENABLED = process.env.RUN_DB_INTEGRATION === "1";
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
  );
  const setup = await root(setupScript(layout));
  expect(setup, setup.stderr).toMatchObject({ code: 0 });
  return layout;
}

/** Write an input as root, the way `writeFile(..., { asRoot: true })` does. */
async function writeInput(l: RunLayout, name: string, body: string) {
  const file = `${l.dir}/${name}`;
  const res = await root(`printf %s ${shellQuote(body)} > ${shellQuote(file)}`);
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
      expect(setup.stderr).toContain("missing useradd");
    } finally {
      await root("mv /usr/sbin/useradd.off /usr/sbin/useradd");
    }
  }, 60_000);
});
