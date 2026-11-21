import { NonRetriableError } from "inngest";
import type { Connection, Types } from "mongoose";

export interface RestEntityAdmissionScope {
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  sourceConnectionId: Types.ObjectId;
}

export interface RestEntityAdmissionContext {
  scope: RestEntityAdmissionScope;
  runId?: string;
}

export interface RestEntityOverwrite {
  runId: string;
  entity: string;
  destinationId: string;
  destinationDatabaseName: string | null;
  destinationConnectionId: string;
  schema: string;
  tableName: string;
}

interface AdmissionRecord {
  _id: string;
  closed: boolean;
  admissions: number;
  pendingOverwrites?: RestEntityOverwrite[];
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

async function ensureAdmissionRecord(
  connection: Connection,
  scope: RestEntityAdmissionScope,
) {
  const collection = records(connection);
  const _id = [scope.workspaceId, scope.flowId, scope.sourceConnectionId]
    .map(id => id.toHexString())
    .join(":");
  try {
    await collection.updateOne(
      { _id },
      { $setOnInsert: { closed: false, admissions: 0 } },
      { upsert: true, writeConcern: { w: "majority" } },
    );
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  return { collection, _id };
}

/** Close new admissions once all destructive overwrite reservations settle. */
export async function closeRestEntityAdmission(
  connection: Connection,
  scope: RestEntityAdmissionScope,
): Promise<void> {
  const { collection, _id } = await ensureAdmissionRecord(connection, scope);
  const result = await collection.updateOne(
    { _id, "pendingOverwrites.0": { $exists: false } },
    { $set: { closed: true } },
    { writeConcern: { w: "majority" } },
  );
  if (result.matchedCount !== 1) {
    throw new Error("REST overwrite is still in flight");
  }
}

/** Reserve on the admission record before truncation can reach the destination. */
export async function reserveRestEntityOverwrite(
  connection: Connection,
  scope: RestEntityAdmissionScope,
  overwrite: RestEntityOverwrite,
): Promise<void> {
  const { collection, _id } = await ensureAdmissionRecord(connection, scope);
  const result = await collection.updateOne(
    { _id, closed: false },
    { $addToSet: { pendingOverwrites: overwrite } },
    { writeConcern: { w: "majority" } },
  );
  if (result.matchedCount !== 1) throw new RestEntityAdmissionClosedError();
}

/** Atomically order this attempt against closure without holding a read open. */
export async function admitRestEntity(
  connection: Connection,
  scope: RestEntityAdmissionScope,
): Promise<boolean> {
  const { collection, _id } = await ensureAdmissionRecord(connection, scope);
  const result = await collection.updateOne(
    { _id, closed: false },
    { $inc: { admissions: 1 } },
    { writeConcern: { w: "majority" } },
  );
  return result.matchedCount === 1;
}
