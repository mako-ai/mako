/**
 * Polls Local Agent for mako-desktop MCP jobs (run_app / get_preview_errors)
 * and executes them against the live Desktop iframe preview store.
 */
import { executeAppAgentTool } from "../app-runtime/agent-tools";
import { useAppStore } from "../store/appStore";
import { localAgentClient } from "./local-agent-client";

interface BridgeJob {
  id: string;
  tool: "run_app" | "get_preview_errors";
  arguments: Record<string, unknown>;
}

interface ClaimEnvelope {
  success: boolean;
  data?: { job: BridgeJob | null };
  error?: string;
}

let running = false;
let abort: AbortController | null = null;

async function executeJob(job: BridgeJob): Promise<unknown> {
  const appId = String(job.arguments.appId || "").trim();
  if (!appId) {
    throw new Error("appId is required");
  }

  if (job.tool === "get_preview_errors") {
    const errors = useAppStore.getState().previewErrors[appId] ?? [];
    return {
      success: true,
      appId,
      errors: errors.map(e => ({ message: e.message, source: e.source })),
    };
  }

  return executeAppAgentTool("run_app", { appId });
}

async function completeJob(
  id: string,
  payload: { ok: true; result: unknown } | { ok: false; error: string },
): Promise<void> {
  await localAgentClient.post(
    `/desktop/bridge/jobs/${encodeURIComponent(id)}/result`,
    payload,
    {
      signal: abort?.signal,
    },
  );
}

async function pollLoop(): Promise<void> {
  while (running && !abort?.signal.aborted) {
    try {
      await localAgentClient.post(
        "/desktop/bridge/hello",
        {},
        { signal: abort?.signal },
      );
      const body = await localAgentClient.post<ClaimEnvelope>(
        "/desktop/bridge/claim",
        { waitMs: 20_000 },
        { signal: abort?.signal },
      );
      const job = body.data?.job;
      if (!job) continue;
      try {
        const result = await executeJob(job);
        await completeJob(job.id, { ok: true, result });
      } catch (error) {
        await completeJob(job.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      if (abort?.signal.aborted) return;
      // Agent down / LNA — back off briefly.
      const message = error instanceof Error ? error.message : String(error);
      if (/abort|timeout/i.test(message)) {
        continue;
      }
      await new Promise(r => setTimeout(r, 2_000));
    }
  }
}

/**
 * Start the Desktop ACP bridge poller (idempotent). Safe to call from Chat
 * mount — quietly backs off when Local Agent is not running.
 */
export function startDesktopAcpBridge(): () => void {
  if (running) {
    return () => stopDesktopAcpBridge();
  }
  running = true;
  abort = new AbortController();
  void pollLoop();
  return () => stopDesktopAcpBridge();
}

export function stopDesktopAcpBridge(): void {
  running = false;
  abort?.abort();
  abort = null;
}
