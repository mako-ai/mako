import assert from "node:assert/strict";
import { type SandboxInfo } from "e2b";
import {
  E2BSandboxProvider,
  type E2BSandboxClient,
  type E2BSandboxFactory,
} from "./e2b-sandbox-provider";

type FailureStage = "isolation" | "conformance";

async function run(): Promise<void> {
  const events: string[] = [];
  let failureStage: FailureStage | undefined;
  let conformanceCount = 0;
  let nextPid = 100;

  const sandbox: E2BSandboxClient = {
    sandboxId: "sandbox-test",
    files: {
      async exists() {
        events.push("tenant:file:exists");
        return false;
      },
      async remove() {
        events.push("tenant:file:remove");
      },
      async makeDir() {
        events.push("tenant:file:mkdir");
        return true;
      },
      async write() {
        events.push("tenant:file:write");
      },
      async list() {
        events.push("tenant:file:list");
        return [];
      },
      async read() {
        events.push("tenant:file:read");
        return new Uint8Array();
      },
    },
    commands: {
      async run(command, options) {
        const stage = command.includes("iptables -I OUTPUT")
          ? "isolation"
          : command.includes("id -u")
            ? "conformance"
            : "tenant:command";
        events.push(stage);
        if (stage === "isolation") {
          assert.match(
            command,
            /set -eu.*iptables -I OUTPUT -d 169\.254\.169\.254\/32 -j REJECT.*iptables -C OUTPUT -d 169\.254\.169\.254\/32 -j REJECT/s,
          );
          assert.equal(options.user, "root");
          assert.deepEqual(options.envs, {
            HOME: "/root",
            PATH: "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin",
            BASH_ENV: "/dev/null",
          });
        } else if (stage === "conformance") {
          conformanceCount += 1;
          assert.equal(options.user, "mako");
        }
        const pid = nextPid;
        nextPid += 1;
        return {
          pid,
          async wait() {
            if (failureStage === stage) {
              throw new Error(`${stage} failed`);
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          async kill() {
            return true;
          },
        };
      },
    },
    async updateNetwork() {
      events.push("tenant:network");
    },
  };

  const factory: E2BSandboxFactory = {
    async create() {
      events.push("create");
      return sandbox;
    },
    async connect() {
      events.push("connect");
      return sandbox;
    },
    async getInfo(): Promise<SandboxInfo> {
      return { state: "running" } as SandboxInfo;
    },
    async pause() {
      events.push("pause");
      return true;
    },
    async kill() {
      events.push("kill");
      return true;
    },
    list() {
      return {
        hasNext: false,
        async nextItems() {
          return [];
        },
      };
    },
  };
  const provider = new E2BSandboxProvider(
    "test-control-key",
    "test-template",
    "mako",
    factory,
  );
  const createSpec = () => ({
    workspaceId: "workspace",
    projectId: "project",
    worktreeId: "worktree",
    actorId: "actor",
    purpose: "dev" as const,
    leaseEpoch: 1,
    durableRevision: { wipOid: "a".repeat(40), revision: 0 },
    labels: {},
    async onProvisioned() {
      events.push("provisioned");
    },
  });

  await provider.create(createSpec());
  assert.deepEqual(events, [
    "create",
    "isolation",
    "conformance",
    "provisioned",
  ]);

  events.length = 0;
  await provider.exec("sandbox-test", {
    argv: ["true"],
    cwd: "/workspace",
    timeoutMs: 1_000,
    maxOutputBytes: 1_000,
  });
  assert.deepEqual(events, [
    "connect",
    "isolation",
    "conformance",
    "tenant:command",
  ]);

  events.length = 0;
  await provider.materializeFiles("sandbox-test", []);
  assert.deepEqual(events, [
    "connect",
    "isolation",
    "conformance",
    "tenant:file:exists",
    "tenant:file:mkdir",
  ]);

  events.length = 0;
  await provider.captureFiles("sandbox-test");
  assert.deepEqual(events, [
    "connect",
    "isolation",
    "conformance",
    "tenant:file:list",
  ]);

  events.length = 0;
  await provider.setNetworkPhase("sandbox-test", "install");
  assert.deepEqual(events, [
    "connect",
    "isolation",
    "conformance",
    "tenant:network",
  ]);

  const conformanceBeforeResume = conformanceCount;
  events.length = 0;
  await provider.quiesce("sandbox-test");
  assert.deepEqual(events, ["pause", "connect", "isolation", "conformance"]);
  assert.equal(conformanceCount, conformanceBeforeResume + 1);

  failureStage = "isolation";
  events.length = 0;
  await assert.rejects(
    provider.exec("sandbox-test", {
      argv: ["should-not-run"],
      cwd: "/workspace",
      timeoutMs: 1_000,
      maxOutputBytes: 1_000,
    }),
    /failed Apps v2 conformance\/runtime isolation/,
  );
  assert.deepEqual(events, ["connect", "isolation", "kill"]);

  failureStage = "conformance";
  events.length = 0;
  await assert.rejects(
    provider.materializeFiles("sandbox-test", []),
    /failed Apps v2 conformance\/runtime isolation/,
  );
  assert.deepEqual(events, ["connect", "isolation", "conformance", "kill"]);

  const conformanceBeforeFailedResume = conformanceCount;
  events.length = 0;
  await assert.rejects(
    provider.quiesce("sandbox-test"),
    /failed Apps v2 conformance\/runtime isolation/,
  );
  assert.deepEqual(events, [
    "pause",
    "connect",
    "isolation",
    "conformance",
    "kill",
  ]);
  assert.equal(conformanceCount, conformanceBeforeFailedResume + 1);

  failureStage = "isolation";
  events.length = 0;
  await assert.rejects(
    provider.create(createSpec()),
    /failed Apps v2 conformance\/runtime isolation/,
  );
  assert.deepEqual(events, ["create", "isolation", "kill"]);

  failureStage = "conformance";
  events.length = 0;
  await assert.rejects(
    provider.create(createSpec()),
    /failed Apps v2 conformance\/runtime isolation/,
  );
  assert.deepEqual(events, ["create", "isolation", "conformance", "kill"]);
}

void run().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
