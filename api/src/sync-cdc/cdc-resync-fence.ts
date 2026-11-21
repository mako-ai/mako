import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongoose";
import { Flow } from "../database/workspace-schema";
import type { BigQueryTableIdentity } from "./bigquery-retained-query";

export interface CdcResyncScope {
  workspaceId: string;
  flowId: string;
  entities?: string[];
  tables: BigQueryTableIdentity[];
}

interface ResyncFence {
  _id: string;
  revision?: number;
  resetTokens?: string[];
}

function fences() {
  return Flow.db.collection<ResyncFence>("cdc_resync_fences");
}

function fenceKeys(
  tables: BigQueryTableIdentity[],
  flow?: Pick<CdcResyncScope, "workspaceId" | "flowId">,
): string[] {
  const keys = tables.map(({ project, dataset, table }) =>
    JSON.stringify(["bigquery", project, dataset, table]),
  );
  if (flow) keys.push(JSON.stringify(["flow", flow.workspaceId, flow.flowId]));
  return [...new Set(keys)].sort();
}

export class CdcResyncConflictError extends Error {}

/** A retained intent and resync must serialize on every shared key in Mongo. */
export async function reserveRetainedWriteAgainstResync(
  tables: BigQueryTableIdentity[],
  flow: Pick<CdcResyncScope, "workspaceId" | "flowId"> | undefined,
  session: ClientSession,
): Promise<void> {
  const collection = fences();
  for (const _id of fenceKeys(tables, flow)) {
    const record = await collection.findOneAndUpdate(
      { _id },
      { $inc: { revision: 1 } },
      { upsert: true, returnDocument: "after", session },
    );
    if (!record || record.resetTokens?.length) {
      throw new CdcResyncConflictError(
        "A CDC resync is holding this flow or table",
      );
    }
  }
}

/** Keep the reset marker when a failed or interrupted drop might still land. */
export async function withCdcResyncFence<T>(
  scope: CdcResyncScope,
  assertDrained: (session: ClientSession) => Promise<void>,
  reset: () => Promise<T>,
): Promise<T> {
  const collection = fences();
  const keys = fenceKeys(scope.tables, scope);
  const token = randomUUID();
  await Flow.db.transaction(
    async session => {
      for (const _id of keys) {
        await collection.updateOne(
          { _id },
          { $addToSet: { resetTokens: token } },
          { upsert: true, session },
        );
      }
      await assertDrained(session);
    },
    {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    },
  );

  const result = await reset();
  await collection.updateMany(
    { _id: { $in: keys } },
    { $pull: { resetTokens: token } },
    { writeConcern: { w: "majority" } },
  );
  return result;
}
