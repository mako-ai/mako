import { Types, type ClientSession } from "mongoose";
import { z } from "zod";
import { CdcChangeEvent } from "../database/models/cdc";
import { Flow } from "../database/workspace-schema";
import { cdcLiveTableName } from "./normalization";

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
    .array(z.strictObject({ id: objectId, deliveryKey: nonempty }))
    .min(1),
});

export type BigQueryCdcScope = z.infer<typeof bigQueryCdcScope>;

/**
 * The authorizing caller derives each key from its exact webhook-backed CDC
 * event and revalidates the destination connection revision and BigQuery
 * project. This schema holds the resulting trusted binding.
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
  events.sort((left, right) => left.id.localeCompare(right.id));
  return binding;
}

export class CdcBigQueryBindingChangedError extends Error {}

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
      { $inc: { retainedBigQueryWriteRevision: 1 } },
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
  return {
    _id: { $in: binding.events.map(event => new Types.ObjectId(event.id)) },
    workspaceId: new Types.ObjectId(binding.scope.workspaceId),
    flowId: new Types.ObjectId(binding.scope.flowId),
    entity: binding.scope.entity,
    sourceKind: "webhook" as const,
    op: "upsert" as const,
    materializationStatus: "pending" as const,
  };
}

export async function claimBigQueryCdcEvents(
  binding: BigQueryCdcBinding,
  fingerprint: string,
  session: ClientSession,
): Promise<void> {
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
