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
 * Persists a delivery only while its scope is open. Admissions in the same
 * scope serialize on one gate document until the transaction finishes.
 * The driver can retry the transaction after a gate conflict. The failed
 * attempt never reaches `persist`. A transient failure after `persist` starts
 * can make the driver rerun it.
 * `persist` MUST use the supplied MongoDB session for every write and MUST NOT
 * perform external side effects. The gate and delivery writes commit together.
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
