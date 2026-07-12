import { randomUUID } from "node:crypto";
import { isAppV2SessionFileEligible } from "../session-files";
import type {
  AppV2NetworkPhase,
  SandboxCapture,
  SandboxCreateSpec,
  SandboxExecResult,
  SandboxExecSpec,
  SandboxFile,
  SandboxHandle,
  SandboxProvider,
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

  async materializeFiles(
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

  async captureFiles(sandboxId: string): Promise<SandboxCapture> {
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
      const handled = await Promise.race([
        Promise.resolve(
          this.commandHandler?.(state, spec) ?? {
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        ),
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
  ): Promise<void> {
    const state = this.requireState(sandboxId);
    state.networkPhase = phase;
    state.networkPhases.push(phase);
  }

  async quiesce(sandboxId: string): Promise<void> {
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
}
