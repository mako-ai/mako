import type { ClientSession, Connection, Types } from "mongoose";

export interface InlineWebhookScope {
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  sourceConnectionId: Types.ObjectId;
}

interface AdmissionRecord {
  _id: string;
  closed: boolean;
  admissions: number;
}

function records(connection: Connection) {
  if (!connection.db) throw new Error("MongoDB connection is not open");
  return connection.db.collection<AdmissionRecord>("inline_webhook_admissions");
}

function scopeKey(scope: InlineWebhookScope): string {
  return [scope.workspaceId, scope.flowId, scope.sourceConnectionId]
    .map(id => id.toHexString())
    .join(":");
}

export interface VerifiedLateWebhook {
  sourceConnectionId: Types.ObjectId;
  eventId: string;
  eventType: string;
  rawPayload: unknown;
  signature?: string;
}

/** Retain a verified delivery only after this exact scope has closed. */
export async function retainClosedInlineWebhook(
  connection: Connection,
  scope: InlineWebhookScope,
  delivery: VerifiedLateWebhook,
): Promise<"retained" | "duplicate"> {
  if (!delivery.sourceConnectionId.equals(scope.sourceConnectionId)) {
    throw new Error("Verified webhook source does not match the closed scope");
  }
  const gate = await records(connection).findOne(
    { _id: scopeKey(scope), closed: true },
    { readConcern: { level: "majority" } },
  );
  if (!gate) throw new Error("Webhook admission scope is not confirmed closed");
  if (!connection.db) throw new Error("MongoDB connection is not open");
  const inbox = connection.db.collection("webhookevents");
  const binding = {
    flowId: scope.flowId,
    workspaceId: scope.workspaceId,
    dataSourceId: scope.sourceConnectionId,
    eventId: delivery.eventId,
  };
  try {
    await inbox.insertOne(
      {
        ...binding,
        eventType: delivery.eventType,
        rawPayload: delivery.rawPayload,
        ...(delivery.signature === undefined
          ? {}
          : { signature: delivery.signature }),
        receivedAt: new Date(),
        status: "dormant",
        applyStatus: "dormant",
        attempts: 0,
        applyAttempts: 0,
      },
      { writeConcern: { w: "majority" } },
    );
    return "retained";
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const existing = await inbox.findOne(binding, {
      readConcern: { level: "majority" },
    });
    if (!existing) throw error;
    return "duplicate";
  }
}

/** Permanently closes this scope to new inline admissions. This does not drain work. */
export async function closeInlineWebhookAdmission(
  connection: Connection,
  scope: InlineWebhookScope,
): Promise<void> {
  const collection = records(connection);
  const _id = scopeKey(scope);
  try {
    await collection.updateOne(
      { _id },
      { $set: { closed: true }, $setOnInsert: { admissions: 0 } },
      { upsert: true, writeConcern: { w: "majority" } },
    );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    await collection.updateOne(
      { _id },
      { $set: { closed: true } },
      { writeConcern: { w: "majority" } },
    );
  }
}

/**
 * Persists a delivery only while its scope is open. The callback MUST persist
 * the delivery using the supplied session and must have no external side
 * effects: MongoDB may retry it. Every write needed to admit the delivery must
 * use that same session. The gate write and those writes commit together.
 * A successful admission does not imply that the delivery has been processed.
 */
export async function admitInlineWebhook<T>(
  connection: Connection,
  scope: InlineWebhookScope,
  persist: (session: ClientSession) => Promise<T>,
): Promise<{ admitted: true; value: T } | { admitted: false }> {
  const collection = records(connection);
  const _id = scopeKey(scope);
  // Create outside the transaction. A competing close can create it first;
  // $setOnInsert can never reopen that record.
  try {
    await collection.updateOne(
      { _id },
      { $setOnInsert: { closed: false, admissions: 0 } },
      { upsert: true, writeConcern: { w: "majority" } },
    );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  const session = await connection.startSession();
  try {
    return await session.withTransaction(
      async () => {
        const gate = await collection.updateOne(
          { _id, closed: false },
          { $inc: { admissions: 1 } },
          { session },
        );
        if (gate.matchedCount === 0) return { admitted: false } as const;
        const value = await persist(session);
        return { admitted: true, value } as const;
      },
      { writeConcern: { w: "majority" } },
    );
  } finally {
    await session.endSession();
  }
}
