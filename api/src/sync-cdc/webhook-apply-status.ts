import type { Types } from "mongoose";
import { CdcChangeEvent } from "../database/workspace-schema";

/** A receipt can fan out into several independently materialized entities. */
export async function webhookReceiptIdsReadyToApply(
  scope: { flowId: Types.ObjectId; workspaceId?: Types.ObjectId },
  receiptIds: Types.ObjectId[],
): Promise<Types.ObjectId[]> {
  if (receiptIds.length === 0) return [];

  const incomplete = await CdcChangeEvent.distinct("webhookEventId", {
    ...scope,
    webhookEventId: { $type: "string", $in: receiptIds.map(String) },
    materializationStatus: { $in: ["pending", "failed", "dropped"] },
  });
  const blocked = new Set(incomplete);
  return receiptIds.filter(id => !blocked.has(String(id)));
}
