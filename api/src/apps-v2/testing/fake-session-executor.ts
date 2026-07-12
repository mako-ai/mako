import type { SandboxStatus } from "../providers/sandbox-provider";
import type {
  PreparedSession,
  ProvisioningReservation,
  SessionExecutionTarget,
  SessionExecRequest,
  SessionExecResult,
  SessionExecutor,
  SessionFlushResult,
  SessionInstallRequest,
  SessionPrepareOptions,
  SessionRecoveryIntent,
  SessionRecoveryState,
} from "../session-executor";

export class FakeSessionExecutor implements SessionExecutor {
  readonly prepared: Array<
    Omit<SessionExecutionTarget, "sandboxId" | "appliedWipOid">
  > = [];
  readonly applied: SessionExecutionTarget[] = [];
  readonly executions: Array<{
    target: SessionExecutionTarget;
    request: SessionExecRequest;
  }> = [];
  readonly installs: Array<{
    target: SessionExecutionTarget;
    request: SessionInstallRequest;
  }> = [];
  readonly killed: SessionExecutionTarget[] = [];
  readonly paused: SessionExecutionTarget[] = [];
  readonly flushed: SessionExecutionTarget[] = [];
  readonly recovered: SessionExecutionTarget[] = [];
  readonly cleanedReservations: ProvisioningReservation[] = [];
  readonly statuses = new Map<string, SandboxStatus>();
  readonly recoveryRefs = new Map<string, string>();
  readonly successMarkers = new Map<
    string,
    SessionExecutionTarget["durableRevision"]
  >();
  nextResult?: SessionExecResult;
  nextFlush?: SessionFlushResult;

  async prepare(
    target: Omit<SessionExecutionTarget, "sandboxId" | "appliedWipOid">,
    options: SessionPrepareOptions,
  ): Promise<PreparedSession> {
    this.prepared.push(target);
    const sandboxId = `fake-session-${this.prepared.length}`;
    this.statuses.set(sandboxId, "running");
    await options.onProvisioned(sandboxId);
    return { sandboxId, appliedRevision: target.durableRevision };
  }

  async applyRevision(target: SessionExecutionTarget): Promise<void> {
    this.applied.push(target);
  }

  async exec(
    target: SessionExecutionTarget,
    request: SessionExecRequest,
  ): Promise<SessionExecResult> {
    this.executions.push({ target, request });
    return (
      this.nextResult ?? {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
        excludedPaths: [],
        durability: {
          status: "durable",
          revision: target.durableRevision,
        },
      }
    );
  }

  async install(
    target: SessionExecutionTarget,
    request: SessionInstallRequest,
  ): Promise<SessionExecResult> {
    this.installs.push({ target, request });
    return (
      this.nextResult ?? {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
        excludedPaths: [],
        durability: {
          status: "durable",
          revision: target.durableRevision,
        },
      }
    );
  }

  async flush(target: SessionExecutionTarget): Promise<SessionFlushResult> {
    this.flushed.push(target);
    return (
      this.nextFlush ?? {
        excludedPaths: [],
        durability: {
          status: "durable",
          revision: target.durableRevision,
        },
      }
    );
  }

  async recover(target: SessionExecutionTarget): Promise<SessionFlushResult> {
    this.recovered.push(target);
    return (
      this.nextFlush ?? {
        excludedPaths: [],
        durability: {
          status: "durable",
          revision: target.durableRevision,
        },
      }
    );
  }

  async pause(target: SessionExecutionTarget): Promise<void> {
    this.paused.push(target);
    this.statuses.set(target.sandboxId, "paused");
  }

  async kill(target: SessionExecutionTarget): Promise<void> {
    this.killed.push(target);
    this.statuses.set(target.sandboxId, "missing");
  }

  async status(target: SessionExecutionTarget): Promise<SandboxStatus> {
    return this.statuses.get(target.sandboxId) ?? "missing";
  }

  recoveryIdentity(
    target: SessionExecutionTarget,
    recoveryId: string,
  ): { successRef: string } {
    return {
      successRef: `refs/mako/session-success/${target.worktreeId}/${recoveryId}`,
    };
  }

  async reconcileRecovery(
    target: SessionExecutionTarget,
    intent: SessionRecoveryIntent,
  ): Promise<SessionRecoveryState> {
    const recoveryRef = this.recoveryRefs.get(intent.recoveryId);
    if (recoveryRef) return { status: "conflict", recoveryRef };
    const revision = this.successMarkers.get(intent.recoveryId);
    if (
      revision &&
      intent.successRef ===
        this.recoveryIdentity(target, intent.recoveryId).successRef
    ) {
      return { status: "durable", revision };
    }
    return { status: "none" };
  }

  async clearSuccessMarker(
    _target: SessionExecutionTarget,
    recoveryId: string,
  ): Promise<void> {
    this.successMarkers.delete(recoveryId);
  }

  async cleanupProvisioning(
    reservation: ProvisioningReservation,
  ): Promise<string[]> {
    this.cleanedReservations.push(reservation);
    return [];
  }
}
