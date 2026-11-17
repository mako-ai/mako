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
