/**
 * Polls Local Agent for mako-desktop MCP jobs and fulfills them in the
 * Desktop/web renderer (apps, consoles, HITL clarify/plan cards).
 */
import { summarizePreviewErrors } from "@mako/agent-tools";
import { executeAppAgentTool } from "../app-runtime/agent-tools";
import { useAppStore } from "../store/appStore";
import { useConsoleStore } from "../store/consoleStore";
import {
  useDesktopHitlStore,
  type DesktopHitlToolName,
} from "../store/desktopHitlStore";
import { localAgentClient } from "./local-agent-client";

type BridgeToolName =
  | "run_app"
  | "get_preview_errors"
  | "list_open_consoles"
  | DesktopHitlToolName;

interface BridgeJob {
  id: string;
  tool: BridgeToolName;
  arguments: Record<string, unknown>;
}

interface ClaimEnvelope {
  success: boolean;
  data?: { job: BridgeJob | null };
  error?: string;
}

const HITL_TOOLS = new Set<BridgeToolName>([
  "ask_clarifying_questions",
  "submit_plan",
]);

let running = false;
let abort: AbortController | null = null;

function listOpenConsolesResult(): unknown {
  const store = useConsoleStore.getState();
  const consoles = Object.values(store.tabs)
    .filter(t => !t.kind || t.kind === "console")
    .map(t => ({
      id: t.id,
      title: t.title,
      connectionId: t.connectionId,
      databaseName: t.databaseName,
      isActive: t.id === store.activeTabId,
    }));
  return { success: true, consoles };
}

async function executeImmediateJob(job: BridgeJob): Promise<unknown> {
  if (job.tool === "list_open_consoles") {
    return listOpenConsolesResult();
  }

  const appId = String(job.arguments.appId || "").trim();
  if (!appId) {
    throw new Error("appId is required");
  }

  if (job.tool === "get_preview_errors") {
    // Read-only — never bumpPreview / rebuild the iframe (that blacks out
    // the app preview and can remount Chat mid-turn).
    return {
      success: true,
      appId,
      errors: summarizePreviewErrors(
        useAppStore.getState().previewErrors[appId],
      ),
    };
  }

  if (job.tool === "run_app") {
    return executeAppAgentTool("run_app", { appId });
  }

  throw new Error(`Unsupported desktop bridge tool: ${job.tool}`);
}

export async function completeDesktopHitlJob(
  jobId: string,
  result: unknown,
): Promise<void> {
  await localAgentClient.post(
    `/desktop/bridge/jobs/${encodeURIComponent(jobId)}/result`,
    { ok: true, result },
  );
  useDesktopHitlStore.getState().clearPending(jobId);
}

export async function failDesktopHitlJob(
  jobId: string,
  error: string,
): Promise<void> {
  await localAgentClient.post(
    `/desktop/bridge/jobs/${encodeURIComponent(jobId)}/result`,
    { ok: false, error },
  );
  useDesktopHitlStore.getState().clearPending(jobId);
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

      if (HITL_TOOLS.has(job.tool)) {
        useDesktopHitlStore.getState().setPending({
          jobId: job.id,
          toolName: job.tool as DesktopHitlToolName,
          input:
            job.arguments && typeof job.arguments === "object"
              ? job.arguments
              : {},
          createdAt: Date.now(),
        });
        // Completes when Chat dock cards call completeDesktopHitlJob.
        continue;
      }

      try {
        const result = await executeImmediateJob(job);
        await completeJob(job.id, { ok: true, result });
      } catch (error) {
        await completeJob(job.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      if (abort?.signal.aborted) return;
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
