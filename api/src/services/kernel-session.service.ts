/**
 * Kernel session lifecycle. A *session* binds one notebook to one live kernel:
 * acquire a pod (via the active KernelProvider), start a kernel on it, mint a
 * read-only kernel token the sandbox uses to proxy SQL reads, and serialize
 * executions FIFO so concurrent editors don't interleave on the shared kernel.
 *
 * v1 keeps sessions in-process (a Map). On stateless Cloud Run that means a
 * session is pinned to the instance that started it; a durable session registry
 * (Redis/Postgres) + the Inngest idle reaper are the next hardening step. The
 * disconnect invariant still holds: kernel *variables* are intentionally
 * ephemeral, and rendered outputs are streamed/persisted separately.
 */
import { randomUUID } from "crypto";

import { loggers } from "../logging";
import { mintKernelToken } from "./kernel-token.service";
import {
  kernelGatewayClient,
  type ExecuteOptions,
} from "./kernel-provider/kernel-gateway-client";
import {
  getKernelProvider,
  type KernelEndpoint,
  type KernelOutput,
  type ExecuteResult,
} from "./kernel-provider";

const logger = loggers.api("kernel-session");

const IDLE_TTL_MS = Number(process.env.KERNEL_SESSION_IDLE_MS || 15 * 60_000);

export interface KernelSessionInfo {
  sessionId: string;
  notebookId: string;
  provider: string;
  status: "starting" | "ready";
  startedAt: string;
  // Note: the kernel token is deliberately NOT exposed here — it's injected
  // into the kernel process, never handed to the browser.
}

interface KernelSession {
  sessionId: string;
  workspaceId: string;
  notebookId: string;
  userId: string;
  provider: string;
  endpoint: KernelEndpoint;
  kernelId: string;
  kernelToken: string;
  startedAt: number;
  lastActivityAt: number;
  /** FIFO tail: each execution awaits the previous one on this shared kernel. */
  queue: Promise<unknown>;
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

class KernelSessionService {
  private sessions = new Map<string, KernelSession>();

  private toInfo(s: KernelSession): KernelSessionInfo {
    return {
      sessionId: s.sessionId,
      notebookId: s.notebookId,
      provider: s.provider,
      status: "ready",
      startedAt: new Date(s.startedAt).toISOString(),
    };
  }

  /**
   * Python that wires the mako SDK inside the fresh kernel — the read-only
   * token + workspace so `mako.sources.sql.read(...)` proxies through the API.
   * Runs silently before any user code; each kernel is its own process, so this
   * never leaks across co-tenant kernels.
   */
  private kernelInitCode(session: KernelSession): string {
    const apiUrl =
      process.env.NOTEBOOK_KERNEL_API_URL || process.env.BASE_URL || "";
    const env = {
      MAKO_API_URL: apiUrl,
      MAKO_WORKSPACE_ID: session.workspaceId,
      MAKO_KERNEL_TOKEN: session.kernelToken,
    };
    return `import os as _os\n_os.environ.update(${JSON.stringify(env)})\n`;
  }

  get(workspaceId: string, notebookId: string): KernelSessionInfo | null {
    const s = this.sessions.get(key(workspaceId, notebookId));
    return s ? this.toInfo(s) : null;
  }

  /**
   * Start (or return the existing) kernel session for a notebook. Idempotent:
   * a second call while a session is live returns the same one.
   */
  async start(input: {
    workspaceId: string;
    notebookId: string;
    userId: string;
  }): Promise<KernelSessionInfo> {
    const { workspaceId, notebookId, userId } = input;
    const existing = this.sessions.get(key(workspaceId, notebookId));
    if (existing) return this.toInfo(existing);

    const provider = getKernelProvider();
    if (!provider) throw new KernelUnavailableError();

    const endpoint = await provider.acquire({ workspaceId, notebookId });
    const kernelId = await kernelGatewayClient.startKernel(endpoint.baseUrl);
    const kernelToken = mintKernelToken({ workspaceId, userId, notebookId });

    const now = Date.now();
    const session: KernelSession = {
      sessionId: randomUUID(),
      workspaceId,
      notebookId,
      userId,
      provider: provider.name,
      endpoint,
      kernelId,
      kernelToken,
      startedAt: now,
      lastActivityAt: now,
      queue: Promise.resolve(),
    };
    this.sessions.set(key(workspaceId, notebookId), session);

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

    logger.info("started kernel session", {
      sessionId: session.sessionId,
      provider: provider.name,
      pod: endpoint.podName,
      notebookId,
    });
    return this.toInfo(session);
  }

  /**
   * Execute `code` on the notebook's kernel, streaming outputs. Serializes
   * behind any in-flight execution on the same kernel (FIFO). Throws
   * {@link KernelUnavailableError} if no session is running.
   */
  async execute(
    workspaceId: string,
    notebookId: string,
    code: string,
    onOutput: (o: KernelOutput) => void,
    opts: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    const session = this.sessions.get(key(workspaceId, notebookId));
    if (!session) throw new KernelUnavailableError("No kernel session running");

    const run = session.queue.then(() => {
      session.lastActivityAt = Date.now();
      return kernelGatewayClient.execute(
        session.endpoint.baseUrl,
        session.kernelId,
        code,
        onOutput,
        opts,
      );
    });
    // Keep the FIFO chain alive even if this run rejects.
    session.queue = run.catch(() => undefined);
    const result = await run;
    session.lastActivityAt = Date.now();
    return result;
  }

  /** Stop a session: delete the kernel and release the pod. Best-effort. */
  async stop(workspaceId: string, notebookId: string): Promise<boolean> {
    const k = key(workspaceId, notebookId);
    const session = this.sessions.get(k);
    if (!session) return false;
    this.sessions.delete(k);
    await kernelGatewayClient.deleteKernel(
      session.endpoint.baseUrl,
      session.kernelId,
    );
    const provider = getKernelProvider();
    await provider?.release(session.endpoint).catch(() => undefined);
    logger.info("stopped kernel session", { sessionId: session.sessionId });
    return true;
  }

  /** Sessions idle past the TTL — used by the reaper (future Inngest sweep). */
  idleSessions(nowMs = Date.now()): Array<{
    workspaceId: string;
    notebookId: string;
  }> {
    const stale: Array<{ workspaceId: string; notebookId: string }> = [];
    for (const s of this.sessions.values()) {
      if (nowMs - s.lastActivityAt > IDLE_TTL_MS) {
        stale.push({ workspaceId: s.workspaceId, notebookId: s.notebookId });
      }
    }
    return stale;
  }
}

export const kernelSessionService = new KernelSessionService();
