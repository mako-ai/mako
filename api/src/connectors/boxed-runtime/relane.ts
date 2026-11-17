/**
 * A switch back to the built-in connector, for webhooks: the flow's pending
 * box-lane events go to the inline lane. Its own module so that callers
 * (shadow.service.ts, webhook-batch.ts) need no Inngest function.
 */
import type { Types } from "mongoose";
import { WebhookEvent } from "../../database/workspace-schema";

/**
 * Hand a flow's pending box-lane events, verified for this connection, to
 * the inline lane (a switch back to the built-in connector). Returns how
 * many moved. Events for another connection stay and are dropped.
 */
export async function relaneBoxEventsToInline(
  flowId: Types.ObjectId,
  connectionId: Types.ObjectId,
): Promise<number> {
  const result = await WebhookEvent.updateMany(
    {
      flowId,
      dataSourceId: connectionId,
      lane: "box",
      status: "pending",
    },
    { $unset: { lane: 1, dataSourceId: 1, boxClaim: 1, claimedAt: 1 } },
  );
  return result.modifiedCount ?? 0;
}

/**
 * A switch back: the promoted twin's pending box-lane events, forwarded
 * from the built-in flow's URL, go back to that flow's inline lane. An
 * event the built-in flow already holds (a delivery stored before the
 * switch) is dropped from the twin instead of duplicated.
 */
export async function moveBoxEventsToFlow(
  fromFlowId: Types.ObjectId,
  toFlowId: Types.ObjectId,
  connectionId: Types.ObjectId,
): Promise<number> {
  const pending = (await WebhookEvent.find({
    flowId: fromFlowId,
    dataSourceId: connectionId,
    lane: "box",
    status: "pending",
  })
    .select("_id")
    .lean()) as Array<{ _id: Types.ObjectId }>;
  let moved = 0;
  for (const event of pending) {
    try {
      const result = await WebhookEvent.updateOne(
        { _id: event._id, status: "pending", lane: "box" },
        {
          $set: { flowId: toFlowId },
          $unset: { lane: 1, dataSourceId: 1, boxClaim: 1, claimedAt: 1 },
        },
      );
      moved += result.modifiedCount ?? 0;
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000) throw error;
      await WebhookEvent.deleteOne({ _id: event._id, status: "pending" });
    }
  }
  return moved;
}
