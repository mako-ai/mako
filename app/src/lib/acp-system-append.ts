/**
 * Workspace guidance for Local Agent ACP systemPrompt.append.
 * Keeps skills on demand via MCP — passes truncated custom prompt +
 * self-directive (same durable context native Chat injects).
 */
import { api } from "../api/client";

const MAX_CUSTOM_PROMPT_CHARS = 4_000;
const MAX_SELF_DIRECTIVE_CHARS = 2_000;

/** Skip the stock Settings template so we don't burn ACP context on placeholder text. */
function looksLikeDefaultCustomPrompt(text: string): boolean {
  return (
    text.includes("This is your custom prompt that will be combined") ||
    text.includes("# Custom Prompt Configuration")
  );
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n…(truncated)`;
}

export async function fetchWorkspaceGuidanceForAcp(
  workspaceId: string,
): Promise<string | undefined> {
  if (!workspaceId.trim()) return undefined;

  const sections: string[] = [];

  try {
    const { data, response } = await api.GET(
      "/api/workspaces/{workspaceId}/custom-prompt",
      { params: { path: { workspaceId } } },
    );
    if (response.ok && data && typeof data === "object") {
      const body = data as {
        success?: boolean;
        content?: unknown;
        selfDirective?: unknown;
      };
      if (body.success !== false) {
        const content = body.content;
        if (
          typeof content === "string" &&
          content.trim() &&
          !looksLikeDefaultCustomPrompt(content)
        ) {
          sections.push(truncate(content, MAX_CUSTOM_PROMPT_CHARS));
        }
        // Prefer bundled selfDirective from the custom-prompt payload when present.
        if (
          typeof body.selfDirective === "string" &&
          body.selfDirective.trim()
        ) {
          sections.push(
            `## Self-directive (learned workspace rules)\n${truncate(body.selfDirective, MAX_SELF_DIRECTIVE_CHARS)}`,
          );
        }
      }
    }
  } catch {
    /* ignore */
  }

  // Fallback: workspace document may expose selfDirective even when the
  // custom-prompt route does not (older API) — and custom prompt lives in settings.
  if (
    sections.length === 0 ||
    !sections.some(s => s.startsWith("## Self-directive"))
  ) {
    try {
      const { data, response } = await api.GET("/api/workspaces/{id}", {
        params: { path: { id: workspaceId } },
      });
      if (response.ok && data && typeof data === "object") {
        const envelope = data as {
          data?: {
            selfDirective?: unknown;
            settings?: { customPrompt?: unknown };
          };
        };
        const ws = envelope.data;
        if (
          sections.length === 0 &&
          typeof ws?.settings?.customPrompt === "string" &&
          ws.settings.customPrompt.trim() &&
          !looksLikeDefaultCustomPrompt(ws.settings.customPrompt)
        ) {
          sections.push(
            truncate(ws.settings.customPrompt, MAX_CUSTOM_PROMPT_CHARS),
          );
        }
        if (
          !sections.some(s => s.startsWith("## Self-directive")) &&
          typeof ws?.selfDirective === "string" &&
          ws.selfDirective.trim()
        ) {
          sections.push(
            `## Self-directive (learned workspace rules)\n${truncate(ws.selfDirective, MAX_SELF_DIRECTIVE_CHARS)}`,
          );
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (sections.length === 0) return undefined;
  return sections.join("\n\n");
}
