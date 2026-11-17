/**
 * A webhook batch in a real E2B box, through the API's own code:
 * `SandboxedConnector.runWebhookBatch`, `sync-box.ts` (runtime install, a
 * per-run Unix user, the chunk script, the bounded output) and the SDK
 * runner's `webhook` command. The provider is a thin shim over the E2B SDK,
 * so nothing else of the API (Mongo, the box store) is needed.
 *
 * The connector reports what its run can see: its inputs, its environment
 * and the processes of other users. A second batch hangs, and must time out
 * and leave nothing behind. Every box this makes is killed at the end.
 *
 * Needs E2B_API_KEY in the environment (never printed).
 *
 *   cd api
 *   E2B_API_KEY=... pnpm exec tsx ../bench/connector-webhook/e2b-webhook.mts
 *
 * Options: --template <id> (default: the mako-apps dev template).
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, "../../api");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const TEMPLATE = arg("template", "3f2t2qgqsu5m8e42xd5i");
if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY is not set");

process.env.APPS_SANDBOX_PROVIDER = "local";
process.env.NODE_ENV = "development";
process.env.CONNECTOR_WEBHOOK_BATCHES = "true";
delete process.env.CONNECTOR_BOX_LEASES;

const mod = (rel: string) => import(pathToFileURL(path.join(API, rel)).href);
const { Sandbox } = await import(
  pathToFileURL(path.join(API, "node_modules/e2b/dist/index.mjs")).href
);
const hiddenCmd = await mod("src/apps/sandbox/hidden-command.ts");

const checks: Array<{ check: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ check: name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

const sbx: any = await Sandbox.create(TEMPLATE, {
  timeoutMs: 20 * 60_000,
  metadata: { purpose: "connector-webhook-batch-test" },
});
console.log(`box ${sbx.sandboxId}`);

try {
  const provider = {
    id: "local" as const,
    supportsRunUsers: true,
    root: () => "/home/user",
    scratch: () => "/home/user/.scratch",
    async hasSession() {
      return true;
    },
    async exec(_ctx: unknown, script: string, options: any = {}) {
      const run = hiddenCmd.commandToRun(script, {
        hideCommand: options.hideCommand,
      });
      const t0 = Date.now();
      try {
        const r = await sbx.commands.run(run.command, {
          user: options.asRoot ? "root" : "user",
          envs: run.env,
          timeoutMs: options.timeoutMs ?? 120_000,
        });
        return {
          exitCode: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
          timedOut: false,
          durationMs: Date.now() - t0,
          truncated: false,
          sandboxId: sbx.sandboxId,
        };
      } catch (error: any) {
        const timedOut = /timed? ?out|deadline/i.test(String(error?.message));
        return {
          exitCode: typeof error?.exitCode === "number" ? error.exitCode : 124,
          stdout: error?.stdout ?? "",
          stderr: error?.stderr ?? String(error?.message ?? error),
          timedOut,
          durationMs: Date.now() - t0,
          truncated: false,
          sandboxId: sbx.sandboxId,
        };
      }
    },
    async writeFile(_ctx: unknown, p: string, bytes: Uint8Array, o: any = {}) {
      await sbx.files.write(p, new Blob([bytes]), {
        user: o.asRoot ? "root" : "user",
      });
    },
    async writeFiles(
      ctx: unknown,
      files: Array<{ path: string; bytes: Uint8Array }>,
      o: any = {},
    ) {
      for (const f of files) await provider.writeFile(ctx, f.path, f.bytes, o);
    },
    async readFile(_ctx: unknown, p: string, o: any = {}) {
      return new Uint8Array(
        await sbx.files.read(p, {
          format: "bytes",
          user: o.asRoot ? "root" : "user",
        }),
      );
    },
  };
  const local = await mod("src/apps/sandbox/local-provider.ts");
  Object.assign(local.localSandboxProvider, provider);

  const syncBox = await mod("src/connectors/workspace/sync-box.ts");
  const resolver = await mod("src/connectors/workspace/resolver.ts");
  const { SandboxedConnector } = await mod(
    "src/connectors/workspace/SandboxedConnector.ts",
  );
  const CONNECTOR = await import(
    pathToFileURL(path.join(HERE, "connector-source.mjs")).href
  );

  const ctx = { sessionKey: "connector-sync:v2:webhook-e2b" };
  const runtimeId = await resolver.ensureConnectorRuntime(ctx);
  const dir = await syncBox.materializeConnector({
    ctx,
    runtimeId,
    slug: "hooks",
    sourceSha: "hookse2b01",
    files: new Map([
      ["connector.ts", new TextEncoder().encode(CONNECTOR.default)],
      ["connector.yaml", new TextEncoder().encode("runtime: node\n")],
    ]),
  });
  const make = () => {
    const c = new SandboxedConnector({
      _id: "665f000000000000000000e1",
      type: "ws:hooks",
      workspaceId: "webhook-e2b",
      config: { api_key: "api_key_e2b" },
    } as never) as any;
    c.loaded = {
      slug: "hooks",
      runtime: "node",
      entry: "connector.ts",
      sha: "hookse2b01",
      sourceSha: "hookse2b01",
      entities: ["items"],
      status: "indexed",
    };
    c.ready = async () => ({ dir, runtimeId, entry: "connector.ts", ctx });
    return c;
  };
  const events = (prefix: string, n: number, eventType = "item.updated") =>
    Array.from({ length: n }, (_, i) => ({
      eventId: `${prefix}${i}`,
      eventType,
      rawPayload: { id: `${prefix}${i}` },
      receivedAt: new Date().toISOString(),
    }));
  const leftovers = async () => {
    const r = await provider.exec(
      ctx,
      [
        "getent passwd | grep -c '^mkc' || true",
        "find / -xdev \\( -name batch.json -o -name config.json \\) -newer /etc/hostname 2>/dev/null | grep -v -e '^/proc' -e node_modules | wc -l",
        "ps -eo user= | grep -c '^mkc' || true",
      ].join("; "),
      { asRoot: true },
    );
    return r.stdout.trim().split("\n").map(Number);
  };

  const t0 = Date.now();
  const result = await make().runWebhookBatch(
    { events: events("ev", 50) },
    { timeoutMs: 60_000 },
  );
  const ms = Date.now() - t0;
  const outcomes = result.messages.filter((m: any) => m.type === "WEBHOOK");
  check("batch of 50 exits 0", result.exitCode === 0, result.stderr.slice(0, 200));
  check("50 outcomes, in order", outcomes.length === 50 && outcomes[49].webhook.eventId === "ev49");
  const seen = outcomes[0]?.webhook.records[0].payload.seen ?? {};
  check(
    "inputs are config.json and batch.json only",
    JSON.stringify(seen.inputs) === JSON.stringify(["batch.json", "config.json"]),
    JSON.stringify(seen.inputs),
  );
  check("runs as a per-run uid", seen.uid >= 200_000, String(seen.uid));
  const flagged = (seen.env ?? []).filter((k: string) =>
    /SECRET|WEBHOOK|MAKO_|KEY|TOKEN/.test(k),
  );
  check("no secret-like env", flagged.length === 0, flagged.join(","));
  console.log(`env names in the run: ${(seen.env ?? []).join(",")}`);
  check("other users' processes hidden (hidepid)", seen.others === 0, String(seen.others));
  console.log(`batch of 50 took ${ms} ms`);
  check("nothing left after the batch", JSON.stringify(await leftovers()) === "[0,0,0]");

  const t1 = Date.now();
  const hung = await make().runWebhookBatch(
    { events: events("hang", 1, "hang") },
    { timeoutMs: 10_000 },
  );
  check("a hanging handler times out", hung.timedOut === true || hung.exitCode !== 0, `${Date.now() - t1} ms`);
  check("nothing left after the timeout", JSON.stringify(await leftovers()) === "[0,0,0]", JSON.stringify(await leftovers()));
} finally {
  await sbx.kill();
  console.log(`killed ${sbx.sandboxId}`);
  const failed = checks.filter(c => !c.ok).length;
  console.log(`${checks.length - failed} of ${checks.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
