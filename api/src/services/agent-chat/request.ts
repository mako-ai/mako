/**
 * Step 1 of a chat turn: who is asking, what they sent, and whether they may
 * run a turn in that workspace (and, for "chat with app", on that app).
 *
 * Every check answers with a `StepFailure` instead of a Response so the
 * route decides the wire shape; the order of the checks is the order the
 * route has always run them in (the 400/403/401 a client sees for a bad
 * request depends on it).
 */
import { ObjectId } from "mongodb";
import type { UIMessage } from "ai";

import type { AgentContext } from "../../agents";
import { authorizeAppChat } from "../../apps/app-chat.service";
import { workspaceService } from "../workspace.service";
import type { ScreenshotVisionAttachment } from "../agent-stream.service";

/** A failed pipeline step: the status and message the route answers with. */
export interface StepFailure {
  ok: false;
  status: 400 | 401 | 402 | 403 | 404;
  error: string;
}

export type StepResult<T> = ({ ok: true } & T) | StepFailure;

export function stepFailure(
  status: StepFailure["status"],
  error: string,
): StepFailure {
  return { ok: false, status, error };
}

// OpenConsoleContext matches frontend's smart truncation format.
// Note: isActive is computed on backend using consoleId param to avoid
// frontend re-render loops.
export interface OpenConsoleContext {
  id: string;
  title: string;
  connectionId?: string;
  connectionName?: string;
  connectionType?: string;
  databaseId?: string;
  databaseName?: string;
  content: string;
  contentTruncated: boolean;
  lineCount: number;
}

export interface ActiveConsoleResults {
  viewMode: "table" | "json" | "chart";
  hasResults: boolean;
  rowCount: number;
  columns: string[];
  sampleRows: Record<string, unknown>[];
  chartSpec: Record<string, unknown> | null;
}

export interface OpenTabContext {
  id: string;
  kind: string;
  title: string;
  isActive: boolean;
  flowId?: string;
  notebookId?: string;
  connectionId?: string;
  databaseName?: string;
  dbtProjectId?: string;
}

/** The POST /api/agent/chat body as the client sends it (unvalidated). */
export interface ChatRequestBody {
  messages?: UIMessage[];
  chatId?: string;
  workspaceId?: string;
  openConsoles?: OpenConsoleContext[];
  openTabs?: OpenTabContext[];
  consoleId?: string;
  modelId?: string;
  activeConsoleResults?: ActiveConsoleResults;
  agentId?: string;
  activeView?: "console" | "flow-editor" | "empty";
  activeExplorer?: "databases" | "consoles" | "connectors" | "flows" | null;
  tabKind?: string;
  flowType?: string;
  flowFormState?: Record<string, unknown>;
  screenshotVisionAttachments?: ScreenshotVisionAttachment[];
  /** "Chat with app" (agentId "app_chat"): the published app. */
  appId?: string;
  /** The app's query string as the viewer sees it (filters, tabs). */
  appSearch?: string;
}

/** The authenticated principal as the auth middleware left it. */
export interface ChatPrincipal {
  user?: { id: string; email?: string } | null;
  workspace?: { _id: { toString(): string } } | null;
  apiKey?: { createdBy?: unknown } | null;
}

/**
 * Actor ID: user ID for session auth, the API key's creator for programmatic
 * access (so its chats appear in the creator's history when they log in).
 * Email is the human-friendly identifier surfaced in Langfuse; absent for
 * API-key access.
 */
export function resolveChatActor(
  principal: ChatPrincipal,
): { actorId: string; actorEmail: string | undefined } | null {
  const { user, workspace, apiKey } = principal;
  const actorId =
    user?.id ??
    (apiKey?.createdBy
      ? String(apiKey.createdBy)
      : workspace
        ? "api-key"
        : undefined);
  if (!actorId) return null;
  return { actorId, actorEmail: user?.email };
}

/**
 * May this principal act in `workspaceId`? API keys must belong to it;
 * session users must be members. Shared by the chat turn and the
 * client-tool-failure report.
 */
export async function authorizeWorkspaceAccess(
  principal: ChatPrincipal,
  workspaceId: string,
): Promise<StepFailure | null> {
  const { user, workspace } = principal;
  if (workspace) {
    if (workspace._id.toString() !== workspaceId) {
      return stepFailure(403, "API key not authorized for this workspace");
    }
    return null;
  }
  if (user) {
    const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
    return hasAccess ? null : stepFailure(403, "Access denied to workspace");
  }
  // Neither API key nor session auth succeeded — reject.
  return stepFailure(401, "Unauthorized");
}

export interface ValidatedChatRequest {
  body: ChatRequestBody;
  messages: UIMessage[];
  workspaceId: string;
}

/** `messages` and `workspaceId` — the two fields checked before access. */
export function validateChatRequest(
  body: ChatRequestBody,
): StepResult<ValidatedChatRequest> {
  const { messages, workspaceId } = body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return stepFailure(400, "'messages' array is required");
  }
  if (!workspaceId || !ObjectId.isValid(workspaceId)) {
    return stepFailure(400, "'workspaceId' is required and must be valid");
  }
  return { ok: true, body, messages, workspaceId };
}

/**
 * "Chat with app": the closed app_chat agent, offered to anyone who can read
 * the app (its live-link audience), so it is gated on the app's own access
 * check rather than on what a workspace member may do. Returns
 * `appChat: undefined` for every other agent.
 */
export async function authorizeAppChatRequest(
  principal: ChatPrincipal,
  workspaceId: string,
  body: ChatRequestBody,
): Promise<StepResult<{ appChat: AgentContext["appChat"] }>> {
  if (body.agentId !== "app_chat") return { ok: true, appChat: undefined };
  const { user, workspace } = principal;
  if (!user || workspace) {
    return stepFailure(403, "App chat requires a signed-in user");
  }
  const access = await authorizeAppChat(
    workspaceId,
    typeof body.appId === "string" ? body.appId : "",
    user.id,
  );
  if (!access.ok) return stepFailure(access.status, access.error);
  return {
    ok: true,
    appChat: {
      project: access.project,
      title: access.title,
      search: typeof body.appSearch === "string" ? body.appSearch : undefined,
    },
  };
}

/** Owners/admins (and API keys) may manage scheduled queries from chat. */
export async function resolveCanManageScheduledQueries(
  principal: ChatPrincipal,
  workspaceId: string,
): Promise<boolean> {
  if (principal.workspace) return true;
  if (!principal.user?.id) return false;
  const member = await workspaceService.getMember(
    workspaceId,
    principal.user.id,
  );
  return member?.role === "owner" || member?.role === "admin";
}

/** The concatenated text parts of the last user message ("" when none). */
export function lastUserMessageText(messages: UIMessage[]): string {
  const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
  return (
    lastUserMsg?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map(p => p.text)
      .join("") ?? ""
  );
}
