import type {
  AppV2ExecutionPurpose,
  DurableWorktreeRevision,
  SandboxExecResult,
  SandboxStatus,
} from "./providers/sandbox-provider";

export interface SessionExecutionTarget {
  workspaceId: string;
  projectId: string;
  worktreeId: string;
  actorId: string;
  memberRole?: string;
  purpose: AppV2ExecutionPurpose;
  sandboxId: string;
  leaseEpoch: number;
  durableRevision: DurableWorktreeRevision;
  appliedWipOid?: string;
  recoveryId?: string;
}

export interface SessionExecRequest {
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type SessionDurabilityResult =
  | {
      status: "durable";
      revision: DurableWorktreeRevision;
      recoveryRef?: never;
    }
  | {
      status: "conflict";
      revision?: never;
      recoveryRef: string;
    };

export interface SessionFlushResult {
  excludedPaths: string[];
  durability: SessionDurabilityResult;
}

export interface SessionExecResult
  extends SandboxExecResult,
    SessionFlushResult {}

export interface PreparedSession {
  sandboxId: string;
  appliedRevision: DurableWorktreeRevision;
}

export interface SessionPrepareOptions {
  reservationId: string;
  signal: AbortSignal;
  onProvisioned(sandboxId: string): Promise<void>;
}

export interface ProvisioningReservation {
  workspaceId: string;
  projectId: string;
  worktreeId: string;
  actorId: string;
  purpose: AppV2ExecutionPurpose;
  reservationId: string;
  sandboxId?: string;
}

export interface SessionRecoveryIntent {
  recoveryId: string;
  expectedWipOid: string;
  expectedRevision: number;
  successRef: string;
}

export type SessionRecoveryState =
  | { status: "none" }
  | { status: "conflict"; recoveryRef: string }
  | { status: "durable"; revision: DurableWorktreeRevision };

export interface SessionExecutor {
  prepare(
    target: Omit<SessionExecutionTarget, "sandboxId" | "appliedWipOid">,
    options: SessionPrepareOptions,
  ): Promise<PreparedSession>;
  applyRevision(target: SessionExecutionTarget): Promise<void>;
  exec(
    target: SessionExecutionTarget,
    request: SessionExecRequest,
  ): Promise<SessionExecResult>;
  flush(
    target: SessionExecutionTarget,
    signal?: AbortSignal,
  ): Promise<SessionFlushResult>;
  pause(target: SessionExecutionTarget, signal?: AbortSignal): Promise<void>;
  kill(target: SessionExecutionTarget, signal?: AbortSignal): Promise<void>;
  status(
    target: SessionExecutionTarget,
    signal?: AbortSignal,
  ): Promise<SandboxStatus>;
  recoveryIdentity(
    target: SessionExecutionTarget,
    recoveryId: string,
  ): { successRef: string };
  reconcileRecovery(
    target: SessionExecutionTarget,
    intent: SessionRecoveryIntent,
  ): Promise<SessionRecoveryState>;
  clearSuccessMarker(
    target: SessionExecutionTarget,
    recoveryId: string,
    resultWipOid: string,
  ): Promise<void>;
  cleanupProvisioning(
    reservation: ProvisioningReservation,
    signal?: AbortSignal,
  ): Promise<string[]>;
}
