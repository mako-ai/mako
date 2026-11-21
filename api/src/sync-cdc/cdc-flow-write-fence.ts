import { type ClientSession, type Types } from "mongoose";
import { CdcChangeEvent, Flow } from "../database/workspace-schema";

export const cdcFlowWriteRevision = {
  $inc: { retainedBigQueryWriteRevision: 1 },
};

/** Make maintenance and retained admission contend on the same flow document. */
export async function withCdcFlowWriteFence<T>(
  flowIds: Types.ObjectId[],
  run: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return Flow.db.transaction(
    async session => {
      await Flow.collection.updateMany(
        { _id: { $in: flowIds } },
        cdcFlowWriteRevision,
        { session },
      );
      return run(session);
    },
    {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    },
  );
}

/** One inbox delivery may fan out into CDC rows in more than one entity. */
export async function excludeRetainedInboxPeers<
  T extends { webhookEventId?: string },
>(rows: T[], flowIds: Types.ObjectId[], session: ClientSession): Promise<T[]> {
  const inboxIds = [
    ...new Set(
      rows.flatMap(row => (row.webhookEventId ? [row.webhookEventId] : [])),
    ),
  ];
  if (inboxIds.length === 0) return rows;
  const retained = await CdcChangeEvent.find({
    flowId: { $in: flowIds },
    webhookEventId: { $in: inboxIds },
    retainedBigQueryWrite: { $exists: true },
  })
    .select({ webhookEventId: 1 })
    .session(session)
    .lean();
  const held = new Set(retained.map(row => row.webhookEventId));
  return rows.filter(row => !held.has(row.webhookEventId));
}
