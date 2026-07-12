import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Types } from "mongoose";
import { createAppV2Scaffold } from "@mako/schemas";
import { FileType, type EntryInfo, type SandboxInfo } from "e2b";
import type {
  IAppV2Project,
  IAppV2Worktree,
} from "../database/workspace-schema";
import { AppV2ProjectService } from "./app-project.service";
import { CloudSessionExecutor } from "./cloud-session-executor";
import {
  AppV2ConflictError,
  AppV2OperationConflictError,
  AppV2RecoveryConflictError,
} from "./errors";
import {
  E2BSandboxProvider,
  e2bCommandForArgv,
  type E2BSandboxClient,
  type E2BSandboxFactory,
} from "./providers/e2b-sandbox-provider";
import { AppV2GitProvider } from "./providers/git-provider";
import { AppV2KeyedMutex } from "./session-operation-lock";
import {
  AppV2SessionService,
  type NewAppV2SessionRecord,
  type AppV2SessionRecord,
  type AppV2SessionStore,
} from "./session.service";
import { FakeSandboxProvider } from "./testing/fake-sandbox-provider";
import { FakeSessionExecutor } from "./testing/fake-session-executor";
import { AppV2WorktreeService } from "./worktree.service";

class MemoryProjectService extends AppV2ProjectService {
  constructor(
    git: AppV2GitProvider,
    private readonly project: IAppV2Project,
  ) {
    super(git);
  }

  override async getWritable(): Promise<IAppV2Project> {
    return this.project;
  }
}

class MemoryWorktreeService extends AppV2WorktreeService {
  afterNextGitCas?: (wipOid: string) => void;

  constructor(
    projects: AppV2ProjectService,
    private readonly project: IAppV2Project,
    readonly current: IAppV2Worktree,
  ) {
    super(projects);
  }

  override async getById(): Promise<IAppV2Worktree> {
    const authoritativeWipOid = await projectService.git.resolveRef(
      this.project.repositoryId,
      this.current.wipRef,
    );
    if (authoritativeWipOid !== this.current.wipOid) {
      this.current.wipOid = authoritativeWipOid;
      this.current.revision += 1;
    }
    return this.current;
  }

  override async replaceTree(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    state: {
      ifRevision: number;
      expectedWipOid: string;
      leaseEpoch: number;
    },
    files: Array<{ path: string; content: Buffer; executable: boolean }>,
    recoveryId?: string,
  ): Promise<IAppV2Worktree> {
    if (
      state.ifRevision !== this.current.revision ||
      state.expectedWipOid !== this.current.wipOid ||
      state.leaseEpoch !== this.current.leaseEpoch
    ) {
      throw new AppV2ConflictError("Stale in-memory worktree");
    }
    const result = await projectService.git.replaceWorktreeTree(
      project.repositoryId,
      worktree.wipRef,
      state.expectedWipOid,
      worktree.baseSha,
      worktree.leaseRef,
      worktree.leaseOid,
      files,
      recoveryId,
    );
    if (this.afterNextGitCas) {
      const afterGitCas = this.afterNextGitCas;
      this.afterNextGitCas = undefined;
      afterGitCas(result.wipOid);
    }
    this.current.wipOid = result.wipOid;
    this.current.revision += 1;
    return this.current;
  }

  override async rotateLease(
    project: IAppV2Project,
    worktree: IAppV2Worktree,
    state: {
      ifRevision: number;
      expectedWipOid: string;
      leaseEpoch: number;
    },
  ): Promise<IAppV2Worktree> {
    if (
      state.ifRevision !== this.current.revision ||
      state.expectedWipOid !== this.current.wipOid ||
      state.leaseEpoch !== this.current.leaseEpoch
    ) {
      throw new AppV2ConflictError("Stale in-memory lease");
    }
    const lease = await projectService.git.rotateLease(
      project.repositoryId,
      worktree.wipRef,
      worktree.wipOid,
      worktree.leaseRef,
      worktree.leaseOid,
      worktree.leaseEpoch + 1,
    );
    this.current.leaseOid = lease.oid;
    this.current.leaseEpoch = lease.epoch;
    this.current.revision += 1;
    return this.current;
  }
}

class MemorySessionStore implements AppV2SessionStore {
  record: AppV2SessionRecord | null = null;
  installBarrier?: () => Promise<void>;
  failRenewal = false;
  failNextConflictPersistence = false;
  failUpdates = false;
  readonly updates: Array<Partial<AppV2SessionRecord>> = [];

  async find(): Promise<AppV2SessionRecord | null> {
    return this.record ? { ...this.record } : null;
  }

  async listProject(): Promise<AppV2SessionRecord[]> {
    return this.record ? [{ ...this.record }] : [];
  }

  async listStaleProvisioning(): Promise<AppV2SessionRecord[]> {
    return this.record?.status === "provisioning" &&
      (!this.record.operationId ||
        !this.record.operationExpiresAt ||
        this.record.operationExpiresAt.getTime() <= Date.now())
      ? [{ ...this.record }]
      : [];
  }

  async reserve(
    record: NewAppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<AppV2SessionRecord> {
    if (this.failUpdates) {
      throw new Error("simulated session metadata outage");
    }
    if (this.record) {
      throw new AppV2OperationConflictError("Concurrent session reservation");
    }
    this.record = {
      ...record,
      id: new Types.ObjectId().toString(),
      generation: 0,
      operationId,
      operationExpiresAt: new Date(Date.now() + leaseMs),
    };
    return { ...this.record };
  }

  async acquireOperation(
    record: AppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<AppV2SessionRecord> {
    if (
      !this.record ||
      !this.matches(record, this.record) ||
      (this.record.operationId &&
        (!this.record.operationExpiresAt ||
          this.record.operationExpiresAt.getTime() > Date.now()))
    ) {
      throw new AppV2OperationConflictError("Concurrent session operation");
    }
    this.record = {
      ...this.record,
      operationId,
      operationExpiresAt: new Date(Date.now() + leaseMs),
    };
    return { ...this.record };
  }

  async renewOperation(
    record: AppV2SessionRecord,
    operationId: string,
    leaseMs: number,
  ): Promise<void> {
    if (
      this.failRenewal ||
      !this.record ||
      !this.sameIdentity(record, this.record) ||
      this.record.operationId !== operationId ||
      !this.record.operationExpiresAt ||
      this.record.operationExpiresAt.getTime() <= Date.now()
    ) {
      throw new AppV2OperationConflictError("Lease renewal failed");
    }
    this.record.operationExpiresAt = new Date(Date.now() + leaseMs);
  }

  async assertOperation(
    record: AppV2SessionRecord,
    operationId: string,
  ): Promise<void> {
    if (
      !this.record ||
      !this.sameIdentity(record, this.record) ||
      this.record.operationId !== operationId ||
      !this.record.operationExpiresAt ||
      this.record.operationExpiresAt.getTime() <= Date.now()
    ) {
      throw new AppV2OperationConflictError("Lease is not owned");
    }
  }

  async releaseOperation(
    record: AppV2SessionRecord,
    operationId: string,
  ): Promise<void> {
    if (
      this.record &&
      this.sameIdentity(record, this.record) &&
      this.record.operationId === operationId
    ) {
      const {
        operationId: _operationId,
        operationExpiresAt: _expiry,
        ...rest
      } = this.record;
      this.record = rest;
    }
  }

  async install(
    record: NewAppV2SessionRecord,
    expected: AppV2SessionRecord,
    operationId: string,
  ): Promise<AppV2SessionRecord> {
    await this.installBarrier?.();
    if (!this.record || !this.matches(expected, this.record)) {
      throw new AppV2ConflictError("Concurrent session replacement");
    }
    if (
      this.record.operationId !== operationId ||
      !this.record.operationExpiresAt ||
      this.record.operationExpiresAt.getTime() <= Date.now()
    ) {
      throw new AppV2OperationConflictError("Session operation was stolen");
    }
    this.record = {
      ...record,
      id: expected.id,
      generation: expected.generation + 1,
      operationId,
      operationExpiresAt: this.record.operationExpiresAt,
    };
    return { ...this.record };
  }

  async update(
    record: AppV2SessionRecord,
    changes: Partial<AppV2SessionRecord>,
    operationId: string,
  ): Promise<AppV2SessionRecord> {
    if (this.failUpdates) {
      throw new Error("simulated session metadata outage");
    }
    if (
      this.failNextConflictPersistence &&
      changes.status === "conflict" &&
      typeof changes.recoveryRef === "string"
    ) {
      this.failNextConflictPersistence = false;
      throw new Error("simulated crash before conflict metadata persistence");
    }
    if (!this.record || !this.matches(record, this.record)) {
      throw new AppV2ConflictError("Concurrent session update");
    }
    if (
      this.record.operationId !== operationId ||
      !this.record.operationExpiresAt ||
      this.record.operationExpiresAt.getTime() <= Date.now()
    ) {
      throw new AppV2OperationConflictError("Session operation was stolen");
    }
    this.updates.push({ ...changes });
    const next = {
      ...this.record,
      ...changes,
      generation: this.record.generation + 1,
    };
    if (changes.pendingRecoveryId === null) {
      delete next.pendingRecoveryId;
    }
    if (changes.pendingRecoveryCompleted === null) {
      delete next.pendingRecoveryCompleted;
    }
    if (changes.pendingExpectedWipOid === null) {
      delete next.pendingExpectedWipOid;
    }
    if (changes.pendingExpectedRevision === null) {
      delete next.pendingExpectedRevision;
    }
    if (changes.pendingSuccessRef === null) {
      delete next.pendingSuccessRef;
    }
    if (changes.recoveryRef === null) {
      delete next.recoveryRef;
    }
    this.record = next;
    return { ...this.record };
  }

  private matches(
    expected: AppV2SessionRecord,
    actual: AppV2SessionRecord,
  ): boolean {
    return (
      expected.id === actual.id &&
      expected.workspaceId === actual.workspaceId &&
      expected.projectId === actual.projectId &&
      expected.worktreeId === actual.worktreeId &&
      expected.actorId === actual.actorId &&
      expected.purpose === actual.purpose &&
      expected.sandboxId === actual.sandboxId &&
      expected.generation === actual.generation &&
      expected.leaseEpoch === actual.leaseEpoch &&
      expected.status === actual.status
    );
  }

  private sameIdentity(
    expected: AppV2SessionRecord,
    actual: AppV2SessionRecord,
  ): boolean {
    return (
      expected.id === actual.id &&
      expected.workspaceId === actual.workspaceId &&
      expected.projectId === actual.projectId &&
      expected.worktreeId === actual.worktreeId &&
      expected.actorId === actual.actorId &&
      expected.purpose === actual.purpose
    );
  }
}

let projectService: MemoryProjectService;

async function run(): Promise<void> {
  const capturedCreates: Array<Record<string, unknown>> = [];
  const capturedE2BCommands: Array<{
    command: string;
    options: {
      user?: string;
      envs?: Record<string, string>;
      onStdout?: (data: string) => Promise<void> | void;
    };
  }> = [];
  let e2bHandleKilled = false;
  let e2bConnectCalls = 0;
  let e2bPauseCalls = 0;
  let e2bKillCalls = 0;
  let capturedListMetadata: Record<string, string> | undefined;
  let failConformance = false;
  let recursiveEntries: EntryInfo[] = [];
  const directEntries = new Map<string, EntryInfo[]>();
  const e2bClient: E2BSandboxClient = {
    sandboxId: "e2b-fake",
    files: {
      async exists() {
        return false;
      },
      async remove() {},
      async makeDir() {
        return true;
      },
      async write() {},
      async list(listPath: string, options?: { depth?: number }) {
        return options?.depth === 100
          ? recursiveEntries
          : (directEntries.get(listPath) ?? []);
      },
      async read() {
        return new Uint8Array();
      },
    },
    commands: {
      async run(
        command: string,
        options: {
          background: true;
          cwd?: string;
          timeoutMs?: number;
          signal?: AbortSignal;
          user?: string;
          envs?: Record<string, string>;
          onStdout?: (data: string) => Promise<void> | void;
          onStderr?: (data: string) => Promise<void> | void;
        },
      ) {
        capturedE2BCommands.push({ command, options });
        if (command.includes("'printf'")) {
          await options.onStdout?.("123456789");
        }
        return {
          pid: capturedE2BCommands.length + 100,
          async wait() {
            if (failConformance && command.includes("id -u")) {
              throw new Error("nonconforming template");
            }
            return {
              exitCode: e2bHandleKilled ? 137 : 0,
              stdout: "",
              stderr: "",
            };
          },
          async kill() {
            e2bHandleKilled = true;
            return true;
          },
        };
      },
    },
    async updateNetwork() {},
  };
  const factory: E2BSandboxFactory = {
    async create(_templateId: string, options: Record<string, unknown>) {
      capturedCreates.push(options);
      return e2bClient;
    },
    async connect() {
      e2bConnectCalls += 1;
      return e2bClient;
    },
    async getInfo(): Promise<SandboxInfo> {
      return { state: "running" } as SandboxInfo;
    },
    async pause() {
      e2bPauseCalls += 1;
      return true;
    },
    async kill() {
      e2bKillCalls += 1;
      return true;
    },
    list(options) {
      capturedListMetadata = options.query.metadata;
      let hasNext = true;
      return {
        get hasNext() {
          return hasNext;
        },
        async nextItems() {
          hasNext = false;
          return [
            {
              sandboxId: "listed-by-reservation",
              state: "paused",
            } as SandboxInfo,
          ];
        },
      };
    },
  };
  const e2b = new E2BSandboxProvider(
    "control-plane-secret",
    "template-pinned",
    "mako",
    factory,
  );
  await e2b.create({
    workspaceId: "workspace",
    projectId: "project",
    worktreeId: "worktree",
    actorId: "actor",
    purpose: "dev",
    leaseEpoch: 1,
    durableRevision: { wipOid: "a".repeat(40), revision: 0 },
    labels: { reservationId: "reservation-label" },
    async onProvisioned() {},
  });
  const createOptions = capturedCreates[0] as {
    apiKey: string;
    envs: Record<string, string>;
    metadata: Record<string, string>;
    allowInternetAccess: boolean;
    network: {
      allowOut: string[];
      denyOut: string[];
      allowPublicTraffic: boolean;
    };
    lifecycle: { onTimeout: { action: string }; autoResume: boolean };
  };
  assert.equal(createOptions.apiKey, "control-plane-secret");
  assert.equal(
    Object.values(createOptions.envs).includes("control-plane-secret"),
    false,
  );
  assert.equal(
    JSON.stringify(createOptions.metadata).includes("control-plane-secret"),
    false,
  );
  assert.equal(createOptions.metadata.reservationId, "reservation-label");
  assert.deepEqual(createOptions.envs, {});
  assert.equal(createOptions.allowInternetAccess, false);
  assert.deepEqual(createOptions.network.allowOut, []);
  assert.deepEqual(createOptions.network.denyOut, ["0.0.0.0/0"]);
  assert.equal(createOptions.network.allowPublicTraffic, false);
  assert.equal(createOptions.lifecycle.onTimeout.action, "pause");
  assert.equal(createOptions.lifecycle.autoResume, false);
  const conformance = capturedE2BCommands[0];
  assert.match(conformance.command, /id -u/);
  assert.match(conformance.command, /169\.254\.169\.254/);
  assert.equal(conformance.options.user, "mako");
  assert.deepEqual(conformance.options.envs, {
    HOME: "/home/mako",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    BASH_ENV: "/dev/null",
  });
  assert.equal(
    JSON.stringify({
      command: conformance.command,
      envs: conformance.options.envs,
    }).includes("control-plane-secret"),
    false,
  );
  failConformance = true;
  await assert.rejects(
    e2b.create({
      workspaceId: "workspace",
      projectId: "project",
      worktreeId: "rejected-worktree",
      actorId: "actor",
      purpose: "dev",
      leaseEpoch: 1,
      durableRevision: { wipOid: "a".repeat(40), revision: 0 },
      labels: {},
      async onProvisioned() {},
    }),
    /failed Apps v2 conformance/,
  );
  assert.equal(e2bKillCalls, 1);
  failConformance = false;
  assert.deepEqual(
    await e2b.listByLabels({ reservationId: "reservation-query" }),
    [{ sandboxId: "listed-by-reservation", status: "paused" }],
  );
  assert.deepEqual(capturedListMetadata, {
    reservationId: "reservation-query",
  });
  assert.equal(
    e2bCommandForArgv(["printf", "%s", "$(touch /pwned)", "a'b"], "mako"),
    `exec env -i HOME='/home/mako' PATH='/usr/local/bin:/usr/bin:/bin' BASH_ENV='/dev/null' setsid --wait -- 'printf' '%s' '$(touch /pwned)' 'a'"'"'b'`,
  );
  const e2bExecution = await e2b.exec("e2b-fake", {
    argv: ["printf", "%s", "$(touch /pwned)", "a'b"],
    cwd: "/workspace",
    timeoutMs: 1_000,
    maxOutputBytes: 5,
  });
  assert.equal(
    capturedE2BCommands.find(entry => entry.command.includes("'printf'"))
      ?.command,
    `exec env -i HOME='/home/mako' PATH='/usr/local/bin:/usr/bin:/bin' BASH_ENV='/dev/null' setsid --wait -- 'printf' '%s' '$(touch /pwned)' 'a'"'"'b'`,
  );
  const tenantCommand = capturedE2BCommands.find(entry =>
    entry.command.includes("'printf'"),
  );
  assert.equal(tenantCommand?.options.user, "mako");
  assert.deepEqual(tenantCommand?.options.envs, {
    HOME: "/home/mako",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    BASH_ENV: "/dev/null",
  });
  assert.equal(e2bExecution.stdout, "12345");
  assert.equal(e2bExecution.outputTruncated, true);
  assert.equal(e2bHandleKilled, true);
  const connectsBeforeQuiesce = e2bConnectCalls;
  await e2b.quiesce("e2b-fake");
  assert.equal(e2bPauseCalls, 1);
  assert.equal(e2bConnectCalls, connectsBeforeQuiesce + 1);
  const entry = (
    entryPath: string,
    overrides: Partial<EntryInfo> = {},
  ): EntryInfo => ({
    name: entryPath.split("/").at(-1) ?? entryPath,
    path: entryPath,
    type: FileType.FILE,
    size: 0,
    mode: 0o100644,
    permissions: "rw-r--r--",
    owner: "mako",
    group: "mako",
    ...overrides,
  });
  const symlink = entry("/workspace/link", {
    symlinkTarget: "/etc/passwd",
  });
  recursiveEntries = [symlink];
  directEntries.set("/workspace", [symlink]);
  await assert.rejects(e2b.captureFiles("e2b-fake"), /contains a symlink/);
  recursiveEntries = [
    entry(`/workspace/${Array.from({ length: 65 }, () => "deep").join("/")}`),
  ];
  directEntries.set("/workspace", []);
  await assert.rejects(e2b.captureFiles("e2b-fake"), /64 segments/);
  recursiveEntries = [];
  directEntries.set("/workspace", [entry("/workspace/omitted.ts")]);
  await assert.rejects(
    e2b.captureFiles("e2b-fake"),
    /incomplete or inconsistent/,
  );
  directEntries.clear();

  const root = await mkdtemp(path.join(os.tmpdir(), "apps-v2-session-test-"));
  try {
    const git = new AppV2GitProvider(root, {
      maintenanceIntervalMs: 60_000,
    });
    const initial = await git.createRepository(
      "session-project",
      createAppV2Scaffold(),
    );
    const refs = await git.createWorktreeRef(
      "session-project",
      "session-worktree",
      initial.sha,
    );
    const project = {
      _id: new Types.ObjectId(),
      workspaceId: new Types.ObjectId(),
      repositoryId: "session-project",
      defaultBranch: "main",
      headSha: initial.sha,
      deletionStatus: "active",
    } as unknown as IAppV2Project;
    const worktree = {
      _id: new Types.ObjectId(),
      workspaceId: project.workspaceId,
      projectId: project._id,
      actorId: "actor",
      branch: "main",
      baseSha: initial.sha,
      wipRef: refs.wipRef,
      wipOid: refs.wipOid,
      leaseRef: refs.leaseRef,
      leaseOid: refs.leaseOid,
      revision: 0,
      leaseEpoch: 1,
      status: "active",
    } as unknown as IAppV2Worktree;
    projectService = new MemoryProjectService(git, project);
    const worktrees = new MemoryWorktreeService(
      projectService,
      project,
      worktree,
    );
    let conflictDuringCommand = false;
    let concurrentLease:
      | Awaited<ReturnType<AppV2GitProvider["rotateLease"]>>
      | undefined;
    const argv = ["tool", "$(touch /tmp/not-run)", "semi;colon", "a'b"];
    const sandboxes = new FakeSandboxProvider(async (state, spec) => {
      assert.deepEqual(spec.argv, argv);
      assert.equal(state.networkPhase, "deny-all");
      const app = state.files.get("src/App.tsx");
      assert(app);
      app.content = Buffer.from("export default function Changed() {}\n");
      state.files.set("src/new.ts", {
        path: "src/new.ts",
        content: Buffer.from("export const created = true;\n"),
        executable: false,
      });
      state.files.delete("README.md");
      for (const excludedPath of [
        ".env.local",
        "dist/bundle.js",
        "node_modules/pkg/index.js",
      ]) {
        state.files.set(excludedPath, {
          path: excludedPath,
          content: Buffer.from("must-not-flush"),
          executable: false,
        });
      }
      if (conflictDuringCommand) {
        concurrentLease = await git.rotateLease(
          project.repositoryId,
          worktree.wipRef,
          worktree.wipOid,
          worktree.leaseRef,
          worktree.leaseOid,
          worktree.leaseEpoch + 1,
        );
      }
      return { exitCode: 17, stdout: "command output", stderr: "failed" };
    });
    const executor = new CloudSessionExecutor(
      sandboxes,
      projectService,
      worktrees,
    );
    const initialTarget = {
      workspaceId: project.workspaceId.toString(),
      projectId: project._id.toString(),
      worktreeId: worktree._id.toString(),
      actorId: "actor",
      purpose: "dev" as const,
      leaseEpoch: 1,
      durableRevision: { wipOid: initial.sha, revision: 0 },
    };
    const prepared = await executor.prepare(initialTarget, {
      reservationId: "initial-reservation",
      signal: new AbortController().signal,
      async onProvisioned() {},
    });
    const exactTree = await git.tree(project.repositoryId, initial.sha);
    assert.deepEqual(
      [...sandboxes.state(prepared.sandboxId).files.keys()].sort(),
      exactTree.map(entry => entry.path).sort(),
    );
    assert.deepEqual(sandboxes.createSpecs[0].durableRevision, {
      wipOid: initial.sha,
      revision: 0,
    });

    const result = await executor.exec(
      {
        ...initialTarget,
        sandboxId: prepared.sandboxId,
        appliedWipOid: initial.sha,
      },
      { argv, cwd: "/workspace", timeoutMs: 1_000 },
    );
    assert.equal(result.exitCode, 17);
    assert.equal(result.stdout, "command output");
    assert.equal(result.durability.status, "durable");
    assert.equal(worktree.revision, 1);
    assert.equal(sandboxes.state(prepared.sandboxId).quiesceCount, 1);
    assert.equal(sandboxes.state(prepared.sandboxId).captureCount, 1);
    assert.equal(sandboxes.state(prepared.sandboxId).networkPhase, "deny-all");
    assert.deepEqual(result.excludedPaths, [
      ".env.local",
      "dist/bundle.js",
      "node_modules/pkg/index.js",
    ]);
    const flushedPaths = (await git.tree(project.repositoryId, worktree.wipOid))
      .map(entry => entry.path)
      .sort();
    assert(flushedPaths.includes("src/new.ts"));
    assert(!flushedPaths.includes("README.md"));
    assert(!flushedPaths.includes(".env.local"));
    assert(!flushedPaths.includes("dist/bundle.js"));
    assert(!flushedPaths.includes("node_modules/pkg/index.js"));
    assert.equal(
      (
        await git.readFile(project.repositoryId, worktree.wipOid, "src/App.tsx")
      ).content.toString(),
      "export default function Changed() {}\n",
    );

    const staleWipOid = initial.sha;
    await assert.rejects(
      git.replaceWorktreeTree(
        project.repositoryId,
        worktree.wipRef,
        staleWipOid,
        worktree.baseSha,
        worktree.leaseRef,
        worktree.leaseOid,
        [],
      ),
      AppV2ConflictError,
    );

    const conflictPrepared = await executor.prepare(
      {
        ...initialTarget,
        leaseEpoch: worktree.leaseEpoch,
        durableRevision: {
          wipOid: worktree.wipOid,
          revision: worktree.revision,
        },
      },
      {
        reservationId: "conflict-reservation",
        signal: new AbortController().signal,
        async onProvisioned() {},
      },
    );
    const conflictTarget = {
      ...initialTarget,
      sandboxId: conflictPrepared.sandboxId,
      leaseEpoch: worktree.leaseEpoch,
      durableRevision: {
        wipOid: worktree.wipOid,
        revision: worktree.revision,
      },
      appliedWipOid: worktree.wipOid,
      recoveryId: "b".repeat(64),
    };
    conflictDuringCommand = true;
    const conflict = await executor.exec(conflictTarget, {
      argv,
      cwd: "/workspace",
      timeoutMs: 1_000,
    });
    assert.equal(conflict.stdout, "command output");
    assert.equal(conflict.durability.status, "conflict");
    assert.equal(conflict.durability.revision, undefined);
    assert.equal(
      conflict.durability.recoveryRef,
      `refs/mako/recovery/session-worktree/${"b".repeat(64)}`,
    );
    assert.equal(
      await git.findRecoveryRef(
        project.repositoryId,
        "session-worktree",
        "b".repeat(64),
      ),
      conflict.durability.recoveryRef,
    );
    assert.equal(
      await git.findRecoveryRef(
        project.repositoryId,
        "session-worktree",
        "c".repeat(64),
      ),
      null,
    );
    assert.equal(
      await git.findSuccessMarker(
        project.repositoryId,
        "session-worktree",
        "b".repeat(64),
      ),
      null,
    );
    const recoveredPaths = (
      await git.tree(
        project.repositoryId,
        conflict.durability.recoveryRef ?? "",
      )
    ).map(entry => entry.path);
    assert(recoveredPaths.includes("src/new.ts"));
    assert(concurrentLease);
    worktree.leaseOid = concurrentLease.oid;
    worktree.leaseEpoch = concurrentLease.epoch;
    worktree.revision += 1;

    const capped = new FakeSandboxProvider(() => ({
      exitCode: 0,
      stdout: "123456789",
    }));
    const cappedId = (await capped.create(sandboxes.createSpecs[0])).sandboxId;
    const cappedResult = await capped.exec(cappedId, {
      argv: ["echo"],
      cwd: "/workspace",
      timeoutMs: 1_000,
      maxOutputBytes: 5,
    });
    assert.equal(cappedResult.stdout, "12345");
    assert.equal(cappedResult.outputTruncated, true);
    await capped.setNetworkPhase(cappedId, "install");
    assert.equal(capped.state(cappedId).networkPhase, "install");
    await capped.setNetworkPhase(cappedId, "deny-all");
    assert.equal(capped.state(cappedId).networkPhase, "deny-all");

    const hanging = new FakeSandboxProvider(() => new Promise(() => undefined));
    const hangingId = (await hanging.create(sandboxes.createSpecs[0]))
      .sandboxId;
    const timedOut = await hanging.exec(hangingId, {
      argv: ["hang"],
      cwd: "/workspace",
      timeoutMs: 5,
      maxOutputBytes: 100,
    });
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.exitCode, null);
    const cancellation = new AbortController();
    setTimeout(() => cancellation.abort(), 5).unref();
    const cancelled = await hanging.exec(hangingId, {
      argv: ["hang"],
      cwd: "/workspace",
      timeoutMs: 1_000,
      maxOutputBytes: 100,
      signal: cancellation.signal,
    });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.timedOut, false);

    let timeoutSandboxId = "";
    const timeoutSandboxes = new FakeSandboxProvider(() => {
      timeoutSandboxes.scheduleTenantWrite(timeoutSandboxId, 25, state => {
        state.files.set("late-write.ts", {
          path: "late-write.ts",
          content: Buffer.from("late"),
          executable: false,
        });
      });
      return new Promise(() => undefined);
    });
    const timeoutExecutor = new CloudSessionExecutor(
      timeoutSandboxes,
      projectService,
      worktrees,
    );
    const timeoutTargetBase = {
      ...initialTarget,
      leaseEpoch: worktree.leaseEpoch,
      durableRevision: {
        wipOid: worktree.wipOid,
        revision: worktree.revision,
      },
    };
    const timeoutPrepared = await timeoutExecutor.prepare(timeoutTargetBase, {
      reservationId: "timeout-reservation",
      signal: new AbortController().signal,
      async onProvisioned() {},
    });
    timeoutSandboxId = timeoutPrepared.sandboxId;
    const timeoutResult = await timeoutExecutor.exec(
      {
        ...timeoutTargetBase,
        sandboxId: timeoutSandboxId,
        appliedWipOid: worktree.wipOid,
      },
      { argv: ["hang"], cwd: "/workspace", timeoutMs: 5 },
    );
    assert.equal(timeoutResult.timedOut, true);
    assert.equal(timeoutResult.durability.status, "durable");
    assert.equal(timeoutSandboxes.state(timeoutSandboxId).quiesceCount, 1);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(
      timeoutSandboxes.state(timeoutSandboxId).files.has("late-write.ts"),
      false,
    );
    assert.equal(
      (await git.tree(project.repositoryId, worktree.wipOid)).some(
        entry => entry.path === "late-write.ts",
      ),
      false,
    );

    const sessionStore = new MemorySessionStore();
    sessionStore.record = {
      id: new Types.ObjectId().toString(),
      workspaceId: project.workspaceId.toString(),
      projectId: project._id.toString(),
      worktreeId: worktree._id.toString(),
      actorId: "actor",
      purpose: "dev",
      provider: "fake",
      sandboxId: "old-sandbox",
      reservationId: "old-reservation",
      generation: 0,
      leaseEpoch: conflictTarget.leaseEpoch,
      appliedWipOid: conflictTarget.durableRevision.wipOid,
      status: "active",
      lastActiveAt: new Date(),
    };
    const fakeExecutor = new FakeSessionExecutor();
    fakeExecutor.statuses.set("old-sandbox", "missing");
    const sessions = new AppV2SessionService(
      "fake",
      fakeExecutor,
      worktrees,
      sessionStore,
    );
    const beforeReplacementEpoch = worktree.leaseEpoch;
    const beforeReplacementLeaseOid = worktree.leaseOid;
    const ensured = await sessions.ensure(project, worktree, {
      userId: "actor",
    });
    assert.equal(ensured.worktree.leaseEpoch, beforeReplacementEpoch + 1);
    assert.equal(fakeExecutor.killed[0].sandboxId, "old-sandbox");
    assert.equal(fakeExecutor.prepared.length, 1);
    assert.equal(
      fakeExecutor.prepared[0].leaseEpoch,
      beforeReplacementEpoch + 1,
    );
    await assert.rejects(
      git.replaceWorktreeTree(
        project.repositoryId,
        worktree.wipRef,
        worktree.wipOid,
        worktree.baseSha,
        worktree.leaseRef,
        beforeReplacementLeaseOid,
        [],
      ),
      AppV2ConflictError,
    );

    const raceStore = new MemorySessionStore();
    const raceExecutor = new FakeSessionExecutor();
    const raceActor = { userId: "race-actor" };
    const raceServices = [new AppV2KeyedMutex(), new AppV2KeyedMutex()].map(
      mutex =>
        new AppV2SessionService(
          "fake",
          raceExecutor,
          worktrees,
          raceStore,
          mutex,
        ),
    );
    const raceResults = await Promise.allSettled(
      raceServices.map(service => service.ensure(project, worktree, raceActor)),
    );
    assert.equal(
      raceResults.filter(result => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      raceResults.filter(result => result.status === "rejected").length,
      1,
    );
    assert.equal(raceExecutor.prepared.length, 1);
    assert.equal(raceExecutor.killed.length, 0);

    const heldStore = new MemorySessionStore();
    heldStore.record = {
      ...(raceStore.record as AppV2SessionRecord),
      operationId: "held-operation",
      operationExpiresAt: new Date(Date.now() + 60_000),
    };
    const heldExecutor = new FakeSessionExecutor();
    const heldService = new AppV2SessionService(
      "fake",
      heldExecutor,
      worktrees,
      heldStore,
      new AppV2KeyedMutex(),
    );
    await assert.rejects(
      heldService.ensure(project, worktree, raceActor),
      error => error instanceof AppV2OperationConflictError && error.retryable,
    );
    assert.equal(heldExecutor.prepared.length, 0);
    assert.equal(heldExecutor.killed.length, 0);

    class BlockingExecExecutor extends FakeSessionExecutor {
      readonly started = new Promise<void>(resolve => {
        this.resolveStarted = resolve;
      });
      readonly released = new Promise<void>(resolve => {
        this.resolveReleased = resolve;
      });
      private resolveStarted!: () => void;
      private resolveReleased!: () => void;

      release(): void {
        this.resolveReleased();
      }

      override async exec(
        target: Parameters<FakeSessionExecutor["exec"]>[0],
        request: Parameters<FakeSessionExecutor["exec"]>[1],
      ): ReturnType<FakeSessionExecutor["exec"]> {
        this.resolveStarted();
        await this.released;
        return super.exec(target, request);
      }
    }

    const concurrentExecStore = new MemorySessionStore();
    concurrentExecStore.record = {
      ...(raceStore.record as AppV2SessionRecord),
    };
    const blockingExecutor = new BlockingExecExecutor();
    const concurrentExecServices = [
      new AppV2KeyedMutex(),
      new AppV2KeyedMutex(),
    ].map(
      mutex =>
        new AppV2SessionService(
          "fake",
          blockingExecutor,
          worktrees,
          concurrentExecStore,
          mutex,
        ),
    );
    const execRequest = {
      argv: ["true"],
      cwd: "/workspace",
      timeoutMs: 1_000,
    };
    const firstExec = concurrentExecServices[0].exec(
      project,
      worktree,
      raceActor,
      execRequest,
    );
    await blockingExecutor.started;
    await assert.rejects(
      concurrentExecServices[1].exec(project, worktree, raceActor, execRequest),
      AppV2OperationConflictError,
    );
    assert.equal(blockingExecutor.executions.length, 0);
    blockingExecutor.release();
    await firstExec;
    assert.equal(blockingExecutor.executions.length, 1);
    assert.equal(concurrentExecStore.record?.operationId, undefined);

    class RenewingRaceExecutor extends FakeSessionExecutor {
      readonly firstPrepared = new Promise<void>(resolve => {
        this.resolveFirstPrepared = resolve;
      });
      readonly releaseFirst = new Promise<void>(resolve => {
        this.resolveReleaseFirst = resolve;
      });
      private resolveFirstPrepared!: () => void;
      private resolveReleaseFirst!: () => void;

      release(): void {
        this.resolveReleaseFirst();
      }

      override async prepare(
        target: Parameters<FakeSessionExecutor["prepare"]>[0],
        options: Parameters<FakeSessionExecutor["prepare"]>[1],
      ): ReturnType<FakeSessionExecutor["prepare"]> {
        const prepared = await super.prepare(target, options);
        if (this.prepared.length === 1) {
          this.resolveFirstPrepared();
          await this.releaseFirst;
        }
        return prepared;
      }
    }

    const stealStore = new MemorySessionStore();
    const stealExecutor = new RenewingRaceExecutor();
    const stealServices = [new AppV2KeyedMutex(), new AppV2KeyedMutex()].map(
      mutex =>
        new AppV2SessionService(
          "fake",
          stealExecutor,
          worktrees,
          stealStore,
          mutex,
          30,
        ),
    );
    const firstEnsure = stealServices[0].ensure(project, worktree, {
      userId: "steal-actor",
    });
    await stealExecutor.firstPrepared;
    await new Promise(resolve => setTimeout(resolve, 75));
    await assert.rejects(
      stealServices[1].ensure(project, worktree, {
        userId: "steal-actor",
      }),
      AppV2OperationConflictError,
    );
    stealExecutor.release();
    const renewedEnsure = await firstEnsure;
    assert.equal(stealExecutor.prepared.length, 1);
    assert.equal(stealExecutor.killed.length, 0);
    assert.equal(renewedEnsure.session.sandboxId, "fake-session-1");
    assert.equal(stealStore.record?.sandboxId, "fake-session-1");

    class RenewalFailureExecutor extends FakeSessionExecutor {
      providerReturned = false;

      override async exec(
        target: Parameters<FakeSessionExecutor["exec"]>[0],
        request: Parameters<FakeSessionExecutor["exec"]>[1],
      ): ReturnType<FakeSessionExecutor["exec"]> {
        await new Promise<void>(resolve => {
          if (request.signal?.aborted) {
            resolve();
            return;
          }
          request.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        this.providerReturned = true;
        return {
          exitCode: 0,
          stdout: "must not be acknowledged",
          stderr: "",
          timedOut: false,
          cancelled: true,
          outputTruncated: false,
          excludedPaths: [],
          durability: {
            status: "durable",
            revision: target.durableRevision,
          },
        };
      }
    }

    const renewalFailureStore = new MemorySessionStore();
    renewalFailureStore.record = {
      ...(raceStore.record as AppV2SessionRecord),
    };
    renewalFailureStore.failRenewal = true;
    const renewalFailureExecutor = new RenewalFailureExecutor();
    const renewalFailureService = new AppV2SessionService(
      "fake",
      renewalFailureExecutor,
      worktrees,
      renewalFailureStore,
      new AppV2KeyedMutex(),
      30,
    );
    const originalAppliedWipOid = renewalFailureStore.record.appliedWipOid;
    await assert.rejects(
      renewalFailureService.exec(project, worktree, raceActor, execRequest),
      AppV2OperationConflictError,
    );
    assert.equal(renewalFailureExecutor.providerReturned, true);
    assert.equal(
      renewalFailureStore.record?.appliedWipOid,
      originalAppliedWipOid,
    );
    assert(renewalFailureStore.record?.pendingRecoveryId);
    assert.equal(renewalFailureStore.record?.pendingRecoveryCompleted, false);
    assert.equal(renewalFailureStore.record?.operationId, undefined);
    await assert.rejects(
      renewalFailureService.get(project, worktree, raceActor),
      /recovery reconciliation is still pending/,
    );
    assert(renewalFailureStore.record?.pendingRecoveryId);

    const orphanReservationId = "orphan-reservation";
    const orphanActor = { userId: "orphan-actor" };
    assert(worktree.leaseEpoch > 1);
    const staleReservationLeaseEpoch = worktree.leaseEpoch - 1;
    const orphan = await sandboxes.create({
      workspaceId: project.workspaceId.toString(),
      projectId: project._id.toString(),
      worktreeId: worktree._id.toString(),
      actorId: orphanActor.userId,
      purpose: "dev",
      leaseEpoch: staleReservationLeaseEpoch,
      durableRevision: {
        wipOid: worktree.wipOid,
        revision: worktree.revision,
      },
      labels: {
        managedBy: "mako-apps-v2",
        reservationId: orphanReservationId,
      },
      async onProvisioned() {
        // Simulate process death before Mongo learns the sandbox ID.
      },
    });
    const orphanStore = new MemorySessionStore();
    orphanStore.record = {
      id: new Types.ObjectId().toString(),
      workspaceId: project.workspaceId.toString(),
      projectId: project._id.toString(),
      worktreeId: worktree._id.toString(),
      actorId: orphanActor.userId,
      purpose: "dev",
      provider: "fake",
      sandboxId: `reservation:${orphanReservationId}`,
      reservationId: orphanReservationId,
      generation: 0,
      leaseEpoch: staleReservationLeaseEpoch,
      appliedWipOid: worktree.wipOid,
      status: "provisioning",
      lastActiveAt: new Date(),
    };
    const orphanService = new AppV2SessionService(
      "fake",
      executor,
      worktrees,
      orphanStore,
      new AppV2KeyedMutex(),
      30,
    );
    const recoveredProvisioning = await orphanService.ensure(
      project,
      worktree,
      orphanActor,
    );
    assert.equal(await sandboxes.status(orphan.sandboxId), "missing");
    assert.equal(recoveredProvisioning.session.status, "active");
    assert.equal(recoveredProvisioning.session.leaseEpoch, worktree.leaseEpoch);
    assert(
      orphanStore.updates.some(update => update.reservationCleaned === true),
    );
    assert.notEqual(
      recoveredProvisioning.session.reservationId,
      orphanReservationId,
    );
    assert.equal(
      sandboxes.createSpecs.at(-1)?.labels.reservationId,
      recoveredProvisioning.session.reservationId,
    );

    const successActor = { userId: "success-crash-actor" };
    const successStore = new MemorySessionStore();
    const successSessions = new AppV2SessionService(
      "fake",
      executor,
      worktrees,
      successStore,
      new AppV2KeyedMutex(),
      30,
    );
    const successSession = await successSessions.ensure(
      project,
      worktree,
      successActor,
    );
    sandboxes
      .state(successSession.session.sandboxId)
      .files.set("successful-cas.ts", {
        path: "successful-cas.ts",
        content: Buffer.from("export const recovered = true;\n"),
        executable: false,
      });
    const preSuccessWipOid = worktree.wipOid;
    worktrees.afterNextGitCas = () => {
      successStore.failUpdates = true;
      throw new Error("simulated crash immediately after successful Git CAS");
    };
    await assert.rejects(
      successSessions.flush(project, worktree, successActor),
      /immediately after successful Git CAS/,
    );
    assert.equal(worktree.wipOid, preSuccessWipOid);
    assert(successStore.record?.pendingRecoveryId);
    assert(successStore.record?.pendingExpectedWipOid);
    assert(successStore.record?.pendingSuccessRef);
    const successfulRecoveryId = successStore.record.pendingRecoveryId;
    const authoritativeSuccessOid = await git.resolveRef(
      project.repositoryId,
      worktree.wipRef,
    );
    assert.notEqual(authoritativeSuccessOid, preSuccessWipOid);
    assert.equal(
      (
        await git.findSuccessMarker(
          project.repositoryId,
          worktree._id.toString(),
          successfulRecoveryId,
        )
      )?.oid,
      authoritativeSuccessOid,
    );
    successStore.failUpdates = false;
    const recoveredSuccess = await successSessions.get(
      project,
      worktree,
      successActor,
    );
    assert.equal(recoveredSuccess.status, "active");
    assert.equal(recoveredSuccess.appliedWipOid, authoritativeSuccessOid);
    assert.equal(recoveredSuccess.pendingRecoveryId, undefined);
    assert.equal(worktree.wipOid, authoritativeSuccessOid);
    assert.equal(
      await git.findSuccessMarker(
        project.repositoryId,
        worktree._id.toString(),
        successfulRecoveryId,
      ),
      null,
    );

    class CrashWindowExecutor extends FakeSessionExecutor {
      override async flush(
        target: Parameters<FakeSessionExecutor["flush"]>[0],
      ): ReturnType<FakeSessionExecutor["flush"]> {
        this.flushed.push(target);
        assert(target.recoveryId);
        const recoveryRef = `refs/mako/recovery/${target.worktreeId}/${target.recoveryId}`;
        this.recoveryRefs.set(target.recoveryId, recoveryRef);
        return {
          excludedPaths: [],
          durability: { status: "conflict", recoveryRef },
        };
      }
    }

    const crashStore = new MemorySessionStore();
    crashStore.record = {
      ...(raceStore.record as AppV2SessionRecord),
      actorId: "crash-actor",
      sandboxId: "crash-sandbox",
      reservationId: "crash-reservation",
      leaseEpoch: worktree.leaseEpoch,
      appliedWipOid: worktree.wipOid,
      status: "active",
    };
    crashStore.failNextConflictPersistence = true;
    const crashExecutor = new CrashWindowExecutor();
    const crashSessions = new AppV2SessionService(
      "fake",
      crashExecutor,
      worktrees,
      crashStore,
    );
    await assert.rejects(
      crashSessions.flush(project, worktree, {
        userId: "crash-actor",
      }),
      /simulated crash before conflict metadata persistence/,
    );
    assert(crashStore.record.pendingRecoveryId);
    assert.equal(crashStore.record.recoveryRef, undefined);
    const crashRecovered = await crashSessions.get(project, worktree, {
      userId: "crash-actor",
    });
    assert.equal(crashRecovered.status, "conflict");
    assert.equal(
      crashRecovered.recoveryRef,
      `refs/mako/recovery/${worktree._id.toString()}/${crashExecutor.flushed[0].recoveryId}`,
    );
    assert.equal(crashRecovered.pendingRecoveryId, undefined);
    assert.equal(crashExecutor.flushed.length, 1);

    const conflictStore = new MemorySessionStore();
    conflictStore.record = {
      ...(raceStore.record as AppV2SessionRecord),
      actorId: "actor",
      sandboxId: "flush-conflict",
      reservationId: "conflict-reservation",
      leaseEpoch: worktree.leaseEpoch,
      appliedWipOid: worktree.wipOid,
      status: "active",
    };
    const conflictExecutor = new FakeSessionExecutor();
    const retainedRecoveryRef = `refs/mako/recovery/${worktree._id.toString()}/retained`;
    conflictExecutor.nextFlush = {
      excludedPaths: [],
      durability: {
        status: "conflict",
        recoveryRef: retainedRecoveryRef,
      },
    };
    const conflictSessions = new AppV2SessionService(
      "fake",
      conflictExecutor,
      worktrees,
      conflictStore,
    );
    const responseLost = await conflictSessions.flush(project, worktree, {
      userId: "actor",
    });
    assert.equal(responseLost.session.status, "conflict");
    assert.equal(responseLost.session.recoveryRef, retainedRecoveryRef);
    const recovered = await conflictSessions.get(project, worktree, {
      userId: "actor",
    });
    assert.equal(recovered.status, "conflict");
    assert.equal(recovered.recoveryRef, retainedRecoveryRef);
    const providerCallsBeforeBlockedRetries = conflictExecutor.flushed.length;
    await assert.rejects(
      conflictSessions.flush(project, worktree, { userId: "actor" }),
      AppV2RecoveryConflictError,
    );
    await assert.rejects(
      conflictSessions.exec(
        project,
        worktree,
        { userId: "actor" },
        { argv: ["true"], cwd: "/workspace", timeoutMs: 1_000 },
      ),
      AppV2RecoveryConflictError,
    );
    await assert.rejects(
      conflictSessions.ensure(project, worktree, { userId: "actor" }),
      AppV2RecoveryConflictError,
    );
    assert.equal(
      conflictExecutor.flushed.length,
      providerCallsBeforeBlockedRetries,
    );
    assert.equal(conflictExecutor.executions.length, 0);
    assert.equal(conflictExecutor.prepared.length, 0);

    const retainedPause = await conflictSessions.pause(project, worktree, {
      userId: "actor",
    });
    assert.equal(retainedPause.session.status, "conflict");
    assert.equal(retainedPause.session.recoveryRef, retainedRecoveryRef);
    assert.equal(conflictExecutor.paused.length, 1);

    const destroyed = await conflictSessions.destroy(project, worktree, {
      userId: "actor",
    });
    assert.equal(destroyed.session.status, "destroyed");
    assert.equal(destroyed.session.recoveryRef, retainedRecoveryRef);
    assert.equal(conflictExecutor.killed.length, 1);
    assert.equal(conflictStore.record?.recoveryRef, retainedRecoveryRef);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void run().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
