import { Db } from "mongodb";

export const description =
  "Keep active CLI and external MCP OAuth grants renewable until revoked";

export async function up(db: Db): Promise<void> {
  // Never revive expired grants or extend session-minted Desktop ACP access.
  // Unsetting the date also excludes these grants from the existing TTL index.
  await db.collection("mcpoauthtokens").updateMany(
    {
      clientId: { $ne: "mako-acp-local" },
      refreshExpiresAt: { $gt: new Date() },
    },
    { $unset: { refreshExpiresAt: "" } },
  );
}
