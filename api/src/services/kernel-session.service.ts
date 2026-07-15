/**
 * Kernel session lifecycle. A *session* binds one notebook to one live kernel:
 * acquire a pod (via the active KernelProvider), start a kernel on it, mint a
 * read-only kernel token the sandbox uses to proxy SQL reads, and record it in
 * the shared {@link SessionStore}.
 *
 * The store is Redis-backed when `REDIS_URL` is set (prod, multi-instance) and
 * in-process otherwise (dev/preview). This is what lets *any* Cloud Run instance
 * find a notebook's kernel and route execution to the same pod — without it,
 * cells scatter across instances, each spinning its own kernel ("No kernel
 * session running", variables not persisting). The disconnect invariant still
 * holds: kernel *variables* are ephemeral; rendered outputs stream/persist
 * separately.
 */
import { randomUUID } from "crypto";

import { loggers } from "../logging";
import { mintKernelTokenWithExpiry } from "./kernel-token.service";
import {
  kernelGatewayClient,
  type ExecuteOptions,
} from "./kernel-provider/kernel-gateway-client";
import {
  getKernelProvider,
  type KernelOutput,
  type ExecuteResult,
} from "./kernel-provider";
import { getSessionStore, type StoredSession } from "./kernel-session-store";

const logger = loggers.api("kernel-session");

const IDLE_TTL_MS = Number(process.env.KERNEL_SESSION_IDLE_MS || 15 * 60_000);
// Refresh the kernel token when it's within this window of expiring, so a live
// session never fails a read with "Kernel token expired" — without weakening
// the token's (short) TTL.
const TOKEN_REFRESH_BUFFER_MS = 3 * 60_000;

export interface KernelSessionInfo {
  sessionId: string;
  notebookId: string;
  provider: string;
  status: "starting" | "ready";
  startedAt: string;
  // Note: the kernel token is deliberately NOT exposed here — it's injected
  // into the kernel process, never handed to the browser.
}

/** Raised when no kernel provider is configured (execution unavailable). */
export class KernelUnavailableError extends Error {
  constructor(message = "No kernel provider is configured") {
    super(message);
    this.name = "KernelUnavailableError";
  }
}

function key(workspaceId: string, notebookId: string): string {
  return `${workspaceId}:${notebookId}`;
}

/** Heuristic: the pod backing a stored session is gone (recycled / autoscaled).
 * On these we drop the record so the next run starts a fresh session. */
function isPodUnreachable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code ?? "";
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|socket hang up|fetch failed/i.test(
    `${msg} ${code}`,
  );
}

class KernelSessionService {
  private readonly store = getSessionStore();

  private toInfo(s: StoredSession): KernelSessionInfo {
    return {
      sessionId: s.sessionId,
      notebookId: s.notebookId,
      provider: s.provider,
      status: "ready",
      startedAt: new Date(s.startedAtMs).toISOString(),
    };
  }

  /**
   * Python that prepares the fresh kernel before any user code. Runs silently;
   * each kernel is its own process, so this never leaks across co-tenant
   * kernels. Three jobs:
   *  1. Wire the mako SDK — the read-only token + workspace so
   *     `mako.sources.sql.read(...)` proxies through the API.
   *  2. Point the mako SDK's source resolution at the kernel-token-authed
   *     `/notebook/sources` route. `mako.sources.read(...)` first resolves a
   *     source NAME to an id via that list; the SDK's baked default hits the
   *     generic `/databases` route, which rejects kernel tokens (and echoes
   *     credentials), so reads 403. This override reconfigures the baked SDK at
   *     runtime — no kernel-image rebuild needed.
   *  3. Activate the Jupyter inline backend so matplotlib figures render as
   *     inline PNGs. The kernel image defaults to the headless Agg backend
   *     (`MPLBACKEND=Agg`), which emits no image output; `%matplotlib inline`
   *     switches to the inline backend (auto-displaying figures at cell end,
   *     no `plt.show()` needed) — the behaviour users expect from Jupyter.
   */
  private kernelInitCode(session: {
    workspaceId: string;
    kernelToken: string;
  }): string {
    const apiUrl =
      process.env.NOTEBOOK_KERNEL_API_URL || process.env.BASE_URL || "";
    const env = {
      MAKO_API_URL: apiUrl,
      MAKO_WORKSPACE_ID: session.workspaceId,
      MAKO_KERNEL_TOKEN: session.kernelToken,
    };
    return [
      `import os as _os`,
      `_os.environ.update(${JSON.stringify(env)})`,
      // Resolve sources via the kernel-authed notebook route, not the generic
      // (credentialed, session-only) /databases route. Isolated so an SDK issue
      // can't break the rest of init.
      `try:`,
      `    import mako as _mako`,
      `    _mako.configure(databases_path="/api/workspaces/{workspace_id}/notebook/sources")`,
      `except Exception:`,
      `    pass`,
      // Inline matplotlib — isolated so a matplotlib issue can't break the SDK
      // env setup above. Overrides MPLBACKEND=Agg at runtime.
      `try:`,
      `    from IPython import get_ipython as _get_ipython`,
      `    _ip = _get_ipython()`,
      `    if _ip is not None:`,
      `        _ip.run_line_magic("matplotlib", "inline")`,
      `except Exception:`,
      `    pass`,
      ``,
    ].join("\n");
  }

  /** Silent snippet that swaps in a freshly-minted token mid-session and drops
   * the SDK's cached client so the next read picks it up. */
  private tokenRefreshCode(token: string): string {
    return [
      `import os as _os`,
      `_os.environ['MAKO_KERNEL_TOKEN'] = ${JSON.stringify(token)}`,
      `try:`,
      `    import mako as _mako`,
      `    _mako.reset_default_client()`,
      `except Exception:`,
      `    pass`,
      ``,
    ].join("\n");
  }

  async get(
    workspaceId: string,
    notebookId: string,
  ): Promise<KernelSessionInfo | null> {
    const s = await this.store.get(key(workspaceId, notebookId));
    return s ? this.toInfo(s) : null;
  }

  /**
   * Start (or return the existing) kernel session for a notebook. Idempotent
   * across instances: a cross-instance lock ensures two instances can't spin
   * two kernels for the same notebook.
   */
  async start(input: {
    workspaceId: string;
    notebookId: string;
    userId: string;
  }): Promise<KernelSessionInfo> {
    const { workspaceId, notebookId, userId } = input;
    const k = key(workspaceId, notebookId);

    const existing = await this.store.get(k);
    if (existing) return this.toInfo(existing);

    return this.store.withLock(k, async () => {
      // Re-check inside the lock: another instance may have just created it.
      const again = await this.store.get(k);
      if (again) return this.toInfo(again);

      const provider = getKernelProvider();
      if (!provider) throw new KernelUnavailableError();

      const endpoint = await provider.acquire({ workspaceId, notebookId });
      const kernelId = await kernelGatewayClient.startKernel(endpoint.baseUrl);
      const { token, expMs } = mintKernelTokenWithExpiry({
        workspaceId,
        userId,
        notebookId,
      });

      const now = Date.now();
      const session: StoredSession = {
        sessionId: randomUUID(),
        workspaceId,
        notebookId,
        userId,
        provider: provider.name,
        endpoint,
        kernelId,
        kernelToken: token,
        tokenExpMs: expMs,
        startedAtMs: now,
        lastActivityAtMs: now,
      };

      // Wire the mako SDK inside the kernel (best-effort; execution still works
      // without it, only mako.sources reads would be unconfigured).
      try {
        await kernelGatewayClient.execute(
          endpoint.baseUrl,
          kernelId,
          this.kernelInitCode(session),
          () => undefined,
          { timeoutMs: 20_000 },
        );
      } catch (error) {
        logger.warn("kernel SDK init cell failed", { error, notebookId });
      }

      await this.store.put(k, session);
      logger.info("started kernel session", {
        sessionId: session.sessionId,
        provider: provider.name,
        pod: endpoint.podName,
        notebookId,
        store: this.store.kind,
      });
      return this.toInfo(session);
    });
  }

  /**
   * Execute `code` on the notebook's kernel, streaming outputs. Looks the
   * session up in the shared store, so any instance routes to the right pod.
   * Refreshes the kernel token before it expires, and drops a session whose pod
   * has gone. Throws {@link KernelUnavailableError} if no session is running.
   *
   * Concurrent executes on one kernel are serialized by the kernel itself
   * (Jupyter processes one execute-request at a time per kernel), so no
   * cross-instance queue is needed.
   */
  async execute(
    workspaceId: string,
    notebookId: string,
    code: string,
    onOutput: (o: KernelOutput) => void,
    opts: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    const k = key(workspaceId, notebookId);
    const session = await this.store.get(k);
    if (!session) throw new KernelUnavailableError("No kernel session running");

    await this.maybeRefreshToken(k, session);

    try {
      const result = await kernelGatewayClient.execute(
        session.endpoint.baseUrl,
        session.kernelId,
        code,
        onOutput,
        opts,
      );
      await this.store.touch(k, { lastActivityAtMs: Date.now() });
      return result;
    } catch (error) {
      if (isPodUnreachable(error)) {
        await this.store.delete(k).catch(() => undefined);
        logger.warn("kernel pod unreachable; dropped session", {
          notebookId,
          error,
        });
        throw new KernelUnavailableError(
          "Kernel lost (pod restarted). Re-run to start a fresh kernel.",
        );
      }
      throw error;
    }
  }

  /** Re-mint + re-inject the kernel token when it's near expiry. Best-effort:
   * a failed refresh leaves the old token in place and retries next execute. */
  private async maybeRefreshToken(
    k: string,
    session: StoredSession,
  ): Promise<void> {
    if (session.tokenExpMs - Date.now() > TOKEN_REFRESH_BUFFER_MS) return;

    const { token, expMs } = mintKernelTokenWithExpiry({
      workspaceId: session.workspaceId,
      userId: session.userId,
      notebookId: session.notebookId,
    });
    try {
      await kernelGatewayClient.execute(
        session.endpoint.baseUrl,
        session.kernelId,
        this.tokenRefreshCode(token),
        () => undefined,
        { timeoutMs: 15_000 },
      );
    } catch (error) {
      logger.warn("kernel token refresh failed; retrying next execute", {
        notebookId: session.notebookId,
        error,
      });
      return;
    }
    await this.store.touch(k, {
      kernelToken: token,
      tokenExpMs: expMs,
      lastActivityAtMs: Date.now(),
    });
    logger.debug("refreshed kernel token", { notebookId: session.notebookId });
  }

  /** Stop a session: delete the kernel and release the pod. Best-effort. */
  async stop(workspaceId: string, notebookId: string): Promise<boolean> {
    const k = key(workspaceId, notebookId);
    const session = await this.store.get(k);
    if (!session) return false;
    await this.store.delete(k);
    await kernelGatewayClient
      .deleteKernel(session.endpoint.baseUrl, session.kernelId)
      .catch(() => undefined);
    const provider = getKernelProvider();
    await provider?.release(session.endpoint).catch(() => undefined);
    logger.info("stopped kernel session", { sessionId: session.sessionId });
    return true;
  }

  /** Sessions idle past the TTL — used by the reaper (future Inngest sweep). */
  async idleSessions(
    nowMs = Date.now(),
  ): Promise<Array<{ workspaceId: string; notebookId: string }>> {
    const all = await this.store.list();
    return all
      .filter(s => nowMs - s.lastActivityAtMs > IDLE_TTL_MS)
      .map(s => ({ workspaceId: s.workspaceId, notebookId: s.notebookId }));
  }
}

export const kernelSessionService = new KernelSessionService();
