/**
 * Jupyter Kernel Gateway client — the wire protocol the control plane speaks to
 * a kernel pod. Two transports, both directly to the pod IP (never through the
 * browser): REST for kernel lifecycle (`POST/DELETE /api/kernels`) and a
 * websocket for execution (`/api/kernels/:id/channels`, the Jupyter messaging
 * protocol v5.3).
 *
 * Validated against the real gVisor kernel image: `execute_request` → iopub
 * `stream`/`execute_result` (rich mime bundles incl. text/html for DataFrames)
 * → `status: idle` completion.
 */
import WebSocket from "ws";

import { loggers } from "../../logging";
import type { ExecuteResult, KernelOutput } from "./types";

const logger = loggers.api("kernel-gateway");

/** A raw Jupyter protocol message (only the fields we read). */
interface JupyterMessage {
  header?: { msg_type?: string };
  parent_header?: { msg_id?: string };
  content?: Record<string, unknown>;
  msg_type?: string; // some gateways duplicate it at top level
}

/**
 * Map a raw Jupyter iopub/shell message to a rendered {@link KernelOutput}, or
 * `null` for messages the renderer ignores (status, execute_input, clear, …).
 * Pure — unit-tested independently of the socket.
 */
export function mapKernelMessage(msg: JupyterMessage): KernelOutput | null {
  const type = msg.header?.msg_type ?? msg.msg_type;
  const content = msg.content ?? {};
  switch (type) {
    case "stream": {
      const name = content.name === "stderr" ? "stderr" : "stdout";
      return { type: "stream", name, text: String(content.text ?? "") };
    }
    case "execute_result":
      return {
        type: "result",
        data: (content.data as Record<string, unknown>) ?? {},
      };
    case "display_data":
      return {
        type: "display",
        data: (content.data as Record<string, unknown>) ?? {},
      };
    case "error":
      return {
        type: "error",
        ename: String(content.ename ?? "Error"),
        evalue: String(content.evalue ?? ""),
        traceback: Array.isArray(content.traceback)
          ? (content.traceback as string[])
          : [],
      };
    default:
      return null; // status, execute_input, clear_output, comm_*, …
  }
}

/** Is this an iopub `status: idle` for the given request — i.e. done? */
function isIdleFor(msg: JupyterMessage, msgId: string): boolean {
  return (
    (msg.header?.msg_type ?? msg.msg_type) === "status" &&
    msg.parent_header?.msg_id === msgId &&
    (msg.content?.execution_state as string) === "idle"
  );
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2) + Date.now().toString(36)
  );
}

export interface ExecuteOptions {
  /** Wall-clock cap for a single execution. */
  timeoutMs?: number;
  /** Cancels the execution (client disconnect / user stop / reaper). */
  signal?: AbortSignal;
}

export class KernelGatewayClient {
  /** Start a python kernel on the gateway; returns its kernel id. */
  async startKernel(baseUrl: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/kernels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "python3" }),
    });
    if (!res.ok) {
      throw new Error(`startKernel failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  /** Delete a kernel (frees its memory on the pod). Best-effort. */
  async deleteKernel(baseUrl: string, kernelId: string): Promise<void> {
    try {
      await fetch(`${baseUrl}/api/kernels/${kernelId}`, { method: "DELETE" });
    } catch (error) {
      logger.warn("deleteKernel failed", { error, kernelId });
    }
  }

  /**
   * Execute `code` on the kernel, streaming each rendered output to `onOutput`,
   * and resolve when the kernel returns to idle. Rejects on timeout/abort.
   */
  execute(
    baseUrl: string,
    kernelId: string,
    code: string,
    onOutput: (o: KernelOutput) => void,
    opts: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/api/kernels/${kernelId}/channels`;
    const msgId = randomId();
    const session = randomId();

    return new Promise<ExecuteResult>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let executionCount: number | null = null;
      let status: ExecuteResult["status"] = "ok";
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      };
      const finish = (result: ExecuteResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onAbort = () => fail(new Error("execution aborted"));

      const timer = setTimeout(
        () => fail(new Error("execution timed out")),
        opts.timeoutMs ?? 120_000,
      );
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            header: {
              msg_id: msgId,
              session,
              username: "mako",
              msg_type: "execute_request",
              version: "5.3",
            },
            parent_header: {},
            metadata: {},
            channel: "shell",
            content: {
              code,
              silent: false,
              store_history: true,
              user_expressions: {},
              allow_stdin: false,
              stop_on_error: true,
            },
          }),
        );
      });

      ws.on("message", raw => {
        let msg: JupyterMessage;
        try {
          msg = JSON.parse(raw.toString()) as JupyterMessage;
        } catch {
          return;
        }
        // Ignore anything not caused by our request (kernels can be co-driven).
        if (msg.parent_header?.msg_id !== msgId) return;

        const msgType = msg.header?.msg_type ?? msg.msg_type;
        if (msgType === "execute_reply") {
          status = (msg.content?.status as ExecuteResult["status"]) ?? "ok";
          executionCount =
            (msg.content?.execution_count as number | undefined) ??
            executionCount;
        }
        const output = mapKernelMessage(msg);
        if (output) {
          if (output.type === "result" || output.type === "display") {
            const ec = (msg.content?.execution_count as number) ?? null;
            if (ec != null) executionCount = ec;
          }
          try {
            onOutput(output);
          } catch (error) {
            logger.warn("onOutput threw", { error });
          }
        }

        if (isIdleFor(msg, msgId)) finish({ status, executionCount });
      });

      ws.on("error", err => fail(err instanceof Error ? err : new Error(String(err))));
      ws.on("close", () => {
        if (!settled) fail(new Error("kernel socket closed before idle"));
      });
    });
  }
}

export const kernelGatewayClient = new KernelGatewayClient();
