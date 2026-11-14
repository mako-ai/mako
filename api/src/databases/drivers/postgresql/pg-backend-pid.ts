import type { PoolClient, ClientBase } from "pg";

/**
 * The server process id of a connected pg client — what `pg_cancel_backend`
 * takes. pg records it from the BackendKeyData message at connect time
 * (`client.processID`), so reading it costs no round trip; @types/pg simply
 * does not declare the field. Falls back to `SELECT pg_backend_pid()` for a
 * server or proxy that did not send BackendKeyData.
 */
export async function pgBackendPid(
  client: PoolClient | ClientBase,
): Promise<number | undefined> {
  const known = (client as unknown as { processID?: unknown }).processID;
  if (typeof known === "number" && known > 0) return known;
  const result = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const pid = result.rows?.[0]?.pid;
  return typeof pid === "number" ? pid : undefined;
}
