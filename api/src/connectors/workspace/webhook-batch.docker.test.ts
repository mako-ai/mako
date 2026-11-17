/**
 * A webhook batch in a real Linux box: E2B's own `e2bdev/base` image in
 * local Docker, reached through `docker exec` with real Unix users. No E2B
 * account. Everything above the box is the API's own code:
 * `SandboxedConnector.runWebhookBatch`, `sync-box.ts` (runtime install,
 * per-run users, the chunk script, the bounded output) and the SDK runner's
 * `webhook` command.
 *
 * Gated like run-isolation.docker.test.ts: RUN_DB_INTEGRATION=1 or
 * RUN_CONNECTOR_ISOLATION_DOCKER=1. The first run downloads the connector
 * runtime's Node into the container.
 *
 *   RUN_CONNECTOR_ISOLATION_DOCKER=1 pnpm --filter api exec vitest run \
 *     --config vitest.destinations.config.ts src/connectors/workspace/webhook-batch.docker.test.ts
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ENABLED =
  process.env.RUN_DB_INTEGRATION === "1" ||
  process.env.RUN_CONNECTOR_ISOLATION_DOCKER === "1";
const suite = ENABLED ? describe : describe.skip;
const IMAGE = process.env.CONNECTOR_ISOLATION_IMAGE ?? "e2bdev/base:latest";

/** The flow's signing secret. The box must never hold it. */
const SIGNING_SECRET = "5ec7e7".repeat(10);
const API_KEY = "api_key_webhook_docker";

/**
 * A connector with a webhook handler that reports what it can see from
 * inside its run: its inputs, its environment, other processes. A `hang`
 * event never returns, as a hostile or broken handler would.
 */
const CONNECTOR = `
import fs from "node:fs";
import path from "node:path";
import { defineConnector } from "@makoai/connector-sdk";

export default defineConnector({
  name: "hooks",
  version: "1.0.0",
  config: { required: ["api_key"], properties: { api_key: { type: "string", airbyte_secret: true } } },
  entities: { items: { schema: { id: "string" }, async *read() { yield { records: [], hasMore: false }; } } },
  webhooks: {
    verification: {
      scheme: "hmac-sha256",
      secretEncoding: "hex",
      signedPayload: ["header:x-ts", "body"],
      signatureHeader: "x-sig",
      signatureEncoding: "hex",
    },
    async handleBatch(ctx, events) {
      if (events.some(e => e.eventType === "hang")) {
        await new Promise(() => setInterval(() => {}, 1000));
      }
      const argv = process.argv;
      const inputDir = path.dirname(argv[argv.indexOf("--batch") + 1]);
      let others = 0;
      for (const pid of fs.readdirSync("/proc").filter(p => /^\\d+$/.test(p))) {
        try {
          if (fs.statSync("/proc/" + pid).uid !== process.getuid()) others++;
        } catch {}
      }
      const seen = {
        inputs: fs.readdirSync(inputDir).filter(f => f.endsWith(".json")).sort(),
        env: Object.keys(process.env).sort(),
        uid: process.getuid(),
        apiKey: ctx.config.api_key,
        others,
      };
      return events.map(e => ({
        eventId: e.eventId,
        outcome: "records",
        records: [{ entity: "items", recordId: e.eventId, operation: "upsert", payload: { id: e.eventId, seen } }],
      }));
    },
  },
});
`;

let container = "";

function dockerExec(
  script: string,
  options: { asRoot?: boolean; timeoutMs?: number; input?: Buffer } = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(
      "docker",
      [
        "exec",
        ...(options.input ? ["-i"] : []),
        "-u",
        options.asRoot ? "root" : "user",
        container,
        "bash",
        "-c",
        script,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", d => out.push(d));
    child.stderr.on("data", d => (err += d));
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeoutMs ?? 600_000,
    );
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code: code ?? 124, stdout: Buffer.concat(out), stderr: err });
    });
    child.stdin.end(options.input ?? undefined);
  });
}

const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const dockerProvider = {
  id: "local" as const,
  supportsRunUsers: true,
  root: () => "/home/user",
  scratch: () => "/home/user/.scratch",
  async hasSession() {
    return true;
  },
  async exec(_ctx: unknown, command: string, options: any = {}) {
    const res = await dockerExec(command, options);
    return {
      exitCode: res.code,
      stdout: res.stdout.toString("utf8"),
      stderr: res.stderr,
      timedOut: res.code === 124 || res.code === 137,
      durationMs: 0,
      truncated: false,
      sandboxId: container,
    };
  },
  async writeFile(
    _ctx: unknown,
    remotePath: string,
    bytes: Uint8Array,
    options: any = {},
  ) {
    const res = await dockerExec(
      `mkdir -p "$(dirname ${q(remotePath)})" && cat > ${q(remotePath)}`,
      { asRoot: options.asRoot, input: Buffer.from(bytes) },
    );
    if (res.code !== 0) throw new Error(`write ${remotePath}: ${res.stderr}`);
  },
  /** One request for several files, as E2B's batched write. */
  async writeFiles(
    _ctx: unknown,
    files: Array<{ path: string; bytes: Uint8Array }>,
    options: any = {},
  ) {
    const script = files
      .map(
        f =>
          `mkdir -p "$(dirname ${q(f.path)})" && printf %s ${q(Buffer.from(f.bytes).toString("base64"))} | base64 -d > ${q(f.path)}`,
      )
      .join(" && ");
    const res = await dockerExec(script, { asRoot: options.asRoot });
    if (res.code !== 0) throw new Error(`writeFiles: ${res.stderr}`);
  },
  async readFile(_ctx: unknown, remotePath: string, options: any = {}) {
    const res = await dockerExec(`cat ${q(remotePath)}`, {
      asRoot: options.asRoot,
    });
    if (res.code !== 0) throw new Error(`read ${remotePath}: ${res.stderr}`);
    return new Uint8Array(res.stdout);
  },
};

let makeConnector: () => any;

beforeAll(async () => {
  if (!ENABLED) return;
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.CONNECTOR_WEBHOOK_BATCHES = "true";
  delete process.env.CONNECTOR_BOX_LEASES;
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
  await dockerExec("id user >/dev/null 2>&1 || useradd -m -s /bin/bash user", {
    asRoot: true,
  });

  const local = await import("../../apps/sandbox/local-provider");
  Object.assign(local.localSandboxProvider, dockerProvider);
  const syncBox = await import("./sync-box");
  const resolver = await import("./resolver");
  const { SandboxedConnector } = await import("./SandboxedConnector");

  const ctx = { sessionKey: "connector-sync:v2:webhook-docker" };
  const runtimeId = await resolver.ensureConnectorRuntime(ctx as never);
  const dir = await syncBox.materializeConnector({
    ctx: ctx as never,
    runtimeId,
    slug: "hooks",
    sourceSha: "hooksdocker01",
    files: new Map([
      ["connector.ts", new TextEncoder().encode(CONNECTOR)],
      ["connector.yaml", new TextEncoder().encode("runtime: node\n")],
    ]),
  });
  makeConnector = () => {
    const connector = new SandboxedConnector({
      _id: "665f000000000000000000d1",
      type: "ws:hooks",
      workspaceId: "webhook-docker",
      config: { api_key: API_KEY },
    } as never) as any;
    connector.loaded = {
      slug: "hooks",
      runtime: "node",
      entry: "connector.ts",
      sha: "hooksdocker01",
      sourceSha: "hooksdocker01",
      entities: ["items"],
      status: "indexed",
    };
    connector.ready = async () => ({
      dir,
      runtimeId,
      entry: "connector.ts",
      ctx,
    });
    return connector;
  };
}, 300_000);

afterAll(async () => {
  if (container) await run("docker", ["rm", "-f", container]).catch(() => {});
});

const events = (prefix: string, n: number, eventType = "item.updated") =>
  Array.from({ length: n }, (_, i) => ({
    eventId: `${prefix}${i}`,
    eventType,
    rawPayload: { id: `${prefix}${i}` },
    receivedAt: "2026-11-17T08:00:00.000Z",
  }));

/** What a finished run must not leave: users, inputs, processes. */
async function leftovers() {
  const res = await dockerExec(
    [
      "getent passwd | grep -c '^mkc' || true",
      "find / -xdev \\( -name batch.json -o -name config.json \\) -newer /etc/hostname 2>/dev/null | grep -v '^/proc' | wc -l",
      "ps -eo user= | grep -c '^mkc' || true",
      `grep -rl ${q(SIGNING_SECRET)} /home /tmp /var/tmp /root 2>/dev/null | wc -l`,
    ].join("; "),
    { asRoot: true },
  );
  const [users, inputs, processes, secrets] = res.stdout
    .toString()
    .trim()
    .split("\n")
    .map(Number);
  return { users, inputs, processes, secrets };
}

suite("webhook batches in e2bdev/base (Docker)", () => {
  it("runs a batch as a per-run user, with the connection's credential and the events only", async () => {
    const batch = { events: events("ev", 3) };
    const result = await makeConnector().runWebhookBatch(batch, {
      timeoutMs: 60_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const outcomes = result.messages.filter((m: any) => m.type === "WEBHOOK");
    expect(outcomes.map((m: any) => m.webhook.eventId)).toEqual([
      "ev0",
      "ev1",
      "ev2",
    ]);
    const seen = outcomes[0].webhook.records[0].payload.seen;
    // Its inputs are exactly the credential file and the batch.
    expect(seen.inputs).toEqual(["batch.json", "config.json"]);
    expect(seen.apiKey).toBe(API_KEY);
    expect(seen.uid).toBeGreaterThanOrEqual(200_000);
    // Nothing in its environment names a secret or the webhook.
    expect(
      seen.env.filter((k: string) => /SECRET|WEBHOOK|E2B|MAKO_/.test(k)),
    ).toEqual([]);
    expect(await leftovers()).toEqual({
      users: 0,
      inputs: 0,
      processes: 0,
      secrets: 0,
    });
  }, 120_000);

  it("a hanging handler times out and is removed, while a batch beside it completes", async () => {
    const t0 = Date.now();
    const [hung, fine] = await Promise.all([
      makeConnector().runWebhookBatch(
        { events: events("hang", 1, "hang") },
        { timeoutMs: 8_000 },
      ),
      makeConnector().runWebhookBatch(
        { events: events("ok", 2) },
        { timeoutMs: 60_000 },
      ),
    ]);
    expect(hung.timedOut).toBe(true);
    expect(fine.exitCode, fine.stderr).toBe(0);
    expect(fine.messages.filter((m: any) => m.type === "WEBHOOK")).toHaveLength(
      2,
    );
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(await leftovers()).toEqual({
      users: 0,
      inputs: 0,
      processes: 0,
      secrets: 0,
    });
  }, 120_000);
});
