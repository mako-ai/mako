import { Db } from "mongodb";
import { refreshIdleTtlMs } from "../auth/mcp-oauth.service";

export const description =
  "Give never-expiring MCP OAuth refresh tokens a sliding idle expiry";

/**
 * Browser-authorized MCP grants used to be renewable forever (see
 * 2026-09-06-230000_persistent_mcp_oauth_grants), so a leaked `mcprt_` was a
 * permanent foothold. New grants now carry a sliding idle expiry; this gives
 * every existing grant without one the same window, starting now, so a
 * client in use keeps working (its next refresh slides the date) and an
 * abandoned grant lapses — and the existing TTL index reaps it.
 *
 * Idempotent: only grants with no date are touched. Desktop ACP grants
 * always have one.
 */
export async function up(db: Db): Promise<void> {
  const idle = refreshIdleTtlMs();
  if (idle === null) return; // MCP_REFRESH_TOKEN_IDLE_DAYS=0: keep as-is
  await db.collection("mcpoauthtokens").updateMany(
    {
      clientId: { $ne: "mako-acp-local" },
      refreshExpiresAt: { $exists: false },
    },
    { $set: { refreshExpiresAt: new Date(Date.now() + idle) } },
  );
}
