export type AppV2ExecutionPurpose = "dev" | "build" | "job";
export type AppV2NetworkPhase = "deny-all" | "install";
export type SandboxStatus = "running" | "paused" | "missing";

export interface DurableWorktreeRevision {
  wipOid: string;
  revision: number;
}

export interface SandboxIdentity {
  workspaceId: string;
  projectId: string;
  worktreeId: string;
  actorId: string;
  purpose: AppV2ExecutionPurpose;
  leaseEpoch: number;
  durableRevision: DurableWorktreeRevision;
}

export interface SandboxCreateSpec extends SandboxIdentity {
  labels: Record<string, string>;
  signal?: AbortSignal;
  onProvisioned(sandboxId: string): Promise<void>;
}

export interface SandboxHandle {
  sandboxId: string;
  status: SandboxStatus;
}

export interface SandboxFile {
  path: string;
  content: Uint8Array;
  executable: boolean;
}

export interface SandboxRepositorySnapshot {
  bundle: Uint8Array;
  branch: string;
  branchHead: string;
  wipOid: string;
}

export type SandboxRepositoryMaterialization = "fresh" | "update";

export interface SandboxExecSpec {
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface SandboxExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
}

export interface SandboxCapture {
  files: SandboxFile[];
  excludedPaths: string[];
}

/**
 * Provider-neutral isolated compute. This contract intentionally has no
 * arbitrary environment input: guest environment is selected by the provider.
 */
export interface SandboxProvider {
  readonly name: string;
  create(spec: SandboxCreateSpec): Promise<SandboxHandle>;
  listByLabels(
    labels: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<SandboxHandle[]>;
  materializeRepository(
    sandboxId: string,
    snapshot: SandboxRepositorySnapshot,
    materialization: SandboxRepositoryMaterialization,
    signal?: AbortSignal,
  ): Promise<void>;
  captureFiles(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<SandboxCapture>;
  exec(sandboxId: string, spec: SandboxExecSpec): Promise<SandboxExecResult>;
  setNetworkPhase(
    sandboxId: string,
    phase: AppV2NetworkPhase,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Terminates all tenant processes while preserving the filesystem, then
   * reconnects the sandbox for controller-only file operations.
   */
  quiesce(sandboxId: string, signal?: AbortSignal): Promise<void>;
  pause(sandboxId: string, signal?: AbortSignal): Promise<void>;
  kill(sandboxId: string, signal?: AbortSignal): Promise<void>;
  status(sandboxId: string, signal?: AbortSignal): Promise<SandboxStatus>;
}
