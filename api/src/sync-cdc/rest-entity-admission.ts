import { createHash } from "node:crypto";
import { NonRetriableError } from "inngest";
import type { ClientSession, Connection, Types } from "mongoose";
import type { FetchState } from "../connectors/base/BaseConnector";
import { stableStringify } from "./normalization";

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

export interface RestEntityOverwriteReservation {
  scope: RestEntityAdmissionScope;
  overwrite: RestEntityOverwrite;
}

interface AdmissionRecord {
  _id: string;
  closed: boolean;
  admissions: number;
  pendingOverwrites?: RestEntityOverwrite[];
  overwriteWriteRevision?: number;
  verifiedOverwrites?: Array<{
    overwriteHash: string;
    manifestHash: string;
    checkpointHash?: string;
    fetchState?: FetchState;
  }>;
}

export class RestEntityAdmissionClosedError extends NonRetriableError {
  constructor() {
    super("REST entity admission is closed");
  }
}

class RestEntityOverwriteSealedError extends NonRetriableError {
  constructor() {
    super("REST overwrite already has a verified manifest");
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

function overwriteKey(overwrite: RestEntityOverwrite): string {
  return createHash("sha256").update(stableStringify(overwrite)).digest("hex");
}

function conflictingOverwrite({
  runId,
  entity,
  ...destination
}: RestEntityOverwrite) {
  return {
    ...destination,
    $or: [{ runId: { $ne: runId } }, { entity: { $ne: entity } }],
  };
}

async function assertNoConflictingOverwrite(
  connection: Connection,
  scope: RestEntityAdmissionScope,
  overwrite: RestEntityOverwrite,
): Promise<void> {
  const pending = await records(connection).findOne(
    {
      _id: scopeKey(scope),
      pendingOverwrites: { $elemMatch: conflictingOverwrite(overwrite) },
    },
    { readConcern: { level: "majority" }, projection: { _id: 1 } },
  );
  if (pending) {
    throw new Error(
      "Another REST overwrite for this destination is still in flight",
    );
  }
}

async function ensureAdmissionRecord(
  connection: Connection,
  scope: RestEntityAdmissionScope,
) {
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
  return { collection, _id };
}

/** Close new admissions only if there are no pending overwrites. */
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
  const overwriteHash = overwriteKey(overwrite);
  const result = await collection.updateOne(
    {
      _id,
      closed: false,
      "verifiedOverwrites.overwriteHash": { $ne: overwriteHash },
      pendingOverwrites: {
        $not: { $elemMatch: conflictingOverwrite(overwrite) },
      },
    },
    { $addToSet: { pendingOverwrites: overwrite } },
    { writeConcern: { w: "majority" } },
  );
  if (result.matchedCount === 1) return;
  const sealed = await collection.findOne(
    { _id, closed: false, "verifiedOverwrites.overwriteHash": overwriteHash },
    { readConcern: { level: "majority" }, projection: { _id: 1 } },
  );
  if (sealed) throw new RestEntityOverwriteSealedError();
  await assertNoConflictingOverwrite(connection, scope, overwrite);
  throw new RestEntityAdmissionClosedError();
}

export async function hasPendingRestEntityOverwrite(
  connection: Connection,
  scope: RestEntityAdmissionScope,
  overwrite: RestEntityOverwrite,
  session?: ClientSession,
): Promise<boolean> {
  const record = await records(connection).findOne(
    {
      _id: scopeKey(scope),
      closed: false,
      pendingOverwrites: { $elemMatch: overwrite },
    },
    {
      ...(session ? { session } : { readConcern: { level: "majority" } }),
      projection: { _id: 1 },
    },
  );
  return record !== null;
}

/** Recognize retained overwrites on retries even after new admissions are disabled. */
export async function hasRecordedRestEntityOverwrite(
  connection: Connection,
  { scope, overwrite }: RestEntityOverwriteReservation,
): Promise<boolean> {
  await assertNoConflictingOverwrite(connection, scope, overwrite);
  const record = await records(connection).findOne(
    {
      _id: scopeKey(scope),
      $or: [
        { pendingOverwrites: { $elemMatch: overwrite } },
        { "verifiedOverwrites.overwriteHash": overwriteKey(overwrite) },
      ],
    },
    { readConcern: { level: "majority" }, projection: { _id: 1 } },
  );
  return record !== null;
}

/** Serialize a new replacement intent with verification of the complete write set. */
export async function registerRestEntityOverwriteWrite(
  connection: Connection,
  { scope, overwrite }: RestEntityOverwriteReservation,
  session: ClientSession,
): Promise<void> {
  const result = await records(connection).updateOne(
    {
      _id: scopeKey(scope),
      closed: false,
      pendingOverwrites: { $elemMatch: overwrite },
      verifiedOverwrites: {
        $not: { $elemMatch: { overwriteHash: overwriteKey(overwrite) } },
      },
    },
    { $inc: { overwriteWriteRevision: 1 } },
    { session },
  );
  if (result.matchedCount !== 1) {
    throw new Error(
      "BigQuery replacement requires a pending, unsealed REST overwrite",
    );
  }
}

/** Freeze the verified write set while the overwrite remains pending. */
export async function recordVerifiedRestEntityOverwrite(
  connection: Connection,
  { scope, overwrite }: RestEntityOverwriteReservation,
  manifestHash: string,
  session: ClientSession,
  fetchState?: FetchState,
): Promise<boolean> {
  const overwriteHash = overwriteKey(overwrite);
  const checkpointHash = fetchState
    ? createHash("sha256").update(stableStringify(fetchState)).digest("hex")
    : undefined;
  const verified = {
    overwriteHash,
    manifestHash,
    ...(checkpointHash ? { checkpointHash, fetchState } : {}),
  };
  const result = await records(connection).updateOne(
    {
      _id: scopeKey(scope),
      closed: false,
      pendingOverwrites: { $elemMatch: overwrite },
      verifiedOverwrites: {
        $not: {
          $elemMatch: {
            overwriteHash,
            $or: [
              { manifestHash: { $ne: manifestHash } },
              { checkpointHash: { $ne: checkpointHash ?? null } },
            ],
          },
        },
      },
    },
    { $addToSet: { verifiedOverwrites: verified } },
    { session },
  );
  return result.matchedCount === 1;
}

/** Read the exact sealed digest without changing the reservation. */
export async function readVerifiedRestEntityOverwrite(
  connection: Connection,
  { scope, overwrite }: RestEntityOverwriteReservation,
  manifestHash: string,
): Promise<{ fetchState?: FetchState } | undefined> {
  const verified = { overwriteHash: overwriteKey(overwrite), manifestHash };
  const result = await records(connection).findOne(
    {
      _id: scopeKey(scope),
      verifiedOverwrites: { $elemMatch: verified },
    },
    {
      readConcern: { level: "majority" },
      projection: { verifiedOverwrites: { $elemMatch: verified } },
    },
  );
  return result?.verifiedOverwrites?.[0];
}

/** Release the reservation only for its verified manifest. */
export async function releaseVerifiedRestEntityOverwrite(
  connection: Connection,
  { scope, overwrite }: RestEntityOverwriteReservation,
  manifestHash: string,
  session: ClientSession,
): Promise<"released" | "already-released" | null> {
  const verified = { overwriteHash: overwriteKey(overwrite), manifestHash };
  const result = await records(connection).updateOne(
    {
      _id: scopeKey(scope),
      verifiedOverwrites: { $elemMatch: verified },
    },
    { $pull: { pendingOverwrites: overwrite } },
    { session },
  );
  if (result.matchedCount !== 1) return null;
  if (result.modifiedCount !== 1) return "already-released";
  await records(connection).updateOne(
    { _id: scopeKey(scope), verifiedOverwrites: { $elemMatch: verified } },
    { $unset: { "verifiedOverwrites.$.fetchState": "" } },
    { session },
  );
  return "released";
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
