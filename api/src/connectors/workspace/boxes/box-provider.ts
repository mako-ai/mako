/**
 * `BoxProvider`: the five things the scheduler asks of a sandbox vendor
 * (RFC connector-runtime §6.8), over the apps `SandboxProvider` seam.
 *
 * A leased box is an ordinary sandbox session whose key is the box id, so
 * every existing command path (sync-box.ts's exec, writeFile, readFile) works
 * on it unchanged once it is handed the box's context.
 */
import {
  getSandboxProvider,
  type SandboxExecContext,
  type SandboxExecOptions,
  type SandboxExecResult,
} from "../../../apps/sandbox/provider";

export interface BoxHandle {
  boxId: string;
}

/** Prefixed so it never collides with a session box or a workspace sync box. */
export function boxContext(box: BoxHandle): SandboxExecContext {
  return { sessionKey: `connector-box:${box.boxId}` };
}

export interface BoxProvider {
  /** Make the box exist and run: create (from `template` if given) or resume. */
  lease(box: BoxHandle, options: { template?: string }): Promise<void>;
  exec(
    box: BoxHandle,
    command: string,
    options?: SandboxExecOptions,
  ): Promise<SandboxExecResult>;
  /** A cheap command. Resumes a paused box. False on any failure. */
  ping(box: BoxHandle, timeoutMs: number): Promise<boolean>;
  pause(box: BoxHandle): Promise<void>;
  kill(box: BoxHandle): Promise<void>;
  /** Null where the provider cannot snapshot. */
  snapshot(box: BoxHandle, name: string): Promise<string | null>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  /**
   * Running boxes on the whole provider account, app sessions included.
   * Null where the provider has no shared limit (local).
   */
  countRunning(): Promise<number | null>;
}

export const sandboxBoxProvider: BoxProvider = {
  async lease(box, { template }) {
    const provider = getSandboxProvider();
    if (provider.boxLifecycle) {
      await provider.boxLifecycle.create(boxContext(box).sessionKey, {
        template,
      });
    }
  },
  exec(box, command, options) {
    return getSandboxProvider().exec(boxContext(box), command, options);
  },
  async ping(box, timeoutMs) {
    try {
      const result = await getSandboxProvider().exec(boxContext(box), "true", {
        timeoutMs,
      });
      return result.exitCode === 0 && !result.timedOut;
    } catch {
      return false;
    }
  },
  async pause(box) {
    await getSandboxProvider().boxLifecycle?.pause(boxContext(box).sessionKey);
  },
  async kill(box) {
    await getSandboxProvider().destroySession?.(boxContext(box).sessionKey);
  },
  async snapshot(box, name) {
    const lifecycle = getSandboxProvider().boxLifecycle;
    return lifecycle
      ? lifecycle.snapshot(boxContext(box).sessionKey, name)
      : null;
  },
  async deleteSnapshot(snapshotId) {
    await getSandboxProvider().boxLifecycle?.deleteSnapshot(snapshotId);
  },
  async countRunning() {
    const lifecycle = getSandboxProvider().boxLifecycle;
    return lifecycle ? lifecycle.countRunning() : null;
  },
};
