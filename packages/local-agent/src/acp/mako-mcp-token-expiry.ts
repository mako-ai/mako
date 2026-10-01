/**
 * The Mako MCP Bearer (`mcpat_…`) is minted once per ACP session/new and baked
 * into the adapter's MCP server headers; nothing can refresh it mid-session.
 * Once it expires every `mako-workspace` tool call fails with Claude Code's
 * "requires re-authorization (token expired)" while the session itself looks
 * healthy. Local Agent records the expiry so prompt() can retire the session
 * and let Chat mint a fresh token instead of reusing a dead one.
 */
import type { AcpSessionInfo } from "./types";

/** Normalize a client-supplied expiry to ISO; undefined when absent/invalid. */
export function parseMcpTokenExpiresAt(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function isMakoMcpTokenExpired(
  info: Pick<AcpSessionInfo, "makoMcpAttached" | "makoMcpTokenExpiresAt">,
  now: number = Date.now(),
): boolean {
  if (!info.makoMcpAttached || !info.makoMcpTokenExpiresAt) return false;
  const expiresAt = Date.parse(info.makoMcpTokenExpiresAt);
  return Number.isFinite(expiresAt) && now >= expiresAt;
}
