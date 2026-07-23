/**
 * Workspace guidance for Local Agent ACP systemPrompt.append.
 * Keeps skills on demand via MCP — only passes a truncated custom prompt.
 */
import { api } from "../api/client";

const MAX_CUSTOM_PROMPT_CHARS = 4_000;

/** Skip the stock Settings template so we don't burn ACP context on placeholder text. */
function looksLikeDefaultCustomPrompt(text: string): boolean {
  return (
    text.includes("This is your custom prompt that will be combined") ||
    text.includes("# Custom Prompt Configuration")
  );
}

export async function fetchWorkspaceGuidanceForAcp(
  workspaceId: string,
): Promise<string | undefined> {
  if (!workspaceId.trim()) return undefined;
  try {
    const { data, response } = await api.GET(
      "/api/workspaces/{workspaceId}/custom-prompt",
      { params: { path: { workspaceId } } },
    );
    if (!response.ok || !data || typeof data !== "object") return undefined;
    const body = data as { success?: boolean; content?: unknown };
    if (body.success === false) return undefined;
    const content = body.content;
    if (typeof content !== "string" || !content.trim()) return undefined;
    if (looksLikeDefaultCustomPrompt(content)) return undefined;
    const trimmed = content.trim();
    if (trimmed.length <= MAX_CUSTOM_PROMPT_CHARS) return trimmed;
    return `${trimmed.slice(0, MAX_CUSTOM_PROMPT_CHARS)}\n…(truncated)`;
  } catch {
    return undefined;
  }
}
