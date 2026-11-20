import { createHash } from "node:crypto";
import mongoose, { Schema } from "mongoose";
import { stableStringify } from "./normalization";

interface BigQueryJobIdentity {
  project: string;
  location: string;
  id: string;
}

interface BigQueryTableIdentity {
  project: string;
  dataset: string;
  table: string;
}

export interface BigQueryStagedInput {
  snapshot: BigQueryTableIdentity;
  /** Provider identity of this read-only snapshot. A table name alone is reusable. */
  generation: string;
}

export interface BigQueryStagedIntent {
  job: BigQueryJobIdentity;
  input: BigQueryStagedInput;
  destination: BigQueryTableIdentity;
  /** Digest of the immutable dispatch configuration, including the exact SQL. */
  configurationFingerprint: string;
}

export interface BigQueryTerminalReceipt extends BigQueryStagedIntent {
  state: "DONE";
  outcome: "succeeded" | "failed";
}

interface StagedWriteRecord {
  _id: string;
  fingerprint: string;
  snapshotKey: string;
  intent: BigQueryStagedIntent;
  terminal?: BigQueryTerminalReceipt;
  cleanedAt?: Date;
}

// The short-lived table lease can be deleted on release. Cleanup needs its own durable receipt.
const StagedWrite =
  (mongoose.models
    .CdcBigQueryStagedWrite as mongoose.Model<StagedWriteRecord>) ??
  mongoose.model<StagedWriteRecord>(
    "CdcBigQueryStagedWrite",
    new Schema<StagedWriteRecord>(
      {
        _id: { type: String, required: true },
        fingerprint: { type: String, required: true },
        snapshotKey: { type: String, required: true, unique: true },
        intent: { type: Schema.Types.Mixed, required: true },
        terminal: { type: Schema.Types.Mixed },
        cleanedAt: { type: Date },
      },
      {
        collection: "cdc_bigquery_staged_writes",
        versionKey: false,
        autoIndex: false,
      },
    ),
  );

const writeConcern = { w: "majority" as const };
const digest = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");

function tableIdentity(table: BigQueryTableIdentity) {
  return [table.project, table.dataset, table.table];
}

function jobKey(job: BigQueryJobIdentity): string {
  return digest([job.project, job.location.trim().toLowerCase(), job.id]);
}

/** Run before activation. The hold path also checks that the index exists. */
export async function initializeBigQueryStagedInputStore(): Promise<void> {
  await StagedWrite.createIndexes();
}

async function requireSnapshotIndex(): Promise<void> {
  const indexes = await StagedWrite.listIndexes();
  if (
    !indexes.some(
      index =>
        index.unique &&
        !index.sparse &&
        !index.partialFilterExpression &&
        index.key.snapshotKey === 1 &&
        Object.keys(index.key).length === 1,
    )
  ) {
    throw new Error("The staged-write snapshot ownership index is missing");
  }
}

export function stagedWriteFingerprint(intent: BigQueryStagedIntent): string {
  return digest([
    jobKey(intent.job),
    tableIdentity(intent.input.snapshot),
    intent.input.generation,
    tableIdentity(intent.destination),
    intent.configurationFingerprint,
  ]);
}

/** Bind a sealed input to a caller-assigned job before the warehouse dispatches it. */
export async function holdBigQueryStagedInput(
  requested: BigQueryStagedIntent,
): Promise<"held" | "terminal"> {
  const intent = structuredClone(requested);
  intent.job.location = intent.job.location.trim().toLowerCase();
  const _id = jobKey(intent.job);
  const fingerprint = stagedWriteFingerprint(intent);
  const fields = [
    intent.job.project,
    intent.job.location,
    intent.job.id,
    ...tableIdentity(intent.input.snapshot),
    intent.input.generation,
    ...tableIdentity(intent.destination),
    intent.configurationFingerprint,
  ];
  if (fields.some(field => !field.trim())) {
    throw new Error(
      "A staged write requires a complete job, input and destination identity",
    );
  }
  // Every retained snapshot name belongs to one job for its entire lifetime.
  await requireSnapshotIndex();
  const snapshotKey = digest(tableIdentity(intent.input.snapshot));
  const record = await StagedWrite.findOneAndUpdate(
    { _id },
    { $setOnInsert: { fingerprint, snapshotKey, intent } },
    { upsert: true, returnDocument: "after", writeConcern },
  ).lean();
  if (record?.fingerprint !== fingerprint) {
    throw new Error(
      "The BigQuery job ID already holds a different staged write",
    );
  }
  return record.terminal ? "terminal" : "held";
}

export async function readBigQueryStagedInput(
  job: BigQueryJobIdentity,
): Promise<StagedWriteRecord | null> {
  return StagedWrite.findById(jobKey(job)).readConcern("majority").lean();
}

/** Only a verified jobs.get DONE receipt can make a retained input eligible for cleanup. */
export async function recordBigQueryStagedReceipt(
  reported: BigQueryTerminalReceipt,
): Promise<boolean> {
  const receipt = structuredClone(reported);
  receipt.job.location = receipt.job.location.trim().toLowerCase();
  if (
    receipt.state !== "DONE" ||
    !["succeeded", "failed"].includes(receipt.outcome)
  ) {
    return false;
  }
  const result = await StagedWrite.updateOne(
    {
      _id: jobKey(receipt.job),
      fingerprint: stagedWriteFingerprint(receipt),
      $or: [
        { terminal: { $exists: false } },
        { "terminal.outcome": receipt.outcome },
      ],
    },
    { $set: { terminal: receipt } },
    { writeConcern },
  );
  return result.matchedCount === 1;
}

/** The deleter must be idempotent and refuse a different snapshot generation. */
export async function cleanupBigQueryStagedInput(
  job: BigQueryJobIdentity,
  deleteSnapshotIfMatching: (input: BigQueryStagedInput) => Promise<void>,
): Promise<boolean> {
  const record = await readBigQueryStagedInput(job);
  if (
    record?.terminal?.state !== "DONE" ||
    record.fingerprint !== stagedWriteFingerprint(record.intent) ||
    record.fingerprint !== stagedWriteFingerprint(record.terminal)
  ) {
    return false;
  }
  if (record.cleanedAt) return true;
  // The receipt is already durable. A crash after deletion retries the same generation.
  await deleteSnapshotIfMatching(record.intent.input);
  await StagedWrite.updateOne(
    {
      _id: record._id,
      fingerprint: record.fingerprint,
      cleanedAt: { $exists: false },
    },
    { $set: { cleanedAt: new Date() } },
    { writeConcern },
  );
  return true;
}
