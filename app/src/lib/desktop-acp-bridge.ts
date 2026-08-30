/**
 * Polls Local Agent for mako-desktop MCP jobs and fulfills them in the
 * Desktop/web renderer (apps, consoles, HITL clarify/plan cards).
 */
import { type CapabilityGrant } from "@mako/agent-tools";
import { useConsoleStore } from "../store/consoleStore";
import {
  useDesktopHitlStore,
  type DesktopHitlToolName,
} from "../store/desktopHitlStore";
import { useAcpStore } from "../store/acpStore";
import { localAgentClient } from "./local-agent-client";

type BridgeToolName =
  | "run_app"
  // Legacy alias from pre-0.3 Local Agent builds — run_app({ rebuild: false }).
  | "get_preview_errors"
  | "list_open_consoles"
  | DesktopHitlToolName;

interface BridgeJob {
  id: string;
  tool: BridgeToolName;
  arguments: Record<string, unknown>;
  agentSessionId?: string;
  workspaceId?: string;
  /**
   * Delivery capabilities of the enqueuing Local Agent build. Absent on
   * older builds — which must never receive inline image payloads (they
   * stringify the whole result into the model context).
   */
  capabilities?: { imageContent?: boolean };
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

  throw new Error(`Unsupported desktop bridge tool: ${job.tool}`);
}

export async function completeDesktopHitlJob(
  jobId: string,
  result: unknown,
): Promise<void> {
  const pending = useDesktopHitlStore.getState().pending;
  let approvedGrantContext:
    | { workspaceId: string; agentSessionId: string }
    | undefined;
  if (
    pending?.jobId === jobId &&
    pending.toolName === "submit_plan" &&
    result &&
    typeof result === "object"
  ) {
    const output = result as {
      decision?: unknown;
      editedPlan?: { planMarkdown?: unknown };
    };
    if (
      output.decision === "approve" ||
      output.decision === "request_changes" ||
      output.decision === "cancel"
    ) {
      if (!pending.agentSessionId || !pending.workspaceId) {
        throw new Error(
          "This plan came from an outdated Local Agent session. Restart the local session and submit the plan again.",
        );
      }
      const editedPlanMarkdown = output.editedPlan?.planMarkdown;
      const originalPlanMarkdown = pending.input.planMarkdown;
      const allowedGrants = new Set<CapabilityGrant>([
        "artifact-write",
        "warehouse-write",
        "git-write",
        "schedule-write",
      ]);
      const requestedGrants = Array.isArray(pending.input.requiredCapabilities)
        ? pending.input.requiredCapabilities.filter(
            (grant): grant is CapabilityGrant =>
              typeof grant === "string" &&
              allowedGrants.has(grant as CapabilityGrant),
          )
        : undefined;
      await useAcpStore.getState().applyPlanDecision({
        workspaceId: pending.workspaceId,
        agentSessionId: pending.agentSessionId,
        decision: output.decision,
        planMarkdown:
          typeof editedPlanMarkdown === "string"
            ? editedPlanMarkdown
            : typeof originalPlanMarkdown === "string"
              ? originalPlanMarkdown
              : undefined,
        grants: requestedGrants,
      });
      if (output.decision === "approve") {
        approvedGrantContext = {
          workspaceId: pending.workspaceId,
          agentSessionId: pending.agentSessionId,
        };
      }
    }
  }
  try {
    await localAgentClient.post(
      `/desktop/bridge/jobs/${encodeURIComponent(jobId)}/result`,
      { ok: true, result },
    );
  } catch (error) {
    if (approvedGrantContext) {
      await useAcpStore
        .getState()
        .applyPlanDecision({
          ...approvedGrantContext,
          decision: "cancel",
        })
        .catch(() => undefined);
    }
    throw error;
  }
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
          agentSessionId: job.agentSessionId,
          workspaceId: job.workspaceId,
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
