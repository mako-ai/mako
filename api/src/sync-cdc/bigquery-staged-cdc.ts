import { createHash } from "node:crypto";
import { Types, type ClientSession } from "mongoose";
import { z } from "zod";
import { CdcChangeEvent } from "../database/models/cdc";
import { WebhookEvent } from "../database/models/webhooks";
import { Flow } from "../database/workspace-schema";
import { cdcLiveTableName } from "./normalization";
import { cdcFlowWriteRevision } from "./cdc-flow-write-fence";

const objectId = z
  .string()
  .regex(/^[a-f0-9]{24}$/i)
  .toLowerCase();
const nonempty = z.string().trim().min(1);
export const bigQueryCdcScope = z.strictObject({
  workspaceId: objectId,
  flowId: objectId,
  sourceConnectionId: objectId,
  destinationConnectionId: objectId,
  definitionSha: nonempty,
  entity: nonempty,
  authorizationId: nonempty,
  originNamespace: nonempty,
});
const cdcBinding = z.strictObject({
  scope: bigQueryCdcScope,
  events: z
    .array(
      z.strictObject({
        id: objectId,
        deliveryKey: nonempty,
        originalReceipt: z
          .strictObject({
            id: objectId,
            flowId: objectId,
            sourceConnectionId: objectId,
            eventIdSha256: z.string().regex(/^[a-f0-9]{64}$/),
            receivedAt: z.iso.datetime({ precision: 3 }),
            recordId: z.string().min(1),
          })
          .optional(),
      }),
    )
    .min(1),
});

export type BigQueryCdcScope = z.infer<typeof bigQueryCdcScope>;

/**
 * The authorizing caller verifies the provider origin and revalidates the
 * destination connection revision and BigQuery project. Replay additionally
 * supplies the exact original inbox receipt for each target CDC row.
 */
export type BigQueryCdcBinding = z.infer<typeof cdcBinding>;

export function normalizeBigQueryCdcBinding(
  authorized: BigQueryCdcBinding,
): BigQueryCdcBinding {
  const binding = cdcBinding.parse(authorized);
  const { events } = binding;
  if (
    new Set(events.map(event => event.id)).size !== events.length ||
    new Set(events.map(event => event.deliveryKey)).size !== events.length
  ) {
    throw new Error(
      "Retained BigQuery writes require distinct CDC events and delivery keys",
    );
  }
  if (
    events.some(event => event.originalReceipt) &&
    events.some(event => !event.originalReceipt)
  ) {
    throw new Error(
      "Each row in a retained replay must bind its original receipt",
    );
  }
  events.sort((left, right) => left.id.localeCompare(right.id));
  return binding;
}

export class CdcBigQueryBindingChangedError extends Error {}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** A single delivery can produce multiple records in the same entity. */
export function bigQueryReplayDeliveryKey(
  eventIdSha256: string,
  recordId: string,
): string {
  return sha256(JSON.stringify([eventIdSha256, recordId]));
}

async function requireOriginalReceipts(
  binding: BigQueryCdcBinding,
  session: ClientSession,
): Promise<void> {
  const linked = binding.events.flatMap(event =>
    event.originalReceipt
      ? [{ ...event.originalReceipt, key: event.deliveryKey }]
      : [],
  );
  if (linked.length === 0) return;
  const receipts = await WebhookEvent.find({
    _id: { $in: linked.map(link => new Types.ObjectId(link.id)) },
    workspaceId: new Types.ObjectId(binding.scope.workspaceId),
    lane: null,
    $expr: {
      $and: [
        { $eq: ["$status", "dormant"] },
        { $eq: ["$applyStatus", "dormant"] },
      ],
    },
  })
    .select({ flowId: 1, dataSourceId: 1, receivedAt: 1, eventId: 1 })
    .session(session)
    .lean();
  const byId = new Map(receipts.map(receipt => [String(receipt._id), receipt]));
  for (const link of linked) {
    const receipt = byId.get(link.id);
    if (
      !receipt ||
      String(receipt.flowId) !== link.flowId ||
      String(receipt.dataSourceId) !== link.sourceConnectionId ||
      receipt.receivedAt?.toJSON() !== link.receivedAt ||
      !receipt.eventId?.trim() ||
      sha256(receipt.eventId) !== link.eventIdSha256 ||
      bigQueryReplayDeliveryKey(link.eventIdSha256, link.recordId) !== link.key
    ) {
      throw new CdcBigQueryBindingChangedError(
        "Retained CDC replay does not match the original inbox receipt",
      );
    }
  }
}

interface CdcTarget {
  dataset: string;
  table: string;
}

export async function requireCurrentBigQueryCdcFlow(
  scope: BigQueryCdcScope,
  target: CdcTarget,
  session?: ClientSession,
): Promise<void> {
  const filter = {
    _id: new Types.ObjectId(scope.flowId),
    workspaceId: new Types.ObjectId(scope.workspaceId),
    sourceType: "connector" as const,
    dataSourceId: new Types.ObjectId(scope.sourceConnectionId),
    destinationDatabaseId: new Types.ObjectId(scope.destinationConnectionId),
    sourceBlobSha: scope.definitionSha,
    syncEngine: "cdc" as const,
    writeMode: "append_dedup" as const,
    definitionInvalid: { $exists: false },
    "tableDestination.connectionId": new Types.ObjectId(
      scope.destinationConnectionId,
    ),
    "tableDestination.schema": target.dataset,
  };
  const flowQuery = Flow.findOne(filter).select("tableDestination.tableName");
  const flow = await (
    session ? flowQuery.session(session) : flowQuery.readConcern("majority")
  ).lean();
  const table =
    flow && cdcLiveTableName(flow.tableDestination?.tableName, scope.entity);
  if (table !== target.table) {
    throw new CdcBigQueryBindingChangedError(
      "Retained CDC flow binding changed",
    );
  }
  if (session) {
    // A concurrent replacement of the flow must conflict with this transaction.
    const result = await Flow.collection.updateOne(
      filter,
      cdcFlowWriteRevision,
      { session },
    );
    if (result.matchedCount !== 1) {
      throw new CdcBigQueryBindingChangedError(
        "Retained CDC flow binding changed",
      );
    }
  }
}

function pendingEvents(binding: BigQueryCdcBinding) {
  const { events } = binding;
  const idFilter = events.some(event => event.originalReceipt)
    ? {
        $or: events.map(({ id, originalReceipt }) => ({
          _id: new Types.ObjectId(id),
          webhookEventId: originalReceipt?.id,
          recordId: originalReceipt?.recordId,
        })),
      }
    : { _id: { $in: events.map(event => new Types.ObjectId(event.id)) } };
  return {
    ...idFilter,
    workspaceId: new Types.ObjectId(binding.scope.workspaceId),
    flowId: new Types.ObjectId(binding.scope.flowId),
    entity: binding.scope.entity,
    sourceKind: "webhook" as const,
    op: "upsert" as const,
    materializationStatus: "pending" as const,
  };
}

/** Read the verified original receipt and exact pending rows at one Mongo snapshot. */
export async function readBigQueryReplayInputRows(binding: BigQueryCdcBinding) {
  if (binding.events.some(event => !event.originalReceipt)) {
    throw new Error(
      "A retained replay input requires original receipts for every row",
    );
  }
  return CdcChangeEvent.db.transaction(
    async session => {
      await requireOriginalReceipts(binding, session);
      const rows = await CdcChangeEvent.find({
        ...pendingEvents(binding),
        retainedBigQueryWrite: { $exists: false },
        ordinaryWebhookWriteStarted: { $ne: true },
      })
        .select({ recordId: 1, sourceTs: 1, ingestSeq: 1, payload: 1 })
        .sort({ _id: 1 })
        .session(session)
        .lean();
      if (
        rows.length !== binding.events.length ||
        new Set(rows.map(row => row.recordId)).size !== rows.length
      ) {
        throw new CdcBigQueryBindingChangedError(
          "The exact replay input rows are unavailable or repeat a record",
        );
      }
      return rows;
    },
    { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
  );
}

export async function claimBigQueryCdcEvents(
  binding: BigQueryCdcBinding,
  fingerprint: string,
  session: ClientSession,
): Promise<void> {
  await requireOriginalReceipts(binding, session);
  const result = await CdcChangeEvent.updateMany(
    {
      ...pendingEvents(binding),
      retainedBigQueryWrite: { $exists: false },
      ordinaryWebhookWriteStarted: { $ne: true },
    },
    { $set: { retainedBigQueryWrite: fingerprint } },
    { session },
  );
  if (result.matchedCount !== binding.events.length) {
    throw new CdcBigQueryBindingChangedError(
      "The exact pending CDC events could not be reserved",
    );
  }
}

export async function applyClaimedBigQueryCdcEvents(
  binding: BigQueryCdcBinding,
  fingerprint: string,
  session: ClientSession,
): Promise<void> {
  const result = await CdcChangeEvent.updateMany(
    { ...pendingEvents(binding), retainedBigQueryWrite: fingerprint },
    {
      $set: { materializationStatus: "applied", appliedAt: new Date() },
      $inc: { materializationAttemptCount: 1 },
      $unset: { materializationError: "" },
    },
    { session },
  );
  if (result.matchedCount !== binding.events.length) {
    throw new CdcBigQueryBindingChangedError(
      "The bound CDC events changed before settlement",
    );
  }
}

/** Move the exact pending rows without making them visible to ordinary dispatch. */
export async function transferClaimedBigQueryCdcEvents(
  binding: BigQueryCdcBinding,
  previousFingerprint: string,
  nextFingerprint: string,
  session: ClientSession,
): Promise<void> {
  const result = await CdcChangeEvent.updateMany(
    {
      ...pendingEvents(binding),
      retainedBigQueryWrite: previousFingerprint,
      ordinaryWebhookWriteStarted: { $ne: true },
    },
    { $set: { retainedBigQueryWrite: nextFingerprint } },
    { session },
  );
  if (result.matchedCount !== binding.events.length) {
    throw new CdcBigQueryBindingChangedError(
      "The exact pending CDC claims could not move to the retry",
    );
  }
}

export async function haveClaimedBigQueryCdcEvents(
  binding: BigQueryCdcBinding,
  fingerprint: string,
): Promise<boolean> {
  const count = await CdcChangeEvent.countDocuments({
    ...pendingEvents(binding),
    retainedBigQueryWrite: fingerprint,
  }).readConcern("majority");
  return count === binding.events.length;
}
