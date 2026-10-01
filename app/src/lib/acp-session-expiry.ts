/**
 * Decide whether a local ACP session's Mako MCP Bearer is still usable.
 *
 * The `mcpat_` token is minted once on session/new and baked into the
 * adapter's MCP headers — it cannot be refreshed. Past its expiry every
 * `mako-workspace` tool call fails with "requires re-authorization (token
 * expired)" while `makoMcpAttached` still reads true, so Chat must stop
 * reusing such sessions and mint a fresh token instead.
 */
import type { AcpSessionInfo } from "./acp-types";

/**
 * Fallback lifetime when the session carries no explicit expiry (older Local
 * Agent, or Chat reloaded and lost the minted value). Mirrors
 * `ACCESS_TOKEN_TTL_MS` in `api/src/auth/mcp-oauth.service.ts`; the token is
 * minted immediately before session/new so `createdAt` is a close proxy.
 */
export const DEFAULT_MAKO_MCP_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Stop reusing a session this long before the token actually expires so a
 * long turn does not lose its tools halfway through.
 */
export const MAKO_MCP_TOKEN_REUSE_MARGIN_MS = 10 * 60 * 1000;

type SessionLike = Pick<
  AcpSessionInfo,
  "makoMcpAttached" | "makoMcpTokenExpiresAt" | "createdAt"
>;

/** Epoch ms when the session's Mako MCP token expires; null when unknown. */
export function makoMcpTokenExpiresAtMs(session: SessionLike): number | null {
  if (!session.makoMcpAttached) return null;
  if (session.makoMcpTokenExpiresAt) {
    const explicit = Date.parse(session.makoMcpTokenExpiresAt);
    if (Number.isFinite(explicit)) return explicit;
  }
  const created = Date.parse(session.createdAt || "");
  if (!Number.isFinite(created)) return null;
  return created + DEFAULT_MAKO_MCP_TOKEN_TTL_MS;
}

/** True when the session must not be reused for a new turn. */
export function isMakoMcpTokenStale(
  session: SessionLike,
  now: number = Date.now(),
): boolean {
  const expiresAt = makoMcpTokenExpiresAtMs(session);
  if (expiresAt === null) return false;
  return now + MAKO_MCP_TOKEN_REUSE_MARGIN_MS >= expiresAt;
}
