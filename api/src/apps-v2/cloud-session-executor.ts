import type {
  IAppV2Project,
  IAppV2Worktree,
} from "../database/workspace-schema";
import { AppV2ProjectService, type AppV2Actor } from "./app-project.service";
import {
  APP_V2_SESSION_MAX_ARG_CHARACTERS,
  APP_V2_SESSION_MAX_ARG_COUNT,
  APP_V2_SESSION_CONTROL_PLANE_TIMEOUT_MS,
  APP_V2_SESSION_MAX_OUTPUT_BYTES,
  APP_V2_SESSION_MAX_TIMEOUT_MS,
} from "./config";
import {
  AppV2ConflictError,
  AppV2RecoveryConflictError,
  AppV2ValidationError,
} from "./errors";
import { isAppV2SessionFileEligible } from "./session-files";
import { validateAppV2PackageSpecs } from "./package-spec";
import { APP_V2_MAX_PATH_SEGMENTS } from "./path-validation";
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
} from "./session-executor";
import type {
  AppV2NetworkPhase,
  SandboxFile,
  SandboxProvider,
  SandboxRepositorySnapshot,
  SandboxStatus,
} from "./providers/sandbox-provider";
import { AppV2WorktreeService } from "./worktree.service";

interface LoadedWorktree {
  project: IAppV2Project;
  worktree: IAppV2Worktree;
}

const ZERO_OID = "0".repeat(40);

export class CloudSessionExecutor implements SessionExecutor {
  constructor(
    private readonly sandboxes: SandboxProvider,
    private readonly projects = new AppV2ProjectService(),
    private readonly worktrees = new AppV2WorktreeService(projects),
    private readonly installTimeoutMs = APP_V2_SESSION_MAX_TIMEOUT_MS,
    private readonly controlPlaneTimeoutMs = APP_V2_SESSION_CONTROL_PLANE_TIMEOUT_MS,
  ) {}

  async prepare(
    target: Omit<SessionExecutionTarget, "sandboxId" | "appliedWipOid">,
    options: SessionPrepareOptions,
  ): Promise<PreparedSession> {
    options.signal.throwIfAborted();
    const loaded = await this.load(target);
    options.signal.throwIfAborted();
    this.assertRevision(target, loaded.worktree);
    const sandbox = await this.sandboxes.create({
      workspaceId: target.workspaceId,
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      actorId: target.actorId,
      purpose: target.purpose,
      leaseEpoch: target.leaseEpoch,
      durableRevision: target.durableRevision,
      labels: {
        managedBy: "mako-apps-v2",
        reservationId: options.reservationId,
      },
      signal: options.signal,
      onProvisioned: options.onProvisioned,
    });
    try {
      await this.sandboxes.materializeRepository(
        sandbox.sandboxId,
        await this.repositorySnapshot(target, loaded, options.signal),
        "fresh",
        options.signal,
      );
    } catch (error) {
      await this.sandboxes.kill(sandbox.sandboxId).catch(() => undefined);
      throw error;
    }
    return {
      sandboxId: sandbox.sandboxId,
      appliedRevision: target.durableRevision,
    };
  }

  async applyRevision(
    target: SessionExecutionTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const loaded = await this.load(target);
    signal?.throwIfAborted();
    this.assertRevision(target, loaded.worktree);
    await this.sandboxes.materializeRepository(
      target.sandboxId,
      await this.repositorySnapshot(target, loaded, signal),
      "update",
      signal,
    );
  }

  async exec(
    target: SessionExecutionTarget,
    request: SessionExecRequest,
  ): Promise<SessionExecResult> {
    this.validateExecRequest(request);
    const loaded = await this.load(target);
    this.assertRevision(target, loaded.worktree);
    await this.applyCurrentRevision(target, loaded, request.signal);
    return this.executeAndFlush(target, loaded, request, "deny-all");
  }

  async install(
    target: SessionExecutionTarget,
    request: SessionInstallRequest,
  ): Promise<SessionExecResult> {
    validateAppV2PackageSpecs(request.packages);
    const loaded = await this.load(target);
    this.assertRevision(target, loaded.worktree);
    await this.applyCurrentRevision(target, loaded, request.signal);
    return this.executeAndFlush(
      target,
      loaded,
      {
        argv: ["pnpm", "add", "--save-exact", ...request.packages],
        cwd: "/workspace",
        timeoutMs: Math.min(
          this.installTimeoutMs,
          APP_V2_SESSION_MAX_TIMEOUT_MS,
        ),
        signal: request.signal,
      },
      "install",
    );
  }

  private async executeAndFlush(
    target: SessionExecutionTarget,
    loaded: LoadedWorktree,
    request: SessionExecRequest,
    networkPhase: AppV2NetworkPhase,
  ): Promise<SessionExecResult> {
    let execution: Awaited<ReturnType<SandboxProvider["exec"]>> | undefined;
    let failure: unknown;
    try {
      await this.sandboxes.setNetworkPhase(
        target.sandboxId,
        networkPhase,
        request.signal,
      );
      execution = await this.sandboxes.exec(target.sandboxId, {
        argv: request.argv,
        cwd: request.cwd,
        timeoutMs: Math.min(request.timeoutMs, APP_V2_SESSION_MAX_TIMEOUT_MS),
        maxOutputBytes: APP_V2_SESSION_MAX_OUTPUT_BYTES,
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal?.aborted) {
        execution = {
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          cancelled: true,
          outputTruncated: false,
        };
      } else {
        failure = error;
      }
    }
    const controlPlane = this.controlPlaneScope();
    try {
      try {
        await this.sandboxes.setNetworkPhase(
          target.sandboxId,
          "deny-all",
          controlPlane.signal,
        );
      } catch (error) {
        failure ??= error;
      }
      try {
        await this.quiesceAndAssert(target.sandboxId, controlPlane.signal);
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
      if (!execution) throw new Error("Sandbox command returned no result");
      const flush = await this.captureAndFlush(
        target,
        loaded,
        controlPlane.signal,
      );
      return { ...execution, ...flush };
    } finally {
      controlPlane.dispose();
    }
  }

  private async applyCurrentRevision(
    target: SessionExecutionTarget,
    loaded: LoadedWorktree,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (target.appliedWipOid !== target.durableRevision.wipOid) {
      await this.sandboxes.materializeRepository(
        target.sandboxId,
        await this.repositorySnapshot(target, loaded, signal),
        "update",
        signal,
      );
    }
  }

  async flush(
    target: SessionExecutionTarget,
    signal?: AbortSignal,
  ): Promise<SessionFlushResult> {
    const loaded = await this.load(target);
    this.assertRevision(target, loaded.worktree);
    await this.sandboxes.setNetworkPhase(target.sandboxId, "deny-all", signal);
    await this.quiesceAndAssert(target.sandboxId, signal);
    return this.captureAndFlush(target, loaded, signal);
  }

  async recover(
    target: SessionExecutionTarget,
    operationSignal?: AbortSignal,
  ): Promise<SessionFlushResult> {
    const loaded = await this.load(target);
    const recoveryWorktree = {
      ...(typeof loaded.worktree.toObject === "function"
        ? loaded.worktree.toObject()
        : loaded.worktree),
      wipOid: target.durableRevision.wipOid,
      revision: target.durableRevision.revision,
      leaseEpoch: target.leaseEpoch,
      leaseOid:
        loaded.worktree.leaseEpoch === target.leaseEpoch &&
        loaded.worktree.revision === target.durableRevision.revision &&
        loaded.worktree.wipOid === target.durableRevision.wipOid
          ? loaded.worktree.leaseOid
          : ZERO_OID,
    } as IAppV2Worktree;
    const controlPlane = this.controlPlaneScope();
    const signal = operationSignal
      ? AbortSignal.any([operationSignal, controlPlane.signal])
      : controlPlane.signal;
    try {
      await this.sandboxes.setNetworkPhase(
        target.sandboxId,
        "deny-all",
        signal,
      );
      await this.quiesceAndAssert(target.sandboxId, signal);
      return await this.captureAndFlush(
        target,
        { project: loaded.project, worktree: recoveryWorktree },
        signal,
      );
    } finally {
      controlPlane.dispose();
    }
  }

  private async captureAndFlush(
    target: SessionExecutionTarget,
    loaded: LoadedWorktree,
    signal?: AbortSignal,
  ): Promise<SessionFlushResult> {
    // This uses a fresh control-plane request. Caller cancellation never skips
    // capture after a finite command.
    const capture = await this.sandboxes.captureFiles(target.sandboxId, signal);
    const previous = await this.readRevision(loaded);
    const retainedExcluded = previous.filter(
      file => !isAppV2SessionFileEligible(file.path),
    );
    const excludedPaths = [
      ...new Set([
        ...capture.excludedPaths,
        ...retainedExcluded.map(file => file.path),
      ]),
    ].sort();
    signal?.throwIfAborted();
    try {
      const updated = await this.worktrees.replaceTree(
        loaded.project,
        loaded.worktree,
        {
          ifRevision: target.durableRevision.revision,
          expectedWipOid: target.durableRevision.wipOid,
          leaseEpoch: target.leaseEpoch,
        },
        [...capture.files, ...retainedExcluded].map(file => ({
          path: file.path,
          content: Buffer.from(file.content),
          executable: file.executable,
        })),
        target.recoveryId,
      );
      signal?.throwIfAborted();
      return {
        excludedPaths,
        durability: {
          status: "durable",
          revision: { wipOid: updated.wipOid, revision: updated.revision },
        },
      };
    } catch (error) {
      if (error instanceof AppV2RecoveryConflictError) {
        return {
          excludedPaths,
          durability: {
            status: "conflict",
            recoveryRef: error.recoveryRef,
          },
        };
      }
      throw error;
    }
  }

  private async quiesceAndAssert(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.sandboxes.quiesce(sandboxId, signal);
    if ((await this.sandboxes.status(sandboxId, signal)) !== "running") {
      throw new Error("Sandbox failed to reach quiesced controller state");
    }
  }

  private controlPlaneScope(): {
    signal: AbortSignal;
    dispose(): void;
  } {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(
        new Error("Apps v2 post-command durability operation timed out"),
      );
    }, this.controlPlaneTimeoutMs);
    timeout.unref();
    return {
      signal: controller.signal,
      dispose: () => clearTimeout(timeout),
    };
  }

  async pause(
    target: SessionExecutionTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.sandboxes.pause(target.sandboxId, signal);
  }

  async kill(
    target: SessionExecutionTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.sandboxes.kill(target.sandboxId, signal);
  }

  status(
    target: SessionExecutionTarget,
    signal?: AbortSignal,
  ): Promise<SandboxStatus> {
    return this.sandboxes.status(target.sandboxId, signal);
  }

  recoveryIdentity(
    target: SessionExecutionTarget,
    recoveryId: string,
  ): { successRef: string } {
    return {
      successRef: this.projects.git.successRefName(
        target.worktreeId,
        recoveryId,
      ),
    };
  }

  async reconcileRecovery(
    target: SessionExecutionTarget,
    intent: SessionRecoveryIntent,
  ): Promise<SessionRecoveryState> {
    const loaded = await this.load(target);
    const expectedSuccessRef = this.projects.git.successRefName(
      target.worktreeId,
      intent.recoveryId,
    );
    if (intent.successRef !== expectedSuccessRef) {
      throw new AppV2ValidationError("Session success marker identity changed");
    }
    const recoveryRef = await this.projects.git.findRecoveryRef(
      loaded.project.repositoryId,
      target.worktreeId,
      intent.recoveryId,
    );
    if (recoveryRef) return { status: "conflict", recoveryRef };
    const success = await this.projects.git.findSuccessMarker(
      loaded.project.repositoryId,
      target.worktreeId,
      intent.recoveryId,
    );
    if (success?.ref !== intent.successRef) return { status: "none" };
    if (success.oid !== loaded.worktree.wipOid) return { status: "none" };
    if (
      success.oid === intent.expectedWipOid ||
      loaded.worktree.revision <= intent.expectedRevision
    ) {
      throw new AppV2ConflictError(
        "Session success marker did not advance the expected worktree",
      );
    }
    return {
      status: "durable",
      revision: {
        wipOid: loaded.worktree.wipOid,
        revision: loaded.worktree.revision,
      },
    };
  }

  async clearSuccessMarker(
    target: SessionExecutionTarget,
    recoveryId: string,
    resultWipOid: string,
  ): Promise<void> {
    const loaded = await this.load(target);
    await this.projects.git.deleteSuccessMarker(
      loaded.project.repositoryId,
      target.worktreeId,
      recoveryId,
      resultWipOid,
    );
  }

  async cleanupProvisioning(
    reservation: ProvisioningReservation,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const matches = await this.sandboxes.listByLabels(
      {
        managedBy: "mako-apps-v2",
        workspaceId: reservation.workspaceId,
        projectId: reservation.projectId,
        worktreeId: reservation.worktreeId,
        actorId: reservation.actorId,
        purpose: reservation.purpose,
        reservationId: reservation.reservationId,
      },
      signal,
    );
    const sandboxIds = new Set(matches.map(sandbox => sandbox.sandboxId));
    if (
      reservation.sandboxId &&
      !reservation.sandboxId.startsWith("reservation:")
    ) {
      sandboxIds.add(reservation.sandboxId);
    }
    for (const sandboxId of sandboxIds) {
      await this.sandboxes.kill(sandboxId, signal);
    }
    return [...sandboxIds];
  }

  private async load(
    target: Pick<
      SessionExecutionTarget,
      "workspaceId" | "projectId" | "worktreeId" | "actorId" | "memberRole"
    >,
  ): Promise<LoadedWorktree> {
    const actor: AppV2Actor = {
      userId: target.actorId,
      memberRole: target.memberRole,
    };
    const project = await this.projects.getWritable(
      target.workspaceId,
      target.projectId,
      actor,
    );
    const worktree = await this.worktrees.getById(
      project,
      target.worktreeId,
      actor,
    );
    return { project, worktree };
  }

  private assertRevision(
    target: Pick<
      SessionExecutionTarget,
      "repositoryId" | "branch" | "wipRef" | "leaseEpoch" | "durableRevision"
    >,
    worktree: IAppV2Worktree,
  ): void {
    if (
      target.repositoryId === "" ||
      target.branch !== worktree.branch ||
      target.wipRef !== worktree.wipRef ||
      worktree.leaseEpoch !== target.leaseEpoch ||
      worktree.wipOid !== target.durableRevision.wipOid ||
      worktree.revision !== target.durableRevision.revision
    ) {
      throw new AppV2ConflictError("Session worktree revision is stale");
    }
  }

  private async repositorySnapshot(
    target: Pick<SessionExecutionTarget, "repositoryId" | "branch" | "wipRef">,
    { project, worktree }: LoadedWorktree,
    signal?: AbortSignal,
  ): Promise<SandboxRepositorySnapshot> {
    signal?.throwIfAborted();
    if (target.repositoryId !== project.repositoryId) {
      throw new AppV2ConflictError("Session repository identity is stale");
    }
    const bundle = await this.projects.git.createBundle(
      project.repositoryId,
      {
        branch: worktree.branch,
        wipRef: worktree.wipRef,
      },
      signal,
    );
    signal?.throwIfAborted();
    if (
      bundle.branchHead !== worktree.baseSha ||
      bundle.wipOid !== worktree.wipOid
    ) {
      throw new AppV2ConflictError("Session Git snapshot changed concurrently");
    }
    return {
      bundle: bundle.bytes,
      branch: worktree.branch,
      branchHead: bundle.branchHead,
      wipOid: bundle.wipOid,
    };
  }

  private async readRevision({
    project,
    worktree,
  }: LoadedWorktree): Promise<SandboxFile[]> {
    const entries = await this.projects.git.tree(
      project.repositoryId,
      worktree.wipOid,
    );
    return Promise.all(
      entries.map(async entry => ({
        path: entry.path,
        content: (
          await this.projects.git.readFile(
            project.repositoryId,
            worktree.wipOid,
            entry.path,
          )
        ).content,
        executable: entry.mode === "executable",
      })),
    );
  }

  private validateExecRequest(request: SessionExecRequest): void {
    if (
      request.argv.length === 0 ||
      request.argv.length > APP_V2_SESSION_MAX_ARG_COUNT ||
      request.argv.some(
        argument =>
          !argument ||
          argument.length > APP_V2_SESSION_MAX_ARG_CHARACTERS ||
          argument.includes("\0"),
      ) ||
      request.argv.reduce((total, argument) => total + argument.length, 0) >
        APP_V2_SESSION_MAX_ARG_CHARACTERS
    ) {
      throw new AppV2ValidationError("Invalid command argv");
    }
    if (
      request.cwd !== "/workspace" &&
      (!request.cwd.startsWith("/workspace/") ||
        request.cwd.slice("/workspace/".length).split("/").length >
          APP_V2_MAX_PATH_SEGMENTS ||
        request.cwd
          .slice("/workspace/".length)
          .split("/")
          .some(segment => !segment || segment === "." || segment === ".."))
    ) {
      throw new AppV2ValidationError("Command cwd must stay within /workspace");
    }
  }
}
