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
  let sandboxState: "running" | "paused" = "running";
  let pauseResult = true;
  let workspaceGitExists = false;
  const commands: string[] = [];

  const sandbox: E2BSandboxClient = {
    sandboxId: "sandbox-test",
    files: {
      async exists(filePath) {
        events.push("tenant:file:exists");
        return filePath === "/workspace/.git" && workspaceGitExists;
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
        commands.push(command);
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
            const stdout = command.includes("'symbolic-ref'")
              ? "main\n"
              : command.includes("'write-tree'")
                ? `${"c".repeat(40)}\n`
                : command.includes("'rev-parse'") &&
                    command.includes(`${"b".repeat(40)}^{tree}`)
                  ? `${"c".repeat(40)}\n`
                  : command.includes("'rev-parse'") &&
                      command.includes("'HEAD'")
                    ? `${"a".repeat(40)}\n`
                    : command.includes("'remote'") &&
                        command.includes("'get-url'")
                      ? "https://apps-v2.mako.invalid/blocked.git\n"
                      : command.includes("'remote'") &&
                          !command.includes("'set-url'")
                        ? "origin\n"
                        : "";
            return { exitCode: 0, stdout, stderr: "" };
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
      return { state: sandboxState } as SandboxInfo;
    },
    async pause() {
      events.push("pause");
      return pauseResult;
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

  commands.length = 0;
  events.length = 0;
  await provider.materializeRepository(
    "sandbox-test",
    {
      bundle: Buffer.from("test bundle"),
      branch: "main",
      branchHead: "a".repeat(40),
      wipOid: "b".repeat(40),
    },
    "fresh",
  );
  assert(events.includes("tenant:network"));
  assert(commands.some(command => command.includes("'clone'")));
  assert(
    commands.some(
      command =>
        command.includes("'remote' 'set-url' 'origin'") &&
        command.includes("apps-v2.mako.invalid"),
    ),
  );
  assert(commands.some(command => command.includes("'read-tree'")));
  assert(
    commands.every(
      command =>
        !command.includes("github.com") && !command.includes("credential="),
    ),
  );

  workspaceGitExists = true;
  commands.length = 0;
  events.length = 0;
  await provider.materializeRepository(
    "sandbox-test",
    {
      bundle: Buffer.from("updated bundle"),
      branch: "main",
      branchHead: "a".repeat(40),
      wipOid: "b".repeat(40),
    },
    "update",
  );
  assert(commands.some(command => command.includes("'fetch'")));
  assert(commands.some(command => command.includes("'reset' '--soft'")));
  assert(!commands.some(command => command.includes("'clean' '-ffdx'")));
  assert(!commands.some(command => command.includes("'clone'")));

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

  sandboxState = "paused";
  events.length = 0;
  await provider.quiesce("sandbox-test");
  assert.deepEqual(events, [
    "connect",
    "isolation",
    "conformance",
    "pause",
    "connect",
    "isolation",
    "conformance",
  ]);

  sandboxState = "running";
  pauseResult = false;
  events.length = 0;
  await assert.rejects(
    provider.quiesce("sandbox-test"),
    /did not confirm filesystem-only pause/,
  );
  assert.deepEqual(events, ["pause"]);
  pauseResult = true;

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
    provider.captureFiles("sandbox-test"),
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
