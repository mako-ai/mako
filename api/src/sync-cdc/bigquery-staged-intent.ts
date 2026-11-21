import { createHash } from "node:crypto";
import mongoose, { Schema, type ClientSession } from "mongoose";
import {
  buildMergeStatement,
  fullTableName,
  type BuildMergeStatementParams,
} from "./adapters/bigquery-sql";
import {
  retainedQueryConfiguration,
  retainedQueryOutcome,
  type BigQueryJobIdentity,
  type BigQueryTableIdentity,
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
import type { LeaseJobRef } from "./table-write-lease";
import {
  CdcResyncConflictError,
  reserveRetainedWriteAgainstResync,
  type CdcResyncScope,
} from "./cdc-resync-fence";

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
type RetainedMerge = Omit<
  BuildMergeStatementParams,
  "fullLive" | "fullStaging"
>;

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

interface ReplayDelivery {
  _id: string;
  workspaceId: string;
  members: Array<{ key: string; fingerprint: string }>;
}

interface BigQueryCdcReplayPlan {
  expectedRecords: Array<{ entity: string; recordId: string }>;
  jobs: Array<{
    binding: StagedWriteBinding;
    merge: RetainedMerge;
    options: RetainedMergeOptions;
    cdc: BigQueryCdcBinding;
  }>;
}

type ReplayDeliveryStatus = "held" | "succeeded" | "failed";

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

function replayDeliveries() {
  const database = StagedWrite.db.db;
  if (!database) throw new Error("MongoDB connection is not open");
  return database.collection<ReplayDelivery>("cdc_bigquery_replay_deliveries");
}

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
  merge: RetainedMerge,
  options: RetainedMergeOptions,
): Promise<"held" | "terminal"> {
  return holdStagedWrite(buildRetainedMergeIntent(binding, merge, options));
}

/** Bind an authorized webhook upsert batch and its immutable warehouse request. */
export async function holdBigQueryStagedCdcMerge(
  binding: StagedWriteBinding,
  merge: RetainedMerge,
  options: RetainedMergeOptions,
  authorized: BigQueryCdcBinding,
): Promise<"held" | "terminal"> {
  if (authorized.events.some(event => event.originalReceipt)) {
    throw new Error("A retained replay requires the complete delivery plan");
  }
  return holdStagedWrite({
    ...buildRetainedMergeIntent(binding, merge, options),
    cdc: normalizeBigQueryCdcBinding(authorized),
  });
}

/** Reserve every job for a delivery in one majority-committed transaction. */
export async function holdBigQueryStagedCdcReplay(
  plan: BigQueryCdcReplayPlan,
): Promise<{ replayId: string; status: ReplayDeliveryStatus }> {
  const writes = plan.jobs.map(job =>
    prepareStagedWrite({
      ...buildRetainedMergeIntent(job.binding, job.merge, job.options),
      cdc: normalizeBigQueryCdcBinding(job.cdc),
    }),
  );
  const first = writes[0]?.intent;
  const receipt = first?.cdc.events[0]?.originalReceipt;
  if (!first || !receipt) {
    throw new Error("A retained replay requires an original inbox receipt");
  }

  const { workspaceId, originNamespace } = first.cdc.scope;
  const replayId = digest([
    workspaceId,
    originNamespace,
    receipt.eventIdSha256,
  ]);
  const receiptIdentity = stableStringify({ ...receipt, recordId: undefined });
  const scopeIdentity = (
    scope: BigQueryCdcScope,
    table: BigQueryTableIdentity,
  ) =>
    stableStringify([
      { ...scope, entity: undefined },
      table.project,
      table.dataset,
    ]);
  const targetIdentity = scopeIdentity(first.cdc.scope, first.destination);
  const records = new Set<string>();
  for (const { intent } of writes) {
    if (
      scopeIdentity(intent.cdc.scope, intent.destination) !== targetIdentity
    ) {
      throw new Error("A retained replay requires one target flow and dataset");
    }
    for (const { originalReceipt } of intent.cdc.events) {
      if (
        !originalReceipt ||
        stableStringify({ ...originalReceipt, recordId: undefined }) !==
          receiptIdentity
      ) {
        throw new Error(
          "Retained CDC replay does not match the original inbox receipt",
        );
      }
      const key = stableStringify([
        intent.cdc.scope.entity,
        originalReceipt.recordId,
      ]);
      if (records.has(key)) {
        throw new Error("A retained replay repeats a planned record");
      }
      records.add(key);
    }
  }
  const expected = new Set(
    plan.expectedRecords.map(({ entity, recordId }) =>
      stableStringify([entity, recordId]),
    ),
  );
  if (
    expected.size !== plan.expectedRecords.length ||
    expected.size !== records.size ||
    [...expected].some(key => !records.has(key))
  ) {
    throw new Error("Retained replay jobs must cover every expected record");
  }
  const members = writes
    .map(write => ({ key: write._id, fingerprint: write.fingerprint }))
    .sort((left, right) => left.key.localeCompare(right.key));
  if (new Set(members.map(member => member.key)).size !== members.length) {
    throw new Error("A retained replay requires distinct warehouse jobs");
  }

  await requireIndexes(true);
  const deliveries = replayDeliveries();
  return StagedWrite.db.transaction(async session => {
    const existing = await deliveries.findOne(
      { _id: replayId, workspaceId },
      { session },
    );
    if (existing) {
      if (stableStringify(existing.members) !== stableStringify(members)) {
        throw new Error(
          "This delivery already has a different retained replay plan",
        );
      }
      const status = await readReplayMemberStatus(existing, session);
      if (!status) {
        throw new Error("The retained replay jobs no longer match the plan");
      }
      return { replayId, status };
    }
    for (const write of writes) {
      if (await StagedWrite.exists({ _id: write._id }).session(session)) {
        throw new Error(
          "A retained replay job was previously reserved outside this plan",
        );
      }
      await reserveStagedWrite(write, session);
    }
    await deliveries.insertOne(
      { _id: replayId, workspaceId, members },
      { session },
    );
    return { replayId, status: "held" as const };
  }, cdcTransaction);
}

export async function readBigQueryStagedCdcReplay(
  workspaceId: string,
  replayId: string,
): Promise<ReplayDeliveryStatus | null> {
  const delivery = await replayDeliveries().findOne(
    { _id: replayId, workspaceId },
    { readConcern: { level: "majority" } },
  );
  return delivery ? readReplayMemberStatus(delivery) : null;
}

async function readReplayMemberStatus(
  delivery: ReplayDelivery,
  session?: ClientSession,
): Promise<ReplayDeliveryStatus | null> {
  if (delivery.members.length === 0) return null;
  const query = StagedWrite.find({
    _id: { $in: delivery.members.map(member => member.key) },
  });
  const writes = await (
    session ? query.session(session) : query.readConcern("majority")
  ).lean();
  const byId = new Map(writes.map(write => [write._id, write]));
  let pending = false;
  let failed = false;
  for (const { key, fingerprint } of delivery.members) {
    const write = byId.get(key);
    if (
      !write?.intent.cdc ||
      write.fingerprint !== fingerprint ||
      stagedWriteFingerprint(write.intent) !== fingerprint
    ) {
      return null;
    }
    if (!write.terminal) {
      pending = true;
      continue;
    }
    if (
      !("fingerprint" in write.terminal) ||
      write.terminal.fingerprint !== fingerprint ||
      write.terminal.state !== "DONE" ||
      !["succeeded", "failed"].includes(write.terminal.outcome)
    ) {
      return null;
    }
    failed ||= write.terminal.outcome === "failed";
  }
  if (pending) return "held";
  return failed ? "failed" : "succeeded";
}

function buildRetainedMergeIntent(
  { job, input, destination }: StagedWriteBinding,
  merge: RetainedMerge,
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
  const write = prepareStagedWrite(requested);
  // Every retained snapshot name belongs to one job for its entire lifetime.
  await requireIndexes(write.intent.cdc !== undefined);
  return StagedWrite.db.transaction(async session => {
    const existing = await StagedWrite.findById(write._id)
      .session(session)
      .lean();
    if (existing) return stagedWriteState(existing, write.fingerprint);
    await reserveStagedWrite(write, session);
    return "held";
  }, cdcTransaction);
}

function prepareStagedWrite<T extends BigQueryStagedIntent>(requested: T) {
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
  const snapshotKey = digest(tableIdentity(intent.input.snapshot));
  return { _id, fingerprint, snapshotKey, intent };
}

async function reserveStagedWrite(
  write: ReturnType<typeof prepareStagedWrite>,
  session: ClientSession,
): Promise<void> {
  const { intent, fingerprint } = write;
  const cdc = intent.cdc;
  await reserveRetainedWriteAgainstResync(
    [intent.destination, intent.input.snapshot],
    cdc?.scope,
    session,
  );
  if (cdc) {
    await requireCurrentBigQueryCdcFlow(cdc.scope, intent.destination, session);
    await claimBigQueryCdcEvents(cdc, fingerprint, session);
  }
  await StagedWrite.create(
    [
      {
        ...write,
        eventClaimKeys: cdc?.events.map(event =>
          eventClaimKey(cdc.scope, event.deliveryKey),
        ),
      },
    ],
    { session },
  );
}

/** Check the durable intent even if the table-write lease has not been acquired. */
export async function assertRetainedWritesDrainedForResync(
  scope: CdcResyncScope,
  session: ClientSession,
): Promise<void> {
  const flow = {
    "intent.cdc.scope.workspaceId": scope.workspaceId,
    "intent.cdc.scope.flowId": scope.flowId,
    ...(scope.entities?.length
      ? { "intent.cdc.scope.entity": { $in: scope.entities } }
      : {}),
  };
  const tables = scope.tables.map(({ project, dataset, table }) => ({
    "intent.destination.project": project,
    "intent.destination.dataset": dataset,
    "intent.destination.table": table,
  }));
  const snapshots = scope.tables.map(({ project, dataset, table }) => ({
    "intent.input.snapshot.project": project,
    "intent.input.snapshot.dataset": dataset,
    "intent.input.snapshot.table": table,
    cleanedAt: { $exists: false },
  }));
  const unresolved = await StagedWrite.exists({
    $or: [
      {
        $and: [
          { $or: [flow, ...tables] },
          {
            $or: [
              { "terminal.state": { $ne: "DONE" } },
              {
                "intent.cdc": { $exists: true },
                "terminal.outcome": { $ne: "succeeded" },
              },
            ],
          },
        ],
      },
      ...snapshots,
    ],
  }).session(session);
  if (unresolved) {
    throw new CdcResyncConflictError(
      "CDC resync is blocked by an unsettled write or retained snapshot",
    );
  }
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

type CdcDispatchTarget = BigQueryTableIdentity & {
  workspaceId: string;
  destinationConnectionId: string;
};

export async function readBigQueryStagedCdcWrite(
  job: BigQueryJobIdentity,
  target: CdcDispatchTarget,
  expectedFingerprint?: string,
): Promise<StagedWriteRecord | null> {
  const record = await readBigQueryStagedInput(job);
  const scope = record?.intent.cdc?.scope;
  if (
    !record ||
    !scope ||
    record.cleanedAt ||
    (expectedFingerprint !== undefined &&
      record.fingerprint !== expectedFingerprint) ||
    record.fingerprint !== stagedWriteFingerprint(record.intent) ||
    scope.workspaceId !== target.workspaceId ||
    scope.destinationConnectionId !== target.destinationConnectionId ||
    record.intent.destination.project !== target.project ||
    record.intent.destination.dataset !== target.dataset ||
    record.intent.destination.table !== target.table
  ) {
    return null;
  }
  return record;
}

/** A reserved table lease needs proof from the exact job and destination. */
export async function settleReservedBigQueryCdcJob(
  target: CdcDispatchTarget,
  reservation: LeaseJobRef,
  readJobMetadata: () => Promise<unknown>,
): Promise<boolean> {
  const { jobId, location, intentFingerprint } = reservation;
  if (
    !reservation.reservedBeforeDispatch ||
    !jobId ||
    !location ||
    !intentFingerprint
  ) {
    return false;
  }
  const job = { project: target.project, location, id: jobId };
  const record = await readBigQueryStagedCdcWrite(
    job,
    target,
    intentFingerprint,
  );
  if (!record) return false;
  if (record.terminal) {
    return (
      "fingerprint" in record.terminal &&
      record.terminal.fingerprint === intentFingerprint &&
      record.terminal.state === "DONE" &&
      (record.terminal.outcome === "succeeded" ||
        record.terminal.outcome === "failed")
    );
  }
  return recordObservedBigQueryQueryResult(
    job,
    await readJobMetadata(),
    intentFingerprint,
  );
}

/** Use the majority-confirmed request for the first submission and any recovery. */
export async function readPendingBigQueryQueryRequest(
  job: BigQueryJobIdentity,
  expectedFingerprint?: string,
) {
  const record = await readBigQueryStagedInput(job);
  if (record?.terminal || record?.cleanedAt) return null;
  const configuration = record?.intent.configuration;
  if (!record || !configuration) return null;
  if (
    (expectedFingerprint !== undefined &&
      record.fingerprint !== expectedFingerprint) ||
    record.fingerprint !== stagedWriteFingerprint(record.intent)
  ) {
    return null;
  }
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
  expectedFingerprint?: string,
): Promise<boolean> {
  const record = await readBigQueryStagedInput(job);
  const configuration = record?.intent.configuration;
  if (!record || !configuration) return false;
  if (
    (expectedFingerprint !== undefined &&
      record.fingerprint !== expectedFingerprint) ||
    record.fingerprint !== stagedWriteFingerprint(record.intent)
  ) {
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
