import { createHash } from "node:crypto";
import type { ClientSession, Connection } from "mongoose";
import { z } from "zod";
import { fullTableName } from "./adapters/bigquery-sql";
import type { BigQueryTarget } from "./adapters/bigquery-target";
import {
  readRetainedBigQueryJob,
  retainedQueryConfiguration,
  retainedQueryOutcome,
  type BigQueryJobIdentity,
  type BigQueryTableIdentity,
  type RetainedQueryConfiguration,
} from "./bigquery-retained-query";
import { stableStringify } from "./normalization";
import {
  hasPendingRestEntityOverwrite,
  type RestEntityOverwrite,
  type RestEntityOverwriteReservation,
} from "./rest-entity-admission";

import type { BigQueryStagedInput } from "./bigquery-staged-intent";
export type { BigQueryTableIdentity } from "./bigquery-retained-query";

export interface BigQueryInputSnapshot {
  input: BigQueryStagedInput;
  rows: number;
  baseTable: BigQueryTableIdentity;
  asOf: string;
}

export interface RestBigQueryOverwriteBatch {
  reservation: RestEntityOverwriteReservation;
  sourceRowsBefore: number;
  expectedRows: number;
}

const providerTableReference = z.object({
  projectId: z.string().min(1),
  datasetId: z.string().min(1),
  tableId: z.string().min(1),
});

const providerSnapshot = z.object({
  type: z.literal("SNAPSHOT"),
  tableReference: providerTableReference,
  location: z.string().trim().min(1),
  id: z.string().min(1),
  etag: z.string().min(1),
  creationTime: z.string().regex(/^\d+$/),
  numRows: z.string().regex(/^\d+$/),
  snapshotDefinition: z.object({
    baseTableReference: providerTableReference,
    snapshotTime: z.iso.datetime({ offset: true }),
  }),
});

interface SnapshotRequest {
  overwrite: RestEntityOverwrite;
  source: BigQueryTableIdentity;
  snapshot: BigQueryTableIdentity;
  asOfMs: number;
  sourceRowsBefore: number;
  expectedRows: number;
  job: BigQueryJobIdentity;
  configuration: RetainedQueryConfiguration;
}

interface RetainedSnapshot {
  _id: string;
  fingerprint: string;
  request: SnapshotRequest;
  captured?: BigQueryInputSnapshot;
}

const writeConcern = { w: "majority" as const };
const digest = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");

function snapshotRequests(connection: Connection) {
  if (!connection.db) throw new Error("MongoDB connection is not open");
  return connection.db.collection<RetainedSnapshot>(
    "rest_bigquery_overwrite_snapshots",
  );
}

function snapshotRequestId(
  { scope, overwrite }: RestEntityOverwriteReservation,
  sourceRowsBefore: number,
) {
  return digest([
    scope.workspaceId.toHexString(),
    scope.flowId.toHexString(),
    scope.sourceConnectionId.toHexString(),
    overwrite.runId,
    overwrite.entity,
    sourceRowsBefore,
  ]);
}

export function restBigQueryReplacementJobId({
  reservation,
  sourceRowsBefore,
}: RestBigQueryOverwriteBatch): string {
  return `mako_rest_replacement_${snapshotRequestId(reservation, sourceRowsBefore)}`;
}

/** A replacement must use the captured staging generation for its own source range. */
export async function hasCapturedRestBigQueryInput(
  connection: Connection,
  reservation: RestEntityOverwriteReservation,
  batch: {
    input: BigQueryStagedInput;
    sourceRowsBefore: number;
    expectedRows: number;
  },
  session?: ClientSession,
): Promise<boolean> {
  const retained = await snapshotRequests(connection).findOne(
    { _id: snapshotRequestId(reservation, batch.sourceRowsBefore) },
    session ? { session } : { readConcern: { level: "majority" } },
  );
  return Boolean(
    retained?.captured &&
    digest(retained.request) === retained.fingerprint &&
    stableStringify(retained.request.overwrite) ===
      stableStringify(reservation.overwrite) &&
    retained.request.sourceRowsBefore === batch.sourceRowsBefore &&
    retained.request.expectedRows === batch.expectedRows &&
    retained.captured.rows === batch.expectedRows &&
    stableStringify(retained.captured.input) === stableStringify(batch.input),
  );
}

/** Capture the provider identity and row count of a read-only input table. */
export async function readBigQueryInputSnapshot(
  target: BigQueryTarget,
  snapshot: BigQueryTableIdentity,
): Promise<BigQueryInputSnapshot | null> {
  if (snapshot.project !== target.projectId) return null;
  let metadata: unknown;
  try {
    [metadata] = await target.bq
      .dataset(snapshot.dataset)
      .table(snapshot.table)
      .getMetadata();
  } catch (error) {
    if ((error as { code?: number })?.code === 404) return null;
    throw error;
  }
  const parsed = providerSnapshot.safeParse(metadata);
  if (!parsed.success) return null;
  const { tableReference: ref, location, numRows } = parsed.data;
  const rows = Number(numRows);
  if (
    ref.projectId !== snapshot.project ||
    ref.datasetId !== snapshot.dataset ||
    ref.tableId !== snapshot.table ||
    location.toLowerCase() !== target.datasetLocation?.trim().toLowerCase() ||
    !Number.isSafeInteger(rows)
  ) {
    return null;
  }
  const { baseTableReference, snapshotTime } = parsed.data.snapshotDefinition;
  return {
    input: { snapshot, generation: digest(parsed.data) },
    rows,
    baseTable: {
      project: baseTableReference.projectId,
      dataset: baseTableReference.datasetId,
      table: baseTableReference.tableId,
    },
    asOf: snapshotTime,
  };
}

/** Keep the exact snapshot statement for this flush across provider retries. */
export async function captureRestBigQueryOverwriteSnapshot(
  connection: Connection,
  target: BigQueryTarget,
  { scope, overwrite }: RestEntityOverwriteReservation,
  batch: {
    sourceRowsBefore: number;
    source: BigQueryTableIdentity;
    asOf: Date;
    expectedRows: number;
  },
  options: Omit<RetainedQueryConfiguration, "query"> & {
    query: Omit<RetainedQueryConfiguration["query"], "query">;
  },
): Promise<BigQueryInputSnapshot | null> {
  const asOfMs = batch.asOf.getTime();
  const location = target.datasetLocation?.trim().toLowerCase();
  if (
    !Number.isSafeInteger(batch.sourceRowsBefore) ||
    batch.sourceRowsBefore < 0 ||
    !Number.isSafeInteger(asOfMs) ||
    !Number.isSafeInteger(batch.expectedRows) ||
    batch.expectedRows <= 0 ||
    !Number.isSafeInteger(batch.sourceRowsBefore + batch.expectedRows) ||
    !location ||
    String(target.destination._id) !== overwrite.destinationId ||
    String(target.destination.workspaceId) !==
      scope.workspaceId.toHexString() ||
    batch.source.project !== target.projectId ||
    batch.source.dataset !== target.dataset ||
    batch.source.dataset !== overwrite.schema ||
    !batch.source.table.trim() ||
    batch.source.table === overwrite.tableName
  ) {
    throw new Error("BigQuery snapshot requires an exact staged REST batch");
  }
  if (!(await hasPendingRestEntityOverwrite(connection, scope, overwrite))) {
    throw new Error("BigQuery snapshot requires a pending REST overwrite");
  }
  const collection = snapshotRequests(connection);
  const _id = snapshotRequestId({ scope, overwrite }, batch.sourceRowsBefore);
  const job = {
    project: target.projectId,
    location,
    id: `mako_rest_snapshot_${_id}`,
  };
  const snapshot = {
    project: target.projectId,
    dataset: target.dataset,
    table: `_${job.id}`,
  };
  const request = {
    overwrite,
    source: batch.source,
    snapshot,
    asOfMs,
    sourceRowsBefore: batch.sourceRowsBefore,
    expectedRows: batch.expectedRows,
    job,
    configuration: retainedQueryConfiguration.parse({
      ...options,
      query: {
        ...options.query,
        query: `CREATE SNAPSHOT TABLE ${fullTableName(target, snapshot.table)} CLONE ${fullTableName(target, batch.source.table)} FOR SYSTEM_TIME AS OF TIMESTAMP_MILLIS(${asOfMs})`,
      },
    }),
  };
  const fingerprint = digest(request);
  const retained = await collection.findOneAndUpdate(
    { _id },
    { $setOnInsert: { _id, fingerprint, request } },
    { upsert: true, returnDocument: "after", writeConcern },
  );
  if (
    !retained ||
    retained.fingerprint !== fingerprint ||
    digest(retained.request) !== fingerprint
  ) {
    throw new Error("The retained BigQuery snapshot batch changed");
  }
  if (retained.captured) return retained.captured;

  let metadata = await readRetainedBigQueryJob(target, job);
  if (!metadata) {
    try {
      await target.bq.createJob({
        jobId: job.id,
        location: job.location,
        configuration: retained.request.configuration,
      });
    } catch (error) {
      if ((error as { code?: number })?.code !== 409) throw error;
    }
    metadata = await readRetainedBigQueryJob(target, job);
  }
  const outcome = retainedQueryOutcome(
    job,
    retained.request.configuration,
    metadata,
    "CREATE_SNAPSHOT_TABLE",
  );
  if (outcome === "failed") {
    throw new Error("Retained BigQuery snapshot failed");
  }
  if (!outcome) return null;
  const captured = await readBigQueryInputSnapshot(target, snapshot);
  if (!captured) return null;
  if (
    captured.rows !== batch.expectedRows ||
    Date.parse(captured.asOf) !== asOfMs ||
    stableStringify(captured.baseTable) !== stableStringify(batch.source)
  ) {
    throw new Error(
      "BigQuery snapshot does not match the retained staging version",
    );
  }
  // A concurrent successful lookup must return the same immutable generation.
  const result = await collection.findOneAndUpdate(
    { _id, fingerprint },
    [
      {
        $set: { captured: { $ifNull: ["$captured", { $literal: captured }] } },
      },
    ],
    { returnDocument: "after", writeConcern },
  );
  if (result?.captured?.input.generation !== captured.input.generation) {
    throw new Error("BigQuery snapshot generation changed during capture");
  }
  return result.captured;
}
