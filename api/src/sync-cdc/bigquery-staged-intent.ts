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
import {
  applyClaimedBigQueryCdcEvents,
  bigQueryCdcScope,
  CdcBigQueryBindingChangedError,
  claimBigQueryCdcEvents,
  haveClaimedBigQueryCdcEvents,
  normalizeBigQueryCdcBinding,
  requireCurrentBigQueryCdcFlow,
  type BigQueryCdcBinding,
  type BigQueryCdcScope,
} from "./bigquery-staged-cdc";
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
  cdc?: never;
}

interface RetainedQueryIntent extends StagedWriteBinding {
  configuration: RetainedQueryConfiguration;
  configurationFingerprint?: never;
  cdc?: BigQueryCdcBinding;
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
  eventClaimKeys?: string[];
  intent: BigQueryStagedIntent;
  terminal?: BigQueryTerminalReceipt | VerifiedQueryReceipt;
  cleanedAt?: Date;
}

const eventClaimIndexFilter = { eventClaimKeys: { $exists: true } };

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
        eventClaimKeys: { type: [String], default: undefined },
        intent: { type: Schema.Types.Mixed, required: true },
        terminal: { type: Schema.Types.Mixed },
        cleanedAt: { type: Date },
      },
      {
        collection: "cdc_bigquery_staged_writes",
        versionKey: false,
        autoIndex: false,
      },
    ).index(
      { eventClaimKeys: 1 },
      { unique: true, partialFilterExpression: eventClaimIndexFilter },
    ),
  );

const writeConcern = { w: "majority" as const };
const cdcTransaction = {
  readConcern: { level: "snapshot" as const },
  writeConcern,
};
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

async function requireIndexes(cdc: boolean): Promise<void> {
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
  if (
    cdc &&
    !indexes.some(
      index =>
        index.unique &&
        !index.sparse &&
        index.key.eventClaimKeys === 1 &&
        Object.keys(index.key).length === 1 &&
        stableStringify(index.partialFilterExpression) ===
          stableStringify(eventClaimIndexFilter),
    )
  ) {
    throw new Error("The staged-write CDC event claim index is missing");
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
    ...(intent.cdc ? [["cdc", intent.cdc]] : []),
  ]);
}

export async function holdBigQueryStagedInput(
  requested: DigestOnlyIntent,
): Promise<"held" | "terminal"> {
  if (requested.configuration !== undefined || requested.cdc !== undefined) {
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
  return holdStagedWrite(buildRetainedMergeIntent(binding, merge, options));
}

/** Bind an authorized webhook upsert batch and its immutable warehouse request. */
export async function holdBigQueryStagedCdcMerge(
  binding: StagedWriteBinding,
  merge: Omit<BuildMergeStatementParams, "fullLive" | "fullStaging">,
  options: RetainedMergeOptions,
  authorized: BigQueryCdcBinding,
): Promise<"held" | "terminal"> {
  return holdStagedWrite({
    ...buildRetainedMergeIntent(binding, merge, options),
    cdc: normalizeBigQueryCdcBinding(authorized),
  });
}

function buildRetainedMergeIntent(
  { job, input, destination }: StagedWriteBinding,
  merge: Omit<BuildMergeStatementParams, "fullLive" | "fullStaging">,
  options: RetainedMergeOptions,
): RetainedQueryIntent {
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
        fullLive: qualify(destination),
        fullStaging: qualify(input.snapshot),
      }),
    },
  });
  return { job, input, destination, configuration };
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
  await requireIndexes(intent.cdc !== undefined);
  const snapshotKey = digest(tableIdentity(intent.input.snapshot));
  const insert = { _id, fingerprint, snapshotKey, intent };
  const cdc = intent.cdc;
  if (cdc) {
    return StagedWrite.db.transaction(async session => {
      const existing = await StagedWrite.findById(_id).session(session).lean();
      if (existing) return stagedWriteState(existing, fingerprint);
      await requireCurrentBigQueryCdcFlow(
        cdc.scope,
        intent.destination,
        session,
      );
      await claimBigQueryCdcEvents(cdc, fingerprint, session);
      await StagedWrite.create(
        [
          {
            ...insert,
            eventClaimKeys: cdc.events.map(event =>
              eventClaimKey(cdc.scope, event.deliveryKey),
            ),
          },
        ],
        { session },
      );
      return "held" as const;
    }, cdcTransaction);
  }
  const record = await StagedWrite.findOneAndUpdate(
    { _id },
    { $setOnInsert: insert },
    { upsert: true, returnDocument: "after", writeConcern },
  ).lean();
  return stagedWriteState(record, fingerprint);
}

function stagedWriteState(
  record: StagedWriteRecord | null,
  fingerprint: string,
): "held" | "terminal" {
  if (record?.fingerprint !== fingerprint) {
    throw new Error(
      "The BigQuery job ID already holds a different staged write",
    );
  }
  return record.terminal ? "terminal" : "held";
}

function eventClaimKey(scope: BigQueryCdcScope, deliveryKey: string): string {
  // The claim survives changes to a flow, destination, or CDC row ID.
  return digest([
    scope.workspaceId,
    scope.originNamespace,
    scope.entity,
    deliveryKey,
  ]);
}

/** Find previously reserved writes for deliveries present in a retry. */
export async function findBigQueryStagedCdcWrites(
  authorizedScope: BigQueryCdcScope,
  deliveryKeys: string[],
): Promise<StagedWriteRecord[]> {
  const scope = bigQueryCdcScope.parse(authorizedScope);
  const records = await StagedWrite.find({
    eventClaimKeys: {
      $exists: true,
      $in: deliveryKeys.map(key => eventClaimKey(scope, key.trim())),
    },
  })
    .readConcern("majority")
    .lean();
  const scopeKey = stableStringify(scope);
  return records.filter(record => {
    const cdc = record.intent.cdc;
    return (
      cdc &&
      stableStringify(cdc.scope) === scopeKey &&
      record.fingerprint === stagedWriteFingerprint(record.intent)
    );
  });
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
  if (record.intent.cdc) {
    const cdc = record.intent.cdc;
    try {
      await requireCurrentBigQueryCdcFlow(cdc.scope, record.intent.destination);
    } catch (error) {
      if (error instanceof CdcBigQueryBindingChangedError) return null;
      throw error;
    }
    if (!(await haveClaimedBigQueryCdcEvents(cdc, record.fingerprint))) {
      return null;
    }
  }
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
  const receipt: VerifiedQueryReceipt = {
    state: "DONE",
    outcome,
    fingerprint: record.fingerprint,
  };
  const cdc = record.intent.cdc;
  if (cdc) return settleBigQueryCdcWrite(record, cdc, receipt);
  return writeTerminalReceipt(job, record.fingerprint, receipt);
}

async function settleBigQueryCdcWrite(
  record: StagedWriteRecord,
  cdc: BigQueryCdcBinding,
  receipt: VerifiedQueryReceipt,
): Promise<boolean> {
  const identity = { _id: record._id, fingerprint: record.fingerprint };
  try {
    return await StagedWrite.db.transaction(async session => {
      const current = await StagedWrite.findOne(identity)
        .session(session)
        .lean();
      if (
        !current ||
        current.cleanedAt ||
        current.fingerprint !== stagedWriteFingerprint(current.intent)
      ) {
        return false;
      }
      if (current.terminal) {
        return (
          "fingerprint" in current.terminal &&
          current.terminal.fingerprint === receipt.fingerprint &&
          current.terminal.state === receipt.state &&
          current.terminal.outcome === receipt.outcome
        );
      }
      await requireCurrentBigQueryCdcFlow(
        cdc.scope,
        record.intent.destination,
        session,
      );
      if (receipt.outcome === "succeeded") {
        await applyClaimedBigQueryCdcEvents(cdc, record.fingerprint, session);
      }
      const result = await StagedWrite.updateOne(
        { ...identity, terminal: { $exists: false } },
        { $set: { terminal: receipt } },
        { session },
      );
      if (result.matchedCount !== 1) {
        throw new CdcBigQueryBindingChangedError(
          "The retained CDC receipt changed during settlement",
        );
      }
      return true;
    }, cdcTransaction);
  } catch (error) {
    if (error instanceof CdcBigQueryBindingChangedError) return false;
    throw error;
  }
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
