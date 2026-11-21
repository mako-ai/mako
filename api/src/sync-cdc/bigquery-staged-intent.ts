import { createHash } from "node:crypto";
import mongoose, { Schema } from "mongoose";
import {
  buildMergeStatement,
  fullTableName,
  type BuildMergeStatementParams,
} from "./adapters/bigquery-sql";
import {
  retainedQueryConfiguration,
  retainedQueryOutcome,
  type BigQueryJobIdentity,
  type RetainedQueryConfiguration,
} from "./bigquery-retained-query";
import { stableStringify } from "./normalization";

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

interface StagedWriteBinding {
  job: BigQueryJobIdentity;
  input: BigQueryStagedInput;
  destination: BigQueryTableIdentity;
}

interface DigestOnlyIntent extends StagedWriteBinding {
  configurationFingerprint: string;
  configuration?: never;
}

interface RetainedQueryIntent extends StagedWriteBinding {
  configuration: RetainedQueryConfiguration;
  configurationFingerprint?: never;
}

type RetainedMergeOptions = Omit<RetainedQueryConfiguration, "query"> & {
  query: Omit<RetainedQueryConfiguration["query"], "query">;
};

export type BigQueryStagedIntent = DigestOnlyIntent | RetainedQueryIntent;

interface TerminalOutcome {
  state: "DONE";
  outcome: "succeeded" | "failed";
}

export type BigQueryTerminalReceipt = DigestOnlyIntent & TerminalOutcome;

interface VerifiedQueryReceipt extends TerminalOutcome {
  fingerprint: string;
}

interface StagedWriteRecord {
  _id: string;
  fingerprint: string;
  snapshotKey: string;
  intent: BigQueryStagedIntent;
  terminal?: BigQueryTerminalReceipt | VerifiedQueryReceipt;
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
    intent.configuration === undefined
      ? intent.configurationFingerprint
      : ["jobs.insert", intent.configuration],
  ]);
}

export async function holdBigQueryStagedInput(
  requested: DigestOnlyIntent,
): Promise<"held" | "terminal"> {
  if (requested.configuration !== undefined) {
    throw new Error("A retained query must be built from its table bindings");
  }
  return holdStagedWrite(requested);
}

/** Build the MERGE from the sealed snapshot and target bound to the job. */
export function holdBigQueryStagedMerge(
  binding: StagedWriteBinding,
  merge: Omit<BuildMergeStatementParams, "fullLive" | "fullStaging">,
  options: RetainedMergeOptions,
): Promise<"held" | "terminal"> {
  const qualify = (table: BigQueryTableIdentity) =>
    fullTableName(
      { projectId: table.project, dataset: table.dataset },
      table.table,
    );
  const configuration = retainedQueryConfiguration.parse({
    ...options,
    query: {
      ...options.query,
      query: buildMergeStatement({
        ...merge,
        fullLive: qualify(binding.destination),
        fullStaging: qualify(binding.input.snapshot),
      }),
    },
  });
  return holdStagedWrite({ ...binding, configuration });
}

/** Bind a sealed input to a caller-assigned job before the warehouse dispatches it. */
async function holdStagedWrite(
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
    intent.configuration?.query.query ?? intent.configurationFingerprint,
  ];
  if (fields.some(field => !field?.trim())) {
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

/** Use the majority-confirmed request for the first submission and any recovery. */
export async function readPendingBigQueryQueryRequest(
  job: BigQueryJobIdentity,
) {
  const record = await readBigQueryStagedInput(job);
  if (record?.terminal || record?.cleanedAt) return null;
  const configuration = record?.intent.configuration;
  if (!record || !configuration) return null;
  if (record.fingerprint !== stagedWriteFingerprint(record.intent)) return null;
  const { project, location, id } = record.intent.job;
  return {
    jobReference: { projectId: project, location, jobId: id },
    configuration,
  };
}

/** A missing, unfinished or ambiguous lookup leaves the reserved job pending. */
export async function recordObservedBigQueryQueryResult(
  job: BigQueryJobIdentity,
  providerJob: unknown,
): Promise<boolean> {
  const record = await readBigQueryStagedInput(job);
  const configuration = record?.intent.configuration;
  if (!record || !configuration) return false;
  if (record.fingerprint !== stagedWriteFingerprint(record.intent)) {
    return false;
  }
  const outcome = retainedQueryOutcome(
    record.intent.job,
    configuration,
    providerJob,
  );
  if (!outcome) return false;
  return writeTerminalReceipt(job, record.fingerprint, {
    state: "DONE",
    outcome,
    fingerprint: record.fingerprint,
  });
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
  // Retained queries settle through the BigQuery job metadata matcher.
  if (receipt.configuration !== undefined) return false;
  return writeTerminalReceipt(
    receipt.job,
    stagedWriteFingerprint(receipt),
    receipt,
  );
}

async function writeTerminalReceipt(
  job: BigQueryJobIdentity,
  fingerprint: string,
  receipt: BigQueryTerminalReceipt | VerifiedQueryReceipt,
): Promise<boolean> {
  const result = await StagedWrite.updateOne(
    {
      _id: jobKey(job),
      fingerprint,
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
    "fingerprint" in record.terminal ||
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
