import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAppV2SessionFileEligible } from "../session-files";
import {
  validateAppV2GitBranch,
  validateAppV2GitOid,
} from "../providers/git-provider";
import type {
  AppV2NetworkPhase,
  SandboxCapture,
  SandboxCreateSpec,
  SandboxExecResult,
  SandboxExecSpec,
  SandboxFile,
  SandboxHandle,
  SandboxProvider,
  SandboxRepositoryMaterialization,
  SandboxRepositorySnapshot,
  SandboxStatus,
} from "../providers/sandbox-provider";

export interface FakeSandboxState {
  labels: Record<string, string>;
  files: Map<string, SandboxFile>;
  networkPhase: AppV2NetworkPhase;
  networkPhases: AppV2NetworkPhase[];
  status: SandboxStatus;
  quiesceCount: number;
  captureCount: number;
  pendingTenantTimers: Set<NodeJS.Timeout>;
  repositoryPath?: string;
  repositoryMaterializations: SandboxRepositoryMaterialization[];
}

export type FakeCommandHandler = (
  state: FakeSandboxState,
  spec: SandboxExecSpec,
) => Promise<Partial<SandboxExecResult>> | Partial<SandboxExecResult>;

function truncateOutput(
  stdout: string,
  stderr: string,
  maxBytes: number,
): { stdout: string; stderr: string; outputTruncated: boolean } {
  const output = Buffer.from(stdout + stderr, "utf8");
  if (output.byteLength <= maxBytes) {
    return { stdout, stderr, outputTruncated: false };
  }
  const bounded = output.subarray(0, maxBytes).toString("utf8");
  const stdoutBytes = Buffer.byteLength(stdout, "utf8");
  if (stdoutBytes >= maxBytes) {
    return { stdout: bounded, stderr: "", outputTruncated: true };
  }
  return {
    stdout,
    stderr: bounded.slice(stdout.length),
    outputTruncated: true,
  };
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly name = "fake";
  readonly createSpecs: SandboxCreateSpec[] = [];
  readonly executions: SandboxExecSpec[] = [];
  readonly states = new Map<string, FakeSandboxState>();

  constructor(private readonly commandHandler?: FakeCommandHandler) {}

  async create(spec: SandboxCreateSpec): Promise<SandboxHandle> {
    spec.signal?.throwIfAborted();
    const sandboxId = `fake-${randomUUID()}`;
    this.createSpecs.push({
      ...spec,
      labels: {
        ...spec.labels,
        workspaceId: spec.workspaceId,
        projectId: spec.projectId,
        worktreeId: spec.worktreeId,
        actorId: spec.actorId,
        purpose: spec.purpose,
        leaseEpoch: String(spec.leaseEpoch),
        wipOid: spec.durableRevision.wipOid,
      },
      durableRevision: { ...spec.durableRevision },
    });
    this.states.set(sandboxId, {
      labels: {
        ...spec.labels,
        workspaceId: spec.workspaceId,
        projectId: spec.projectId,
        worktreeId: spec.worktreeId,
        actorId: spec.actorId,
        purpose: spec.purpose,
        leaseEpoch: String(spec.leaseEpoch),
        wipOid: spec.durableRevision.wipOid,
      },
      files: new Map(),
      networkPhase: "deny-all",
      networkPhases: ["deny-all"],
      status: "running",
      quiesceCount: 0,
      captureCount: 0,
      pendingTenantTimers: new Set(),
      repositoryMaterializations: [],
    });
    try {
      await spec.onProvisioned(sandboxId);
      spec.signal?.throwIfAborted();
    } catch (error) {
      await this.kill(sandboxId);
      throw error;
    }
    return { sandboxId, status: "running" };
  }

  async listByLabels(
    labels: Readonly<Record<string, string>>,
  ): Promise<SandboxHandle[]> {
    return [...this.states]
      .filter(
        ([, state]) =>
          state.status !== "missing" &&
          Object.entries(labels).every(
            ([key, value]) => state.labels[key] === value,
          ),
      )
      .map(([sandboxId, state]) => ({ sandboxId, status: state.status }));
  }

  /**
   * Explicit file-only test fixture path. Production providers intentionally
   * expose only credential-free Git repository materialization.
   */
  async materializeFilesForTest(
    sandboxId: string,
    files: readonly SandboxFile[],
  ): Promise<void> {
    const state = this.requireState(sandboxId);
    state.files = new Map(
      files.map(file => [
        file.path,
        { ...file, content: Uint8Array.from(file.content) },
      ]),
    );
  }

  async materializeRepository(
    sandboxId: string,
    snapshot: SandboxRepositorySnapshot,
    materialization: SandboxRepositoryMaterialization,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const state = this.requireState(sandboxId);
    const branch = validateAppV2GitBranch(snapshot.branch);
    const branchHead = validateAppV2GitOid(snapshot.branchHead);
    const wipOid = validateAppV2GitOid(snapshot.wipOid);
    const root =
      state.repositoryPath === undefined
        ? await mkdtemp(path.join(os.tmpdir(), "mako-fake-sandbox-"))
        : path.dirname(state.repositoryPath);
    const repositoryPath = path.join(root, "workspace");
    const bundlePath = path.join(root, `controller-${randomUUID()}.bundle`);
    const retained = [...state.files.entries()].filter(([filePath]) => {
      try {
        return !isAppV2SessionFileEligible(filePath);
      } catch {
        return false;
      }
    });
    let sourceEquivalent = false;
    await writeFile(bundlePath, snapshot.bundle);
    try {
      if (materialization === "fresh" || state.repositoryPath === undefined) {
        await rm(repositoryPath, { recursive: true, force: true });
        await this.runLocalGit(
          [
            "clone",
            "--no-checkout",
            "--no-hardlinks",
            "--origin",
            "origin",
            "--",
            bundlePath,
            repositoryPath,
          ],
          root,
        );
      } else {
        await this.runLocalGit(
          [
            "fetch",
            "--force",
            "--no-tags",
            "--no-write-fetch-head",
            "--",
            bundlePath,
            "+refs/heads/*:refs/mako/controller/heads/*",
            "+refs/mako/worktrees/*:refs/mako/controller/worktrees/*",
          ],
          repositoryPath,
        );
        const [currentBranch, currentIndexTree, incomingWipTree] =
          await Promise.all([
            this.runLocalGit(
              ["symbolic-ref", "--quiet", "--short", "HEAD"],
              repositoryPath,
            ),
            this.runLocalGit(["write-tree"], repositoryPath),
            this.runLocalGit(
              ["rev-parse", "--verify", `${wipOid}^{tree}`],
              repositoryPath,
            ),
          ]);
        sourceEquivalent =
          currentBranch.stdout?.trim() === branch &&
          currentIndexTree.stdout?.trim() === incomingWipTree.stdout?.trim();
        if (!sourceEquivalent) {
          await this.runLocalGit(["reset", "--hard"], repositoryPath);
          await this.runLocalGit(
            [
              "clean",
              "-ffdx",
              "-e",
              "node_modules/",
              "-e",
              "dist/",
              "-e",
              ".cache/",
              "-e",
              ".pnpm-store/",
              "-e",
              ".turbo/",
              "-e",
              ".vite/",
              "-e",
              "coverage/",
            ],
            repositoryPath,
          );
        }
      }
      await this.runLocalGit(
        [
          "remote",
          "set-url",
          "origin",
          "https://apps-v2.mako.invalid/blocked.git",
        ],
        repositoryPath,
      );
      if (sourceEquivalent) {
        await this.runLocalGit(["reset", "--soft", branchHead], repositoryPath);
      } else {
        await this.runLocalGit(
          ["checkout", "-B", branch, branchHead],
          repositoryPath,
        );
        await this.runLocalGit(["reset", "--hard", branchHead], repositoryPath);
        await this.runLocalGit(
          ["read-tree", "--reset", "-u", `${wipOid}^{tree}`],
          repositoryPath,
        );
      }
      state.repositoryPath = repositoryPath;
      state.repositoryMaterializations.push(materialization);
      state.files = await this.readLocalFiles(repositoryPath);
      if (materialization === "update") {
        for (const [filePath, file] of retained) {
          state.files.set(filePath, file);
        }
      }
    } finally {
      await rm(bundlePath, { force: true });
    }
  }

  async captureFiles(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<SandboxCapture> {
    signal?.throwIfAborted();
    const state = this.requireState(sandboxId);
    if (state.status !== "running" || state.quiesceCount < 1) {
      throw new Error("Sandbox must be quiesced before capture");
    }
    state.captureCount += 1;
    const files: SandboxFile[] = [];
    const excludedPaths: string[] = [];
    for (const file of state.files.values()) {
      if (!isAppV2SessionFileEligible(file.path)) {
        excludedPaths.push(file.path);
      } else {
        files.push({ ...file, content: Uint8Array.from(file.content) });
      }
    }
    return { files, excludedPaths: excludedPaths.sort() };
  }

  async exec(
    sandboxId: string,
    spec: SandboxExecSpec,
  ): Promise<SandboxExecResult> {
    const state = this.requireState(sandboxId);
    this.executions.push({ ...spec, argv: [...spec.argv] });
    if (spec.signal?.aborted) {
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: true,
        outputTruncated: false,
      };
    }
    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const timeout = new Promise<Partial<SandboxExecResult>>(resolve => {
      timer = setTimeout(
        () => resolve({ exitCode: null, timedOut: true }),
        spec.timeoutMs,
      );
      timer.unref();
      abortListener = () =>
        resolve({ exitCode: null, cancelled: true, timedOut: false });
      spec.signal?.addEventListener("abort", abortListener, { once: true });
    });
    try {
      const defaultExecution: Promise<Partial<SandboxExecResult>> =
        !this.commandHandler &&
        spec.argv[0] === "git" &&
        state.repositoryPath !== undefined
          ? this.runLocalProcess(
              spec.argv,
              spec.cwd.replace("/workspace", state.repositoryPath),
            )
          : Promise.resolve<Partial<SandboxExecResult>>({
              exitCode: 0,
              stdout: "",
              stderr: "",
            });
      const handled = await Promise.race([
        this.commandHandler
          ? Promise.resolve(this.commandHandler(state, spec))
          : defaultExecution,
        timeout,
      ]);
      const bounded = truncateOutput(
        handled.stdout ?? "",
        handled.stderr ?? "",
        spec.maxOutputBytes,
      );
      return {
        exitCode: handled.exitCode ?? null,
        stdout: bounded.stdout,
        stderr: bounded.stderr,
        timedOut: handled.timedOut ?? false,
        cancelled: handled.cancelled ?? false,
        outputTruncated:
          handled.outputTruncated === true || bounded.outputTruncated,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) {
        spec.signal?.removeEventListener("abort", abortListener);
      }
    }
  }

  async setNetworkPhase(
    sandboxId: string,
    phase: AppV2NetworkPhase,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const state = this.requireState(sandboxId);
    state.networkPhase = phase;
    state.networkPhases.push(phase);
  }

  async quiesce(sandboxId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const state = this.requireState(sandboxId);
    for (const timer of state.pendingTenantTimers) clearTimeout(timer);
    state.pendingTenantTimers.clear();
    state.status = "paused";
    state.status = "running";
    state.networkPhase = "deny-all";
    state.networkPhases.push("deny-all");
    state.quiesceCount += 1;
  }

  async pause(sandboxId: string): Promise<void> {
    this.requireState(sandboxId).status = "paused";
  }

  async kill(sandboxId: string): Promise<void> {
    const state = this.states.get(sandboxId);
    if (!state || state.status === "missing") return;
    for (const timer of state.pendingTenantTimers) clearTimeout(timer);
    state.pendingTenantTimers.clear();
    state.status = "missing";
    if (state.repositoryPath) {
      await rm(path.dirname(state.repositoryPath), {
        recursive: true,
        force: true,
      });
    }
  }

  async status(sandboxId: string): Promise<SandboxStatus> {
    return this.states.get(sandboxId)?.status ?? "missing";
  }

  state(sandboxId: string): FakeSandboxState {
    return this.requireState(sandboxId);
  }

  scheduleTenantWrite(
    sandboxId: string,
    delayMs: number,
    write: (state: FakeSandboxState) => void,
  ): void {
    const state = this.requireState(sandboxId);
    const timer = setTimeout(() => {
      state.pendingTenantTimers.delete(timer);
      if (state.status === "running") write(state);
    }, delayMs);
    timer.unref();
    state.pendingTenantTimers.add(timer);
  }

  private requireState(sandboxId: string): FakeSandboxState {
    const state = this.states.get(sandboxId);
    if (!state || state.status === "missing") {
      throw new Error("Sandbox not found");
    }
    return state;
  }

  private runLocalGit(
    argv: readonly string[],
    cwd: string,
  ): Promise<Partial<SandboxExecResult>> {
    return this.runLocalProcess(
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "protocol.file.allow=always",
        ...argv,
      ],
      cwd,
    ).then(result => {
      if (result.exitCode !== 0) {
        throw new Error(`Fake sandbox Git failed: ${result.stderr}`);
      }
      return result;
    });
  }

  private runLocalProcess(
    argv: readonly string[],
    cwd: string,
  ): Promise<Partial<SandboxExecResult>> {
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        shell: false,
        env: {
          HOME: os.tmpdir(),
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", code =>
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
  }

  private async readLocalFiles(
    repositoryPath: string,
  ): Promise<Map<string, SandboxFile>> {
    const files = new Map<string, SandboxFile>();
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (directory === repositoryPath && entry.name === ".git") continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolute);
          continue;
        }
        const relative = path
          .relative(repositoryPath, absolute)
          .split(path.sep)
          .join("/");
        const metadata = await lstat(absolute);
        files.set(relative, {
          path: relative,
          content: await readFile(absolute),
          executable: (metadata.mode & 0o111) !== 0,
        });
      }
    };
    await visit(repositoryPath);
    return files;
  }
}
