import { NonRetriableError } from "inngest";
import type { Connection, Types } from "mongoose";

export interface RestEntityAdmissionScope {
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  sourceConnectionId: Types.ObjectId;
}

interface AdmissionRecord {
  _id: string;
  closed: boolean;
  admissions: number;
}

export class RestEntityAdmissionClosedError extends NonRetriableError {
  constructor() {
    super("REST entity admission is closed");
  }
}

export async function assertRestEntityAdmission(
  connection: Connection,
  scope: RestEntityAdmissionScope,
): Promise<void> {
  if (!(await admitRestEntity(connection, scope))) {
    throw new RestEntityAdmissionClosedError();
  }
}

function records(connection: Connection) {
  if (!connection.db) throw new Error("MongoDB connection is not open");
  return connection.db.collection<AdmissionRecord>("rest_entity_admissions");
}

function scopeKey(scope: RestEntityAdmissionScope): string {
  return [scope.workspaceId, scope.flowId, scope.sourceConnectionId]
    .map(id => id.toHexString())
    .join(":");
}

/** Close new admissions. Already admitted work is not drained. */
export async function closeRestEntityAdmission(
  connection: Connection,
  scope: RestEntityAdmissionScope,
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

/** Atomically order this attempt against closure without holding a read open. */
export async function admitRestEntity(
  connection: Connection,
  scope: RestEntityAdmissionScope,
): Promise<boolean> {
  const collection = records(connection);
  const _id = scopeKey(scope);
  try {
    await collection.updateOne(
      { _id },
      { $setOnInsert: { closed: false, admissions: 0 } },
      { upsert: true, writeConcern: { w: "majority" } },
    );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  const result = await collection.updateOne(
    { _id, closed: false },
    { $inc: { admissions: 1 } },
    { writeConcern: { w: "majority" } },
  );
  return result.matchedCount === 1;
}
