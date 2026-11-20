/**
 * A workspace's own byte cap for interactive BigQuery queries, in GiB
 * (`settings.bigqueryMaxBytesBilledGb`; 0 turns the cap off). Read on every
 * BigQuery job, so it is cached for 30 s and a failed read means "unset":
 * a Mongo hiccup never fails a query. The setting route clears the entry.
 * See databases/drivers/bigquery/agent-caps.ts for the precedence.
 */
import mongoose from "mongoose";
import { Workspace } from "../database/workspace-schema";

const TTL_MS = 30_000;
const cache = new Map<string, { gb: number | undefined; at: number }>();

export async function workspaceByteCapGb(
  workspaceId: unknown,
): Promise<number | undefined> {
  if (!workspaceId) return undefined;
  const id = String(workspaceId);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.gb;
  // No Mongo connection (unit tests, scripts): nothing to read.
  if (mongoose.connection.readyState !== 1 || !mongoose.isValidObjectId(id)) {
    return undefined;
  }
  try {
    const workspace = await Workspace.findById(id)
      .select("settings.bigqueryMaxBytesBilledGb")
      .maxTimeMS(2000)
      .lean();
    const raw = workspace?.settings?.bigqueryMaxBytesBilledGb;
    const gb = typeof raw === "number" && raw >= 0 ? raw : undefined;
    cache.set(id, { gb, at: Date.now() });
    return gb;
  } catch {
    return undefined;
  }
}

export function clearWorkspaceByteCapCache(workspaceId: string): void {
  cache.delete(workspaceId);
}
