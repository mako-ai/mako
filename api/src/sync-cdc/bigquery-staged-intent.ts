import { createHash } from "node:crypto";
import mongoose, { Schema, Types, type ClientSession } from "mongoose";
import { getSchemaCacheKey } from "./adapters/bigquery-schema";
import {
  buildMergeStatement,
  escId,
  fullTableName,
  type BuildMergeStatementParams,
} from "./adapters/bigquery-sql";
import type { BigQueryTarget } from "./adapters/bigquery-target";
import {
  assertRetainedBigQueryInputSeal,
  assertRetainedInputTablesAvailableForResync,
} from "./adapters/bigquery-retained-input";
import { assertRestBigQueryTruncatesDrainedForResync } from "./bigquery-rest-overwrite-intent";
import {
  hasCapturedRestBigQueryInput,
  readBigQueryInputSnapshot,
} from "./bigquery-rest-overwrite-snapshot";
import {
  readRetainedBigQueryJob,
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
  transferClaimedBigQueryCdcEvents,
  type BigQueryCdcBinding,
  type BigQueryCdcScope,
} from "./bigquery-staged-cdc";
import { stableStringify } from "./normalization";
import {
  CdcResyncConflictError,
  reserveRetainedWriteAgainstResync,
  type CdcResyncScope,
} from "./cdc-resync-fence";
import {
  hasPendingRestEntityOverwrite,
  registerRestEntityOverwriteWrite,
  type RestEntityOverwrite,
  type RestEntityOverwriteReservation,
} from "./rest-entity-admission";
import { CdcTableWriteLease, type LeaseJobRef } from "./table-write-lease";

export interface BigQueryStagedInput {
  snapshot: BigQueryTableIdentity;
  /** Provider identity of this read-only snapshot. A table name alone is reusable. */
  generation: string;
  seal?: string;
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
  restOverwrite?: never;
}

interface StagedRestOverwrite {
  workspaceId: string;
  flowId: string;
  sourceConnectionId: string;
  overwrite: RestEntityOverwrite;
  sourceRowsBefore: number;
  expectedRows: number;
}

interface RetainedQueryIntent extends StagedWriteBinding {
  configuration: RetainedQueryConfiguration;
  configurationFingerprint?: never;
  cdc?: BigQueryCdcBinding;
  restOverwrite?: StagedRestOverwrite;
}

type RetainedQueryOptions = Omit<RetainedQueryConfiguration, "query"> & {
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
  affectedRows?: number;
}

interface StagedWriteRecord {
  _id: string;
  fingerprint: string;
  snapshotKey: string;
  eventClaimKeys?: string[];
  intent: BigQueryStagedIntent;
  terminal?: BigQueryTerminalReceipt | VerifiedQueryReceipt;
  cleanedAt?: Date;
  /** The initial write keeps the unique snapshot and event reservations. */
  claimOwner?: string;
  latestAttempt?: string;
  supersededBy?: string;
}

interface ReplayJobRef {
  key: string;
  fingerprint: string;
}

interface ReplayDelivery {
  _id: string;
  workspaceId: string;
  members: Array<ReplayJobRef & { activeAttempt?: ReplayJobRef }>;
}

interface BigQueryCdcReplayPlan {
  expectedRecords: Array<{ entity: string; recordId: string }>;
  jobs: Array<{
    binding: StagedWriteBinding;
    merge: RetainedMerge;
    options: RetainedQueryOptions;
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
        claimOwner: String,
        latestAttempt: String,
        supersededBy: String,
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
const retainedWriteTransaction = {
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
    ...(intent.input.seal === undefined ? [] : [["seal", intent.input.seal]]),
    tableIdentity(intent.destination),
    intent.configuration === undefined
      ? intent.configurationFingerprint
      : ["jobs.insert", intent.configuration],
    ...(intent.cdc ? [["cdc", intent.cdc]] : []),
    ...(intent.restOverwrite ? [["rest-overwrite", intent.restOverwrite]] : []),
  ]);
}

export async function holdBigQueryStagedInput(
  requested: DigestOnlyIntent,
): Promise<"held" | "terminal"> {
  if (
    requested.configuration !== undefined ||
    requested.cdc !== undefined ||
    requested.restOverwrite !== undefined
  ) {
    throw new Error("A retained query must be built from its table bindings");
  }
  return holdStagedWrite(requested);
}

/** Build the MERGE from the sealed snapshot and target bound to the job. */
export function holdBigQueryStagedMerge(
  binding: StagedWriteBinding,
  merge: RetainedMerge,
  options: RetainedQueryOptions,
): Promise<"held" | "terminal"> {
  return holdStagedWrite(buildRetainedMergeIntent(binding, merge, options));
}

/** Pin one replacement batch to its sealed input and pending REST overwrite. */
export async function holdBigQueryRestOverwriteInsert(
  binding: StagedWriteBinding,
  columns: string[],
  options: RetainedQueryOptions,
  {
    scope,
    overwrite,
    sourceRowsBefore,
    expectedRows,
  }: RestEntityOverwriteReservation & {
    sourceRowsBefore: number;
    expectedRows: number;
  },
): Promise<"held" | "terminal"> {
  if (
    binding.destination.dataset !== overwrite.schema ||
    binding.destination.table !== overwrite.tableName
  ) {
    throw new Error(
      "BigQuery replacement must match the reserved REST destination",
    );
  }
  if (
    !columns.length ||
    columns.some(column => !column.trim()) ||
    new Set(columns.map(column => column.toLowerCase())).size !== columns.length
  ) {
    throw new Error("BigQuery replacement requires distinct columns");
  }
  if (!Number.isSafeInteger(expectedRows) || expectedRows <= 0) {
    throw new Error(
      "BigQuery replacement requires a positive sealed row count",
    );
  }
  if (
    !Number.isSafeInteger(sourceRowsBefore) ||
    sourceRowsBefore < 0 ||
    !Number.isSafeInteger(sourceRowsBefore + expectedRows)
  ) {
    throw new Error("BigQuery replacement requires a valid source row range");
  }
  const list = columns.map(escId).join(", ");
  const configuration = retainedQueryConfiguration.parse({
    ...options,
    query: {
      ...options.query,
      query: `INSERT INTO ${qualify(binding.destination)} (${list}) SELECT ${list} FROM ${qualify(binding.input.snapshot)}`,
    },
  });
  return holdStagedWrite({
    ...binding,
    configuration,
    restOverwrite: {
      workspaceId: scope.workspaceId.toHexString(),
      flowId: scope.flowId.toHexString(),
      sourceConnectionId: scope.sourceConnectionId.toHexString(),
      overwrite,
      sourceRowsBefore,
      expectedRows,
    },
  });
}

function restOverwriteReservation({
  workspaceId,
  flowId,
  sourceConnectionId,
  overwrite,
}: StagedRestOverwrite): RestEntityOverwriteReservation {
  return {
    scope: {
      workspaceId: new Types.ObjectId(workspaceId),
      flowId: new Types.ObjectId(flowId),
      sourceConnectionId: new Types.ObjectId(sourceConnectionId),
    },
    overwrite,
  };
}

function hasRestOverwriteCapture(
  input: BigQueryStagedInput,
  binding: StagedRestOverwrite,
): Promise<boolean> {
  return hasCapturedRestBigQueryInput(
    StagedWrite.db,
    restOverwriteReservation(binding),
    {
      input,
      sourceRowsBefore: binding.sourceRowsBefore,
      expectedRows: binding.expectedRows,
    },
  );
}

/** Bind an authorized webhook upsert batch and its immutable warehouse request. */
export async function holdBigQueryStagedCdcMerge(
  binding: StagedWriteBinding,
  merge: RetainedMerge,
  options: RetainedQueryOptions,
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

  for (const { intent } of writes) {
    const { input, job, cdc } = intent;
    if (input.seal !== undefined) {
      await assertRetainedBigQueryInputSeal(
        { ...input, seal: input.seal },
        job,
        cdc,
      );
    }
  }

  await requireIndexes(true);
  const deliveries = replayDeliveries();
  return StagedWrite.db.transaction(async session => {
    const existing = await deliveries.findOne(
      { _id: replayId, workspaceId },
      { session },
    );
    if (existing) {
      const initial = existing.members.map(({ key, fingerprint }) => ({
        key,
        fingerprint,
      }));
      if (stableStringify(initial) !== stableStringify(members)) {
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
  }, retainedWriteTransaction);
}

/** Reserve a new job ID only after an exact replay MERGE has a verified failed receipt. */
export async function retryFailedBigQueryReplayMember(
  workspaceId: string,
  replayId: string,
  failedJob: BigQueryJobIdentity,
): Promise<BigQueryJobIdentity> {
  await requireIndexes(true);
  const deliveries = replayDeliveries();
  return StagedWrite.db.transaction(async session => {
    const delivery = await deliveries.findOne(
      { _id: replayId, workspaceId },
      { session },
    );
    const previous = await StagedWrite.findById(jobKey(failedJob))
      .session(session)
      .lean();
    const cdc = previous?.intent.cdc;
    const root = previous?.claimOwner ?? previous?._id;
    const member = delivery?.members.find(candidate => candidate.key === root);
    if (
      !delivery ||
      !previous ||
      !cdc ||
      !root ||
      !member ||
      cdc.scope.workspaceId !== workspaceId ||
      previous.cleanedAt ||
      previous.fingerprint !== stagedWriteFingerprint(previous.intent) ||
      verifiedTerminalOutcome(previous) !== "failed"
    ) {
      throw new Error(
        "A replay retry requires a verified failed member of this delivery",
      );
    }

    const job = {
      ...previous.intent.job,
      id: `mako_replay_retry_${previous._id}`,
    };
    const write = prepareStagedWrite({ ...previous.intent, job });
    if (previous.supersededBy) {
      const saved = await StagedWrite.findById(write._id)
        .session(session)
        .lean();
      if (
        previous.supersededBy === write._id &&
        saved?.claimOwner === root &&
        saved.fingerprint === write.fingerprint &&
        stagedWriteFingerprint(saved.intent) === write.fingerprint
      ) {
        return job;
      }
      throw new Error("The saved replay retry does not match its predecessor");
    }

    const active = member.activeAttempt ?? member;
    if (
      active.key !== previous._id ||
      active.fingerprint !== previous.fingerprint
    ) {
      throw new Error("The failed job is no longer the active replay member");
    }
    const owner =
      root === previous._id
        ? previous
        : await StagedWrite.findById(root).session(session).lean();
    if (
      !owner ||
      owner.fingerprint !== member.fingerprint ||
      owner.fingerprint !== stagedWriteFingerprint(owner.intent) ||
      owner.snapshotKey !== write.snapshotKey ||
      owner.cleanedAt ||
      !owner.eventClaimKeys?.length ||
      (owner.latestAttempt ?? root) !== previous._id
    ) {
      throw new Error("The retained replay claim owner changed");
    }

    await reserveRetainedWriteAgainstResync(
      [write.intent.destination, write.intent.input.snapshot],
      cdc.scope,
      session,
    );
    await requireCurrentBigQueryCdcFlow(
      cdc.scope,
      write.intent.destination,
      session,
    );
    await transferClaimedBigQueryCdcEvents(
      cdc,
      previous.fingerprint,
      write.fingerprint,
      session,
    );
    await StagedWrite.create(
      [
        {
          ...write,
          // Keep the original unique index entries for the lifetime of this chain.
          snapshotKey: `retry:${write._id}`,
          claimOwner: root,
        },
      ],
      { session },
    );
    const predecessorUpdate = await StagedWrite.updateOne(
      { _id: previous._id, supersededBy: { $exists: false } },
      { $set: { supersededBy: write._id } },
      { session },
    );
    const ownerUpdate = await StagedWrite.updateOne(
      { _id: root },
      { $set: { latestAttempt: write._id } },
      { session },
    );
    const deliveryUpdate = await deliveries.updateOne(
      { _id: replayId, workspaceId, "members.key": root },
      {
        $set: {
          "members.$.activeAttempt": {
            key: write._id,
            fingerprint: write.fingerprint,
          },
        },
      },
      { session },
    );
    if (
      [predecessorUpdate, ownerUpdate, deliveryUpdate].some(
        update => update.matchedCount !== 1,
      )
    ) {
      throw new Error(
        "The retained replay plan changed before the retry was reserved",
      );
    }
    return job;
  }, retainedWriteTransaction);
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
  const members = delivery.members.map(
    member => member.activeAttempt ?? member,
  );
  const query = StagedWrite.find({
    _id: { $in: members.map(member => member.key) },
  });
  const writes = await (
    session ? query.session(session) : query.readConcern("majority")
  ).lean();
  const byId = new Map(writes.map(write => [write._id, write]));
  let pending = false;
  let failed = false;
  for (const { key, fingerprint } of members) {
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
    const outcome = verifiedTerminalOutcome(write);
    if (!outcome) return null;
    failed ||= outcome === "failed";
  }
  if (pending) return "held";
  return failed ? "failed" : "succeeded";
}

function verifiedTerminalOutcome(
  write: StagedWriteRecord,
): TerminalOutcome["outcome"] | null {
  const receipt = write.terminal;
  if (
    receipt &&
    "fingerprint" in receipt &&
    receipt.fingerprint === write.fingerprint &&
    receipt.state === "DONE" &&
    (receipt.outcome === "succeeded" || receipt.outcome === "failed")
  ) {
    return receipt.outcome;
  }
  return null;
}

function qualify(table: BigQueryTableIdentity) {
  return fullTableName(
    { projectId: table.project, dataset: table.dataset },
    table.table,
  );
}

function buildRetainedMergeIntent(
  { job, input, destination }: StagedWriteBinding,
  merge: RetainedMerge,
  options: RetainedQueryOptions,
): RetainedQueryIntent {
  const configuration = retainedQueryConfiguration.parse({
    ...options,
    query: {
      ...options.query,
      query: buildMergeStatement({
        ...merge,
        fullLive: qualify(destination),
        fullStaging: qualify(input.snapshot),
        stampSyncedAt: input.seal !== undefined,
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
  }, retainedWriteTransaction);
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
    cdc?.scope ?? intent.restOverwrite,
    session,
  );
  if (intent.restOverwrite) {
    await registerRestEntityOverwriteWrite(
      StagedWrite.db,
      restOverwriteReservation(intent.restOverwrite),
      session,
    );
  }
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
  await assertRetainedInputTablesAvailableForResync(scope.tables, session);
  await assertRestBigQueryTruncatesDrainedForResync(
    StagedWrite.db,
    scope,
    session,
  );
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
    // The replacement is committed with the predecessor's claim transfer.
    supersededBy: { $exists: false },
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
  const owners = await StagedWrite.find({
    eventClaimKeys: {
      $exists: true,
      $in: deliveryKeys.map(key => eventClaimKey(scope, key.trim())),
    },
  })
    .readConcern("majority")
    .lean();
  const scopeKey = stableStringify(scope);
  const latest = owners.flatMap(owner =>
    owner.latestAttempt ? [owner.latestAttempt] : [],
  );
  const attempts =
    latest.length === 0
      ? []
      : await StagedWrite.find({ _id: { $in: latest } })
          .readConcern("majority")
          .lean();
  const byId = new Map(attempts.map(attempt => [attempt._id, attempt]));
  return owners.flatMap(owner => {
    const record = owner.latestAttempt ? byId.get(owner.latestAttempt) : owner;
    if (!record || (record !== owner && record.claimOwner !== owner._id)) {
      return [];
    }
    const cdc = record.intent.cdc;
    return cdc &&
      stableStringify(cdc.scope) === scopeKey &&
      record.fingerprint === stagedWriteFingerprint(record.intent)
      ? [record]
      : [];
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

/** Load every write claimed for this run and entity, including unfinished jobs. */
export function readBigQueryRestOverwriteWrites(
  { scope, overwrite }: RestEntityOverwriteReservation,
  session?: ClientSession,
) {
  const query = StagedWrite.find({
    "intent.restOverwrite.workspaceId": scope.workspaceId.toHexString(),
    "intent.restOverwrite.flowId": scope.flowId.toHexString(),
    "intent.restOverwrite.sourceConnectionId":
      scope.sourceConnectionId.toHexString(),
    "intent.restOverwrite.overwrite.runId": overwrite.runId,
    "intent.restOverwrite.overwrite.entity": overwrite.entity,
  });
  return (
    session ? query.session(session) : query.readConcern("majority")
  ).lean();
}

type StagedWriteTarget = BigQueryTableIdentity & {
  workspaceId: string;
  destinationConnectionId: string;
  restDestination?: {
    connectionId: string;
    databaseName: string | null;
    location?: string;
  };
};

async function readReservedBigQueryStagedWrite(
  target: StagedWriteTarget,
  reservation: LeaseJobRef,
): Promise<StagedWriteRecord | null> {
  const { jobId, location, intentFingerprint } = reservation;
  if (
    !reservation.reservedBeforeDispatch ||
    !jobId ||
    !location ||
    !intentFingerprint
  ) {
    return null;
  }
  const job = { project: target.project, location, id: jobId };
  const record = await readBigQueryStagedInput(job);
  if (
    !record ||
    record.cleanedAt ||
    record.fingerprint !== intentFingerprint ||
    record.fingerprint !== stagedWriteFingerprint(record.intent) ||
    record.intent.destination.project !== target.project ||
    record.intent.destination.dataset !== target.dataset ||
    record.intent.destination.table !== target.table
  ) {
    return null;
  }
  const restOverwrite = record.intent.restOverwrite;
  if (restOverwrite) {
    const { overwrite } = restOverwrite;
    if (
      !target.restDestination ||
      restOverwrite.workspaceId !== target.workspaceId ||
      overwrite.destinationId !== target.destinationConnectionId ||
      overwrite.destinationConnectionId !==
        target.restDestination.connectionId ||
      overwrite.destinationDatabaseName !==
        target.restDestination.databaseName ||
      overwrite.schema !== target.dataset ||
      overwrite.tableName !== target.table ||
      record.intent.job.location !==
        target.restDestination.location?.trim().toLowerCase()
    ) {
      return null;
    }
  } else {
    const scope = record.intent.cdc?.scope;
    if (
      !scope ||
      scope.workspaceId !== target.workspaceId ||
      scope.destinationConnectionId !== target.destinationConnectionId
    ) {
      return null;
    }
  }
  return record;
}

function verifiedStagedOutcome({
  intent,
  terminal,
  fingerprint,
}: StagedWriteRecord): TerminalOutcome["outcome"] | null {
  if (
    !terminal ||
    !("fingerprint" in terminal) ||
    terminal.fingerprint !== fingerprint ||
    terminal.state !== "DONE"
  ) {
    return null;
  }
  if (terminal.outcome === "failed") return "failed";
  if (
    terminal.outcome === "succeeded" &&
    (!intent.restOverwrite ||
      terminal.affectedRows === intent.restOverwrite.expectedRows)
  ) {
    return "succeeded";
  }
  return null;
}

/** A reserved table lease needs proof from the exact job and destination. */
export async function settleReservedBigQueryStagedJob(
  target: StagedWriteTarget,
  reservation: LeaseJobRef,
  readJobMetadata: () => Promise<unknown>,
): Promise<boolean> {
  const record = await readReservedBigQueryStagedWrite(target, reservation);
  if (!record) return false;
  const { restOverwrite, input } = record.intent;
  if (restOverwrite && !(await hasRestOverwriteCapture(input, restOverwrite))) {
    return false;
  }
  if (record.terminal) {
    return verifiedStagedOutcome(record) !== null;
  }
  if (restOverwrite) {
    const { scope, overwrite } = restOverwriteReservation(restOverwrite);
    if (
      !(await hasPendingRestEntityOverwrite(StagedWrite.db, scope, overwrite))
    ) {
      return false;
    }
  }
  return recordObservedBigQueryQueryResult(
    record.intent.job,
    await readJobMetadata(),
    record.fingerprint,
  );
}

export class RestBigQueryReplacementNeedsLease extends Error {
  constructor() {
    super("BigQuery replacement requires its table lease");
  }
}

/** Submit one retained INSERT after verifying both its reservation and snapshot. */
export async function dispatchRestBigQueryReplacement(
  target: BigQueryTarget,
  table: string,
  destination: { connectionId: string; databaseName: string | null },
  lease: LeaseJobRef,
): Promise<TerminalOutcome["outcome"] | null> {
  const record = await readReservedBigQueryStagedWrite(
    {
      project: target.projectId,
      dataset: target.dataset,
      table,
      workspaceId: String(target.destination.workspaceId),
      destinationConnectionId: String(target.destination._id),
      restDestination: { ...destination, location: target.datasetLocation },
    },
    lease,
  );
  const restOverwrite = record?.intent.restOverwrite;
  if (!record || !restOverwrite) {
    throw new Error(
      "BigQuery replacement does not match the reserved destination",
    );
  }
  const { job, input } = record.intent;
  if (
    !record.terminal &&
    !(await CdcTableWriteLease.exists({
      _id: getSchemaCacheKey(target.projectId, target.dataset, table),
      jobId: job.id,
      jobLocation: lease.location,
      jobReservedBeforeDispatch: true,
      jobIntentFingerprint: record.fingerprint,
    }).readConcern("majority"))
  ) {
    throw new RestBigQueryReplacementNeedsLease();
  }
  if (!(await hasRestOverwriteCapture(input, restOverwrite))) {
    throw new Error("BigQuery replacement has no capture for its source range");
  }
  if (record.terminal) return verifiedStagedOutcome(record);
  const request = await readPendingBigQueryQueryRequest(
    job,
    record.fingerprint,
  );
  if (!request) return null;
  let metadata = await readRetainedBigQueryJob(target, job);
  if (!metadata) {
    const observed = await readBigQueryInputSnapshot(target, input.snapshot);
    if (
      observed?.input.generation !== input.generation ||
      observed.rows !== restOverwrite.expectedRows
    ) {
      throw new Error("BigQuery replacement input snapshot changed");
    }
    try {
      await target.bq.createJob({
        jobId: job.id,
        location: job.location,
        configuration: request.configuration,
      });
    } catch (error) {
      if ((error as { code?: number })?.code !== 409) throw error;
    }
    metadata = await readRetainedBigQueryJob(target, job);
  }
  if (
    !(await recordObservedBigQueryQueryResult(
      job,
      metadata,
      record.fingerprint,
    ))
  ) {
    return null;
  }
  const terminal = await readBigQueryStagedInput(job);
  return terminal ? verifiedStagedOutcome(terminal) : null;
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
  if (record.intent.restOverwrite) {
    const { scope, overwrite } = restOverwriteReservation(
      record.intent.restOverwrite,
    );
    if (
      !(await hasPendingRestEntityOverwrite(StagedWrite.db, scope, overwrite))
    ) {
      return null;
    }
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
    record.intent.restOverwrite ? "INSERT" : "MERGE",
    record.intent.restOverwrite?.expectedRows,
  );
  if (!outcome) return false;
  const receipt: VerifiedQueryReceipt = {
    state: "DONE",
    outcome,
    fingerprint: record.fingerprint,
    ...(record.intent.restOverwrite && outcome === "succeeded"
      ? { affectedRows: record.intent.restOverwrite.expectedRows }
      : {}),
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
    }, retainedWriteTransaction);
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
