import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import mongoose, { type ClientSession } from "mongoose";
import { z } from "zod";
import {
  bigQuerySnapshotGeneration,
  type BigQueryJobIdentity,
  type BigQueryTableIdentity,
} from "../bigquery-retained-query";
import { stableStringify } from "../normalization";
import type { BigQueryCdcBinding } from "../bigquery-staged-cdc";
import {
  CdcResyncConflictError,
  reserveRetainedWriteAgainstResync,
} from "../cdc-resync-fence";
import { canLabelLoadJobs } from "./bigquery-load-labels";
import type { BigQueryTarget } from "./bigquery-target";

interface RetainedInputPlan {
  mergeJob: BigQueryJobIdentity;
  source: BigQueryTableIdentity;
  snapshot: BigQueryTableIdentity;
  loadJob: BigQueryJobIdentity;
  copyJob: BigQueryJobIdentity;
  sha256: string;
  bytes: number;
  rows: number;
  cdcFingerprint: string;
}

interface RetainedInputRecord {
  _id: string;
  plan: RetainedInputPlan;
  loadAttempted?: true;
  copyAttempted?: true;
  loadCompletedAt?: number;
  copyCompletedAt?: number;
  generation?: string;
}

type RetainedInputResult =
  | { state: "needs-artifact" }
  | { state: "pending" | "failed"; phase: "load" | "copy" }
  | {
      state: "ready";
      input: {
        snapshot: BigQueryTableIdentity;
        generation: string;
        seal: string;
      };
    };

interface RetainedInputWarehouse {
  checkDataset(plan: RetainedInputPlan): Promise<void>;
  readJob(job: BigQueryJobIdentity): Promise<unknown>;
  load(plan: RetainedInputPlan, parquet: Buffer): Promise<void>;
  copy(plan: RetainedInputPlan): Promise<void>;
  readSnapshot(
    table: BigQueryTableIdentity,
    location: string,
  ): Promise<unknown>;
}

const tableReference = z.object({
  projectId: z.string(),
  datasetId: z.string(),
  tableId: z.string(),
});
const count = z.string().regex(/^(0|[1-9]\d*)$/);
const jobMetadata = z.object({
  jobReference: z.object({
    projectId: z.string(),
    jobId: z.string(),
    location: z.string(),
  }),
  status: z.object({
    state: z.enum(["PENDING", "RUNNING", "DONE"]),
    errorResult: z.object({ reason: z.string().min(1) }).optional(),
  }),
  configuration: z.object({
    labels: z.record(z.string(), z.string()).optional(),
    load: z
      .object({
        destinationTable: tableReference,
        sourceFormat: z.literal("PARQUET"),
        writeDisposition: z.literal("WRITE_EMPTY"),
        createDisposition: z.literal("CREATE_IF_NEEDED"),
        sourceUris: z.array(z.string()).max(0).optional(),
        maxBadRecords: z.literal(0).optional(),
      })
      .optional(),
    copy: z
      .object({
        sourceTables: z.array(tableReference).length(1),
        destinationTable: tableReference,
        operationType: z.literal("SNAPSHOT"),
        writeDisposition: z.literal("WRITE_EMPTY"),
        createDisposition: z.literal("CREATE_IF_NEEDED"),
        destinationExpirationTime: z.undefined().optional(),
      })
      .optional(),
  }),
  statistics: z
    .object({
      endTime: count.optional(),
      load: z
        .object({
          inputFiles: count,
          inputFileBytes: count,
          outputRows: count,
          badRecords: count.optional(),
        })
        .optional(),
    })
    .optional(),
});

function reference(table: BigQueryTableIdentity) {
  return {
    projectId: table.project,
    datasetId: table.dataset,
    tableId: table.table,
  };
}

function sameTable(
  actual: z.infer<typeof tableReference> | undefined,
  expected: BigQueryTableIdentity,
) {
  return (
    actual?.projectId === expected.project &&
    actual.datasetId === expected.dataset &&
    actual.tableId === expected.table
  );
}

function inputLabels(plan: RetainedInputPlan) {
  // BigQuery limits label values to 63 characters.
  return {
    replay_input: plan.sha256.slice(0, 32),
    replay_input_hash: plan.sha256.slice(32),
  };
}

function readTerminalPhase(
  plan: RetainedInputPlan,
  phase: "load" | "copy",
  metadata: unknown,
) {
  if (metadata === null) return { state: "pending" } as const;
  const result = jobMetadata.safeParse(metadata);
  if (!result.success) {
    throw new Error(`Invalid BigQuery replay ${phase} job metadata`);
  }
  const { jobReference, status, configuration, statistics } = result.data;
  const expectedJob = phase === "load" ? plan.loadJob : plan.copyJob;
  const labelsMatch = Object.entries(inputLabels(plan)).every(
    ([key, value]) => configuration.labels?.[key] === value,
  );
  const configurationMatches =
    phase === "load"
      ? sameTable(configuration.load?.destinationTable, plan.source) &&
        !configuration.copy &&
        labelsMatch
      : sameTable(configuration.copy?.sourceTables[0], plan.source) &&
        sameTable(configuration.copy?.destinationTable, plan.snapshot) &&
        !configuration.load;
  if (
    jobReference.projectId !== expectedJob.project ||
    jobReference.jobId !== expectedJob.id ||
    jobReference.location.toLowerCase() !== expectedJob.location ||
    !configurationMatches
  ) {
    throw new Error(
      `BigQuery replay ${phase} job differs from the retained input plan`,
    );
  }
  if (status.state !== "DONE") return { state: "pending" } as const;
  if (status.errorResult) return { state: "failed" } as const;
  const endTime = Number(statistics?.endTime);
  if (!Number.isSafeInteger(endTime) || endTime <= 0) {
    throw new Error(
      `BigQuery replay ${phase} receipt is missing its completion time`,
    );
  }
  if (
    phase === "load" &&
    (statistics?.load?.inputFiles !== "1" ||
      statistics.load.inputFileBytes !== String(plan.bytes) ||
      statistics.load.outputRows !== String(plan.rows) ||
      (statistics.load.badRecords ?? "0") !== "0")
  ) {
    throw new Error(
      "BigQuery replay load counts differ from the retained input plan",
    );
  }
  return { state: "complete", endTime } as const;
}

function store() {
  const database = mongoose.connection.db;
  if (!database) throw new Error("MongoDB connection is not open");
  return database.collection<RetainedInputRecord>(
    "cdc_bigquery_retained_inputs",
  );
}

const writeConcern = { w: "majority" as const };
const readConcern = { level: "majority" as const };
const fingerprint = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");

export async function assertRetainedInputTablesAvailableForResync(
  tables: BigQueryTableIdentity[],
  session: ClientSession,
): Promise<void> {
  const reserved = tables.flatMap(table => {
    const match = /^mako_replay_(source|snapshot)_([a-f0-9]{64})$/.exec(
      table.table,
    );
    return match
      ? [
          {
            _id: match[2],
            [`plan.${match[1]}.project`]: table.project,
            [`plan.${match[1]}.dataset`]: table.dataset,
            [`plan.${match[1]}.table`]: table.table,
          },
        ]
      : [];
  });
  if (
    reserved.length > 0 &&
    (await store().findOne(
      { $or: reserved },
      { session, projection: { _id: 1 } },
    ))
  ) {
    throw new CdcResyncConflictError(
      "CDC resync is blocked by a retained replay input table",
    );
  }
}

/** A seal is specific to the MERGE and the exact authorized CDC rows. */
export async function assertRetainedBigQueryInputSeal(
  input: { snapshot: BigQueryTableIdentity; generation: string; seal: string },
  mergeJob: BigQueryJobIdentity,
  cdc: BigQueryCdcBinding,
): Promise<void> {
  const job = { ...mergeJob, location: mergeJob.location.trim().toLowerCase() };
  const current = await store().findOne({ _id: input.seal }, { readConcern });
  if (
    !current ||
    input.seal !== fingerprint(job) ||
    stableStringify(current.plan.mergeJob) !== stableStringify(job) ||
    stableStringify(current.plan.snapshot) !==
      stableStringify(input.snapshot) ||
    current.plan.cdcFingerprint !== fingerprint(cdc) ||
    !current.generation ||
    current.generation !== input.generation
  ) {
    throw new Error(
      "Retained replay input seal differs from the job or its CDC rows",
    );
  }
}

/** Use the exact prepared bytes on the first call. A restart can advance by job ID alone. */
export async function sealRetainedBigQueryInput(
  warehouse: RetainedInputWarehouse,
  mergeJob: BigQueryJobIdentity,
  dataset: string,
  cdc: BigQueryCdcBinding,
  artifact?: { parquet: Buffer; rows: number },
): Promise<RetainedInputResult> {
  const job = { ...mergeJob, location: mergeJob.location.trim().toLowerCase() };
  if (!job.project || !job.id || !job.location || !dataset) {
    throw new Error(
      "Retained inputs require an exact project, location, dataset and merge job",
    );
  }
  const _id = fingerprint(job);
  const cdcFingerprint = fingerprint(cdc);
  const records = store();
  // Copy before hashing so the same bytes reach the SDK even if the caller mutates its buffer.
  const bytes = artifact && Buffer.from(artifact.parquet);
  if (artifact && bytes) {
    if (
      artifact.rows !== cdc.events.length ||
      artifact.rows <= 0 ||
      bytes.length === 0
    ) {
      throw new Error(
        "A retained input requires one Parquet row per bound CDC event",
      );
    }
    const plan = {
      mergeJob: job,
      source: {
        project: job.project,
        dataset,
        table: `mako_replay_source_${_id}`,
      },
      snapshot: {
        project: job.project,
        dataset,
        table: `mako_replay_snapshot_${_id}`,
      },
      loadJob: { ...job, id: `mako_replay_load_${_id}` },
      copyJob: { ...job, id: `mako_replay_copy_${_id}` },
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      rows: artifact.rows,
      cdcFingerprint,
    };
    await mongoose.connection.transaction(
      async session => {
        const current = await records.findOne({ _id }, { session });
        if (current) {
          if (stableStringify(current.plan) !== stableStringify(plan)) {
            throw new Error(
              "The merge job already has a different retained input plan",
            );
          }
          return;
        }
        await reserveRetainedWriteAgainstResync(
          [plan.source, plan.snapshot],
          undefined,
          session,
        );
        await records.insertOne({ _id, plan }, { session });
      },
      { readConcern: { level: "snapshot" }, writeConcern },
    );
  }
  const current = await records.findOne({ _id }, { readConcern });
  if (!current) return { state: "needs-artifact" };
  if (
    current.plan.source.dataset !== dataset ||
    current.plan.cdcFingerprint !== cdcFingerprint
  ) {
    throw new Error(
      "The merge job has a different retained input dataset or CDC binding",
    );
  }
  const { plan } = current;
  const ready = (generation: string): RetainedInputResult => ({
    state: "ready",
    input: { snapshot: plan.snapshot, generation, seal: _id },
  });
  if (current.generation) return ready(current.generation);
  if (!bytes && !current.loadAttempted) return { state: "needs-artifact" };
  const attemptedPhases = {
    load: current.loadAttempted,
    copy: current.copyAttempted,
  };

  async function advance(
    phase: "load" | "copy",
    submit: (() => Promise<void>) | undefined,
  ) {
    const attempted = phase === "load" ? "loadAttempted" : "copyAttempted";
    const completed = phase === "load" ? "loadCompletedAt" : "copyCompletedAt";
    const job = phase === "load" ? plan.loadJob : plan.copyJob;
    if (submit && !attemptedPhases[phase]) {
      await warehouse.checkDataset(plan);
      const claimed = await records.updateOne(
        {
          _id,
          [attempted]: { $exists: false },
          ...(phase === "copy" && { loadCompletedAt: { $exists: true } }),
        },
        { $set: { [attempted]: true } },
        { writeConcern },
      );
      if (claimed.modifiedCount === 1) {
        try {
          await submit();
        } catch {
          // Upload or job submission can lose its acknowledgement. Only jobs.get advances the plan.
        }
      }
    }
    const reservation = await records.findOne({ _id }, { readConcern });
    const saved = reservation?.[completed];
    if (saved !== undefined) {
      return { state: "complete", endTime: saved } as const;
    }
    if (!reservation?.[attempted]) return { state: "pending" } as const;
    const terminal = readTerminalPhase(
      plan,
      phase,
      await warehouse.readJob(job),
    );
    if (terminal.state === "complete") {
      await records.updateOne(
        { _id, [attempted]: true, [completed]: { $exists: false } },
        { $set: { [completed]: terminal.endTime } },
        { writeConcern },
      );
      const durable = await records.findOne({ _id }, { readConcern });
      if (durable?.[completed] !== terminal.endTime) {
        throw new Error(
          `BigQuery replay ${phase} completion changed during verification`,
        );
      }
    }
    return terminal;
  }

  const loaded = await advance(
    "load",
    bytes && (() => warehouse.load(plan, bytes)),
  );
  if (loaded.state !== "complete") {
    return { state: loaded.state, phase: "load" };
  }
  const copied = await advance("copy", () => warehouse.copy(plan));
  if (copied.state !== "complete") {
    return { state: copied.state, phase: "copy" };
  }

  const metadata = await warehouse.readSnapshot(plan.snapshot, job.location);
  if (metadata === null) return { state: "pending", phase: "copy" };
  const snapshot = z
    .object({
      numRows: count,
      snapshotDefinition: z.object({
        baseTableReference: tableReference,
        snapshotTime: z.iso.datetime({ offset: true }),
      }),
    })
    .safeParse(metadata);
  const generation = bigQuerySnapshotGeneration(
    plan.snapshot,
    job.location,
    metadata,
  );
  const snapshotTime = snapshot.success
    ? Date.parse(snapshot.data.snapshotDefinition.snapshotTime)
    : NaN;
  if (
    !snapshot.success ||
    !generation ||
    snapshot.data.numRows !== String(plan.rows) ||
    !sameTable(
      snapshot.data.snapshotDefinition.baseTableReference,
      plan.source,
    ) ||
    !Number.isFinite(snapshotTime) ||
    snapshotTime < loaded.endTime ||
    snapshotTime > copied.endTime
  ) {
    throw new Error(
      "BigQuery snapshot metadata differs from the retained load and copy receipts",
    );
  }
  await records.updateOne(
    { _id, generation: { $exists: false } },
    { $set: { generation } },
    { writeConcern },
  );
  const sealed = await records.findOne({ _id }, { readConcern });
  if (sealed?.generation !== generation) {
    throw new Error("The retained snapshot generation changed during sealing");
  }
  return ready(generation);
}

/** Send fixed job IDs through the existing BigQuery SDK and its load-label support. */
export function retainedInputWarehouse(
  target: BigQueryTarget,
): RetainedInputWarehouse {
  const { bq } = target;
  if (!canLabelLoadJobs(bq)) {
    throw new Error("Retained replay requires BigQuery load job labels");
  }
  const dataset = (identity: BigQueryTableIdentity, location: string) =>
    bq.dataset(identity.dataset, { projectId: identity.project, location });
  const table = (identity: BigQueryTableIdentity, location: string) =>
    dataset(identity, location).table(identity.table);
  const read = async (getMetadata: () => Promise<[unknown, ...unknown[]]>) => {
    try {
      const [metadata] = await getMetadata();
      return metadata;
    } catch (error) {
      if ((error as { code?: number })?.code === 404) return null;
      throw error;
    }
  };
  return {
    async checkDataset(plan) {
      const [metadata] = await dataset(
        plan.source,
        plan.mergeJob.location,
      ).getMetadata();
      const expiry = metadata.defaultTableExpirationMs;
      if (expiry !== undefined && expiry !== null && String(expiry) !== "0") {
        throw new Error(
          "Retained replay requires a dataset without automatic table expiry",
        );
      }
    },
    readJob: identity =>
      read(() =>
        bq
          .job(identity.id, {
            projectId: identity.project,
            location: identity.location,
          })
          .getMetadata(),
      ),
    readSnapshot: (identity, location) =>
      read(() => table(identity, location).getMetadata()),
    async load(plan, parquet) {
      const metadata = {
        jobId: plan.loadJob.id,
        sourceFormat: "PARQUET",
        writeDisposition: "WRITE_EMPTY",
        createDisposition: "CREATE_IF_NEEDED",
        labels: inputLabels(plan),
      };
      await pipeline(
        Readable.from([parquet]),
        table(plan.source, plan.loadJob.location).createWriteStream(metadata),
      );
    },
    async copy(plan) {
      await bq.createJob({
        jobId: plan.copyJob.id,
        location: plan.copyJob.location,
        configuration: {
          copy: {
            sourceTables: [reference(plan.source)],
            destinationTable: reference(plan.snapshot),
            operationType: "SNAPSHOT",
            writeDisposition: "WRITE_EMPTY",
            createDisposition: "CREATE_IF_NEEDED",
          },
        },
      });
    },
  };
}
