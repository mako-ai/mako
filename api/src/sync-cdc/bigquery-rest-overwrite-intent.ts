import { createHash } from "node:crypto";
import type { Filter } from "mongodb";
import { Types, type ClientSession, type Connection } from "mongoose";
import { getSchemaCacheKey } from "./adapters/bigquery-schema";
import { fullTableName } from "./adapters/bigquery-sql";
import type { BigQueryTarget } from "./adapters/bigquery-target";
import {
  readRetainedBigQueryJob,
  retainedQueryConfiguration,
  retainedQueryOutcome,
  type BigQueryJobIdentity,
  type RetainedQueryConfiguration,
} from "./bigquery-retained-query";
import {
  CdcResyncConflictError,
  reserveRetainedWriteAgainstResync,
  type CdcResyncScope,
} from "./cdc-resync-fence";
import { stableStringify } from "./normalization";
import {
  hasPendingRestEntityOverwrite,
  type RestEntityAdmissionScope,
  type RestEntityOverwrite,
  type RestEntityOverwriteReservation,
} from "./rest-entity-admission";
import { CdcTableWriteLease, type LeaseJobRef } from "./table-write-lease";

interface TruncateTarget {
  projectId: string;
  dataset: string;
  location: string;
  table: string;
}

interface RetainedTruncate {
  _id: string;
  fingerprint: string;
  scope: RestEntityAdmissionScope;
  overwrite: RestEntityOverwrite;
  target: TruncateTarget;
  job: BigQueryJobIdentity;
  configuration: RetainedQueryConfiguration;
  dispatchStarted?: boolean;
  terminal?: "succeeded" | "failed" | "absent";
  settledAt?: Date;
}

type TruncateOutcome = NonNullable<RetainedTruncate["terminal"]>;

const writeConcern = { w: "majority" as const };
const jobPrefix = "mako_rest_truncate_";

export function isRestBigQueryTruncateJob(jobId: string): boolean {
  return jobId.startsWith(jobPrefix);
}

export class RestBigQueryTruncateNeedsLease extends Error {
  constructor() {
    super("BigQuery truncate requires its table and REST reservations");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function truncateJobId({
  scope,
  overwrite,
}: RestEntityOverwriteReservation): string {
  const runKey = [
    scope.workspaceId,
    scope.flowId,
    scope.sourceConnectionId,
  ].map(id => id.toHexString());
  return `${jobPrefix}${digest([runKey, overwrite])}`;
}

function truncateFingerprint(
  record: Omit<RetainedTruncate, "_id" | "fingerprint" | "terminal">,
): string {
  const { scope, overwrite, target, job, configuration } = record;
  return digest([
    scope.workspaceId.toHexString(),
    scope.flowId.toHexString(),
    scope.sourceConnectionId.toHexString(),
    overwrite,
    target,
    job,
    configuration,
  ]);
}

function records(connection: Connection) {
  if (!connection.db) throw new Error("MongoDB connection is not open");
  return connection.db.collection<RetainedTruncate>(
    "rest_bigquery_overwrite_truncates",
  );
}

async function hasUnsettledTruncate(
  connection: Connection,
  filter: Filter<RetainedTruncate>,
  session: ClientSession,
): Promise<boolean> {
  const candidates = records(connection).find(
    { ...filter, settledAt: { $exists: false } },
    { session, projection: { scope: 1, overwrite: 1 } },
  );
  for await (const candidate of candidates) {
    // Older retained receipts may predate the settlement timestamp.
    if (
      await hasPendingRestEntityOverwrite(
        connection,
        candidate.scope,
        candidate.overwrite,
        session,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function matchesRestBigQueryTruncateDestination(
  target: BigQueryTarget,
  retained: RetainedTruncate,
) {
  return (
    target.projectId === retained.job.project &&
    target.dataset === retained.target.dataset &&
    target.datasetLocation?.trim().toLowerCase() === retained.job.location &&
    String(target.destination._id) === retained.overwrite.destinationId &&
    String(target.destination.workspaceId) ===
      retained.scope.workspaceId.toHexString() &&
    retained.fingerprint === truncateFingerprint(retained)
  );
}

async function hasTableReservation(
  target: BigQueryTarget,
  retained: RetainedTruncate,
) {
  return CdcTableWriteLease.exists({
    _id: getSchemaCacheKey(
      retained.job.project,
      target.dataset,
      retained.target.table,
    ),
    jobId: retained.job.id,
    jobLocation: retained.job.location,
    jobReservedBeforeDispatch: true,
    jobIntentFingerprint: retained.fingerprint,
  }).readConcern("majority");
}

/** Store the exact destructive request before handing it to the provider. */
export async function retainRestBigQueryTruncate(
  connection: Connection,
  scope: RestEntityAdmissionScope,
  overwrite: RestEntityOverwrite,
  target: TruncateTarget,
  options: Omit<RetainedQueryConfiguration, "query"> & {
    query: Omit<RetainedQueryConfiguration["query"], "query">;
  },
): Promise<RetainedTruncate> {
  const location = target.location.trim().toLowerCase();
  if (
    !location ||
    !target.projectId ||
    !target.dataset ||
    target.dataset !== overwrite.schema ||
    target.table !== overwrite.tableName
  ) {
    throw new Error(
      "BigQuery truncate must match the reserved REST destination",
    );
  }
  const _id = truncateJobId({ scope, overwrite });
  const requested = {
    scope,
    overwrite,
    target: { ...target, location },
    job: { project: target.projectId, location, id: _id },
    configuration: retainedQueryConfiguration.parse({
      ...options,
      query: {
        ...options.query,
        query: `DELETE FROM ${fullTableName(target, target.table)} WHERE TRUE`,
      },
    }),
  };
  return connection.transaction(
    async session => {
      await reserveRetainedWriteAgainstResync(
        [
          {
            project: target.projectId,
            dataset: target.dataset,
            table: target.table,
          },
        ],
        {
          workspaceId: scope.workspaceId.toHexString(),
          flowId: scope.flowId.toHexString(),
        },
        session,
      );
      if (
        !(await hasPendingRestEntityOverwrite(
          connection,
          scope,
          overwrite,
          session,
        ))
      ) {
        throw new Error("BigQuery truncate requires a pending REST overwrite");
      }
      // The shared table fence serializes this check and the retained insert.
      // A retry can reuse its own request while the overwrite is pending.
      if (
        await hasUnsettledTruncate(
          connection,
          {
            _id: { $ne: _id },
            "target.projectId": target.projectId,
            "target.dataset": target.dataset,
            "target.table": target.table,
          },
          session,
        )
      ) {
        throw new Error("Another REST overwrite is holding this table");
      }
      const record = await records(connection).findOneAndUpdate(
        { _id },
        {
          $setOnInsert: {
            ...requested,
            fingerprint: truncateFingerprint(requested),
          },
        },
        { upsert: true, returnDocument: "after", session },
      );
      if (
        !record ||
        record.fingerprint !== truncateFingerprint(record) ||
        stableStringify(record.target) !== stableStringify(requested.target)
      ) {
        throw new Error(
          "BigQuery truncate destination changed after reservation",
        );
      }
      return record;
    },
    { readConcern: { level: "snapshot" }, writeConcern },
  );
}

/** Block resync even when the overwrite has not registered a replacement. */
export async function assertRestBigQueryTruncatesDrainedForResync(
  connection: Connection,
  scope: CdcResyncScope,
  session: ClientSession,
): Promise<void> {
  const related: Record<string, unknown>[] = scope.tables.map(
    ({ project, dataset, table }) => ({
      "target.projectId": project,
      "target.dataset": dataset,
      "target.table": table,
    }),
  );
  if (
    Types.ObjectId.isValid(scope.workspaceId) &&
    Types.ObjectId.isValid(scope.flowId)
  ) {
    related.push({
      "scope.workspaceId": new Types.ObjectId(scope.workspaceId),
      "scope.flowId": new Types.ObjectId(scope.flowId),
      ...(scope.entities?.length
        ? { "overwrite.entity": { $in: scope.entities } }
        : {}),
    });
  }
  if (related.length === 0) return;
  if (await hasUnsettledTruncate(connection, { $or: related }, session)) {
    throw new CdcResyncConflictError(
      "CDC resync is blocked by an unsettled REST overwrite",
    );
  }
}

/** Record completion in the transaction that releases the verified overwrite. */
export async function markRestBigQueryTruncateSettled(
  connection: Connection,
  reservation: RestEntityOverwriteReservation,
  session: ClientSession,
): Promise<void> {
  const result = await records(connection).updateOne(
    {
      _id: truncateJobId(reservation),
      terminal: { $in: ["succeeded", "absent"] },
    },
    { $min: { settledAt: new Date() } },
    { session },
  );
  if (result.matchedCount !== 1) {
    throw new Error("Verified REST overwrite has no terminal truncate");
  }
}

/** Read exact destination evidence for the start of this overwrite. */
export async function readRestBigQueryTruncateReceipt(
  connection: Connection,
  reservation: RestEntityOverwriteReservation,
  session?: ClientSession,
): Promise<RetainedTruncate | null> {
  const jobId = truncateJobId(reservation);
  const record = await records(connection).findOne(
    { _id: jobId },
    session ? { session } : { readConcern: { level: "majority" } },
  );
  if (
    !record ||
    record.job.id !== jobId ||
    truncateJobId(record) !== jobId ||
    record.fingerprint !== truncateFingerprint(record) ||
    (record.terminal !== "succeeded" && record.terminal !== "absent")
  ) {
    return null;
  }
  return record;
}

/** A terminal truncate alone leaves the overwrite reservation pending. */
export async function recordRestBigQueryTruncateResult(
  connection: Connection,
  reserved: Pick<RetainedTruncate, "job" | "fingerprint">,
  metadata: unknown,
): Promise<TruncateOutcome | null> {
  const filter = { _id: reserved.job.id, fingerprint: reserved.fingerprint };
  const record = await records(connection).findOne(filter, {
    readConcern: { level: "majority" },
  });
  if (
    !record ||
    record.fingerprint !== truncateFingerprint(record) ||
    stableStringify(record.job) !== stableStringify(reserved.job)
  ) {
    return null;
  }
  const outcome = retainedQueryOutcome(
    record.job,
    record.configuration,
    metadata,
    "DELETE",
  );
  if (!outcome) return null;
  const update = await records(connection).updateOne(
    {
      ...filter,
      $or: [{ terminal: { $exists: false } }, { terminal: outcome }],
    },
    { $set: { terminal: outcome } },
    { writeConcern },
  );
  return update.matchedCount === 1 ? outcome : null;
}

/** Submit or recover only the same job while its exact table reservation exists. */
export async function dispatchRestBigQueryTruncate(
  connection: Connection,
  target: BigQueryTarget,
  retained: RetainedTruncate,
): Promise<TruncateOutcome | null> {
  const stored = await records(connection).findOne(
    { _id: retained.job.id, fingerprint: retained.fingerprint },
    { readConcern: { level: "majority" } },
  );
  if (!stored || !matchesRestBigQueryTruncateDestination(target, stored)) {
    throw new Error("BigQuery truncate request is missing or changed");
  }
  if (stored.terminal) {
    return stored.terminal;
  }
  const { job, configuration, overwrite, scope } = stored;
  if (!(await hasPendingRestEntityOverwrite(connection, scope, overwrite))) {
    throw new Error("BigQuery truncate requires a pending REST overwrite");
  }
  if (!(await hasTableReservation(target, stored))) {
    throw new RestBigQueryTruncateNeedsLease();
  }

  let metadata = await readRetainedBigQueryJob(target, job);
  if (!metadata) {
    const pending = await records(connection).updateOne(
      {
        _id: job.id,
        fingerprint: stored.fingerprint,
        terminal: { $exists: false },
      },
      { $set: { dispatchStarted: true } },
      { writeConcern },
    );
    if (pending.matchedCount !== 1) return null;
    try {
      // createJob builds jobReference from these options.
      await target.bq.createJob({
        jobId: job.id,
        location: job.location,
        configuration,
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 409) throw error;
    }
    metadata = await readRetainedBigQueryJob(target, job);
  }
  return recordRestBigQueryTruncateResult(connection, stored, metadata);
}

/** Record a missing live table before any attempt starts the retained job. */
export async function recordRestBigQueryTruncateAbsence(
  connection: Connection,
  target: BigQueryTarget,
  retained: RetainedTruncate,
): Promise<boolean> {
  if (
    !matchesRestBigQueryTruncateDestination(target, retained) ||
    !(await hasTableReservation(target, retained))
  ) {
    throw new RestBigQueryTruncateNeedsLease();
  }
  const [exists] = await target.bq
    .dataset(target.dataset)
    .table(retained.target.table)
    .exists();
  if (exists) return false;
  const result = await records(connection).updateOne(
    {
      _id: retained.job.id,
      fingerprint: retained.fingerprint,
      dispatchStarted: { $ne: true },
      terminal: { $exists: false },
    },
    { $set: { terminal: "absent" } },
    { writeConcern },
  );
  return result.matchedCount === 1;
}

/** Verify a table lease's job without settling the enclosing REST overwrite. */
export async function settleReservedBigQueryRestTruncate(
  connection: Connection,
  target: BigQueryTarget,
  liveTable: string,
  lease: LeaseJobRef,
): Promise<boolean> {
  if (
    !lease.reservedBeforeDispatch ||
    !lease.location ||
    !lease.intentFingerprint
  ) {
    return false;
  }
  const record = await records(connection).findOne(
    {
      _id: lease.jobId,
      fingerprint: lease.intentFingerprint,
      "job.location": lease.location,
    },
    { readConcern: { level: "majority" } },
  );
  if (
    !record ||
    record.target.table !== liveTable ||
    !matchesRestBigQueryTruncateDestination(target, record)
  ) {
    return false;
  }
  if (record.terminal) {
    return true;
  }
  return (
    (await recordRestBigQueryTruncateResult(
      connection,
      record,
      await readRetainedBigQueryJob(target, record.job),
    )) !== null
  );
}
