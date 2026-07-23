/**
 * Helpers for ACP session/request_permission auto-approval.
 *
 * Mako MCP tools are already scoped by workspace OAuth (`mcp` + `query:read`);
 * prompting on every list_connections / sql_execute_query call makes local
 * Claude feel broken compared to the in-app agent. File edits / bash still
 * require an explicit UI click.
 */

export function extractToolCallName(toolCall: unknown): string {
  if (!toolCall || typeof toolCall !== "object") return "";
  const tc = toolCall as {
    name?: unknown;
    title?: unknown;
    _meta?: { claudeCode?: { toolName?: unknown } };
  };
  const candidates = [
    tc.name,
    tc._meta?.claudeCode?.toolName,
    tc.title,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function extractToolCallKind(toolCall: unknown): string {
  if (!toolCall || typeof toolCall !== "object") return "";
  const kind = (toolCall as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : "";
}

/** Claude Agent SDK names MCP tools `mcp__{server}__{tool}`. */
export function isMakoMcpToolName(name: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return (
    lower.startsWith("mcp__mako__") ||
    lower === "mcp__mako" ||
    lower.startsWith("mcp__mako ") ||
    // Some UIs put the server name in the title only.
    /\bmcp__mako\b/i.test(name) ||
    /^mako\b/i.test(name)
  );
}

/** Safe to auto-approve without a human click (reads / search / think). */
export function isAutoApproveToolKind(kind: string): boolean {
  return (
    kind === "read" ||
    kind === "search" ||
    kind === "think" ||
    kind === "fetch"
  );
}

export function pickAllowOptionId(options: unknown[]): string | null {
  const opts = (Array.isArray(options) ? options : []) as Array<{
    optionId?: unknown;
    kind?: unknown;
  }>;
  const normalized = opts
    .map(o => ({
      optionId: typeof o.optionId === "string" ? o.optionId : "",
      kind: typeof o.kind === "string" ? o.kind : "",
    }))
    .filter(o => o.optionId);

  const always = normalized.find(o => o.kind === "allow_always");
  if (always) return always.optionId;
  const once = normalized.find(
    o => o.kind === "allow_once" || o.kind.startsWith("allow"),
  );
  return once?.optionId ?? null;
}

export function shouldAutoApprovePermission(input: {
  toolCall: unknown;
  options: unknown[];
}): { optionId: string } | null {
  const optionId = pickAllowOptionId(input.options);
  if (!optionId) return null;

  const name = extractToolCallName(input.toolCall);
  const kind = extractToolCallKind(input.toolCall);

  // Any mcp__mako__* tool is already authorized by the workspace MCP Bearer
  // we attached on session/new — never click-tax those.
  if (isMakoMcpToolName(name)) {
    return { optionId };
  }
  if (isAutoApproveToolKind(kind)) {
    return { optionId };
  }
  return null;
}
