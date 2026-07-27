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

/**
 * True for Mako workspace / desktop MCP tools under either naming scheme:
 * - Claude Agent SDK: `mcp__mako-workspace__list_connections`
 * - Codex ACP titles: `mcp.mako-desktop.get_preview_errors` /
 *   `Mcp.Mako-Workspace.Sql Execute Query`
 *
 * Codex marks these `kind: "execute"`, so without this match they sit in
 * request_permission forever (black / stuck Chat) while Claude's `mcp__*`
 * names auto-approve.
 */
export function isMakoMcpToolName(name: string): boolean {
  if (!name) return false;
  const lower = name.trim().toLowerCase();
  if (
    lower.startsWith("mcp__mako-workspace") ||
    lower.startsWith("mcp__mako-desktop") ||
    lower.startsWith("mcp__mako__") ||
    lower === "mcp__mako"
  ) {
    return true;
  }
  // Codex dotted / Title Case forms (server segment may include hyphens).
  if (/^mcp\.mako(-workspace|-desktop)?(\.|$)/.test(lower)) {
    return true;
  }
  return /\bmcp__mako(-workspace|-desktop)?\b/i.test(name);
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

export function pickRejectOptionId(options: unknown[]): string | null {
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

  const rejectAlways = normalized.find(o => o.kind === "reject_always");
  if (rejectAlways) return rejectAlways.optionId;
  const rejectOnce = normalized.find(
    o => o.kind === "reject_once" || o.kind.startsWith("reject"),
  );
  return rejectOnce?.optionId ?? null;
}

/**
 * Claude Code's on-disk project memory — durable Mako knowledge must use
 * mcp__mako-workspace__update_self_directive instead.
 */
export function isClaudeLocalMemoryPath(path: string): boolean {
  if (!path) return false;
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/.claude/") &&
    (normalized.endsWith("/memory.md") ||
      normalized.includes("/memory/") ||
      normalized.includes("/.claude/projects/"))
  );
}

function extractToolCallPaths(toolCall: unknown): string[] {
  if (!toolCall || typeof toolCall !== "object") return [];
  const tc = toolCall as {
    rawInput?: unknown;
    input?: unknown;
    path?: unknown;
    locations?: unknown;
  };
  const candidates: unknown[] = [tc.path, tc.rawInput, tc.input];
  const paths: string[] = [];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      paths.push(value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const rec = value as Record<string, unknown>;
    for (const key of ["path", "file_path", "filePath", "file", "target"]) {
      if (typeof rec[key] === "string" && rec[key].trim()) {
        paths.push(String(rec[key]));
      }
    }
  }
  if (Array.isArray(tc.locations)) {
    for (const loc of tc.locations) {
      if (loc && typeof loc === "object") {
        const path = (loc as { path?: unknown }).path;
        if (typeof path === "string" && path.trim()) paths.push(path);
      }
    }
  }
  return paths;
}

/** True when this permission is a write/edit targeting Claude local memory. */
export function isClaudeLocalMemoryWrite(toolCall: unknown): boolean {
  const name = extractToolCallName(toolCall).toLowerCase();
  const kind = extractToolCallKind(toolCall).toLowerCase();
  const looksLikeWrite =
    kind === "edit" ||
    kind === "write" ||
    name === "write" ||
    name === "edit" ||
    name.includes("write") ||
    name.includes("edit");
  if (!looksLikeWrite && !extractToolCallPaths(toolCall).length) {
    return false;
  }
  return extractToolCallPaths(toolCall).some(isClaudeLocalMemoryPath);
}

export function shouldAutoApprovePermission(input: {
  toolCall: unknown;
  options: unknown[];
}): { optionId: string } | null {
  // Hard-block Claude Code local MEMORY.md writes — use Mako self-directive.
  if (isClaudeLocalMemoryWrite(input.toolCall)) {
    const rejectId = pickRejectOptionId(input.options);
    if (rejectId) return { optionId: rejectId };
    return null;
  }

  const optionId = pickAllowOptionId(input.options);
  if (!optionId) return null;

  const name = extractToolCallName(input.toolCall);
  const kind = extractToolCallKind(input.toolCall);

  // Workspace MCP tools are already authorized by the Bearer we attached on
  // session/new — never click-tax those.
  if (isMakoMcpToolName(name)) {
    return { optionId };
  }
  if (isAutoApproveToolKind(kind)) {
    return { optionId };
  }
  return null;
}
