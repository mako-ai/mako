import type { Db } from "mongodb";
import { indexesOf } from "./index-helpers";

export const description = "Index CDC outcomes by flow and webhook receipt";

const keys = {
  flowId: 1,
  webhookEventId: 1,
  materializationStatus: 1,
} as const;

export async function up(db: Db): Promise<void> {
  const collection = db.collection("cdc_change_events");
  const target = JSON.stringify(keys);
  const indexes = await indexesOf(collection);
  if (indexes.some(index => JSON.stringify(index.key) === target)) return;

  await collection.createIndex(keys, {
    partialFilterExpression: { webhookEventId: { $type: "string" } },
  });
}
