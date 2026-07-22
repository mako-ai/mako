/**
 * KernelProvider — the seam between the notebook control plane (Cloud Run) and
 * the stateful Python execution plane. A provider knows how to *acquire* a
 * kernel endpoint (a pod running the Jupyter Kernel Gateway) and *release* it;
 * the gateway protocol itself (start kernel, execute, delete) lives in
 * `kernel-gateway-client.ts` and is provider-independent.
 *
 * GKEKernelProvider is the default (claims a warm pod from the `kernel-pool`
 * Deployment on the mako-notebooks GKE cluster). Modal / Cloud Run GPU
 * providers can implement the same interface later without touching callers.
 */

/** A single rendered output produced by executing code on a kernel. */
export type KernelOutput =
  // stdout / stderr text (may arrive in many small chunks).
  | { type: "stream"; name: "stdout" | "stderr"; text: string }
  // `execute_result` / `display_data` — a mime bundle (text/plain, text/html,
  // image/png, application/json, …). The renderer picks the richest it knows.
  | { type: "result"; data: Record<string, unknown>; execile?: never }
  | { type: "display"; data: Record<string, unknown> }
  // an uncaught exception in the executed code.
  | { type: "error"; ename: string; evalue: string; traceback: string[] };

/** Terminal result of an execution request. */
export interface ExecuteResult {
  status: "ok" | "error" | "abort";
  /** The kernel's monotonic execution counter (`In [n]`). */
  executionCount: number | null;
}

/** A live kernel a session is bound to. */
export interface KernelHandle {
  /** Our session id (not the gateway's kernel id). */
  sessionId: string;
  /** Gateway base URL, e.g. `http://10.201.3.4:8888`. */
  baseUrl: string;
  /** The gateway's kernel id (from `POST /api/kernels`). */
  kernelId: string;
  /** Provider-specific placement info (pod name, node) for diagnostics/release. */
  placement: { podName?: string; podIp: string; provider: string };
}

export interface AcquireOptions {
  workspaceId: string;
  notebookId: string;
}

/** An acquired-but-not-yet-started kernel pod endpoint. */
export interface KernelEndpoint {
  baseUrl: string;
  podName?: string;
  podIp: string;
}

export interface KernelProvider {
  readonly name: string;
  /** Claim a ready kernel pod and return its gateway endpoint. */
  acquire(opts: AcquireOptions): Promise<KernelEndpoint>;
  /** Release the pod back to the pool (or terminate it). Best-effort. */
  release(endpoint: KernelEndpoint): Promise<void>;
}
