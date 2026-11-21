import { createHash } from "node:crypto";
import { z } from "zod";
import type { BigQueryTarget } from "./adapters/bigquery-target";
import { stableStringify } from "./normalization";

const nonnegativeInteger = z.string().regex(/^(0|[1-9]\d*)$/);
const dispatchQuery = z.strictObject({
  query: z.string().min(1),
  useLegacySql: z.literal(false),
  priority: z.enum(["BATCH", "INTERACTIVE"]),
  maximumBytesBilled: nonnegativeInteger.optional(),
});

export const retainedQueryConfiguration = z.strictObject({
  query: dispatchQuery,
  labels: z.record(z.string(), z.string()).optional(),
  jobTimeoutMs: nonnegativeInteger.optional(),
});

export type RetainedQueryConfiguration = z.infer<
  typeof retainedQueryConfiguration
>;

export interface BigQueryJobIdentity {
  project: string;
  location: string;
  id: string;
}

export interface BigQueryTableIdentity {
  project: string;
  dataset: string;
  table: string;
}

const nonempty = z.string().min(1);
const tableReference = z.object({
  projectId: nonempty,
  datasetId: nonempty,
  tableId: nonempty,
});
const retainedSnapshot = z.object({
  type: z.literal("SNAPSHOT"),
  tableReference,
  location: nonempty,
  creationTime: nonnegativeInteger,
  etag: nonempty,
  expirationTime: z.undefined().optional(),
  snapshotDefinition: z.object({
    baseTableReference: tableReference,
    snapshotTime: z.iso.datetime({ offset: true }),
  }),
});

/** Pin provider metadata for a read-only input with no automatic expiry. */
export function bigQuerySnapshotGeneration(
  table: BigQueryTableIdentity,
  location: string,
  metadata: unknown,
): string | null {
  const parsed = retainedSnapshot.safeParse(metadata);
  if (!parsed.success) return null;
  const reference = parsed.data.tableReference;
  if (
    reference.projectId !== table.project ||
    reference.datasetId !== table.dataset ||
    reference.tableId !== table.table ||
    !sameBigQueryLocation(parsed.data.location, location)
  ) {
    return null;
  }
  return createHash("sha256")
    .update(stableStringify(parsed.data))
    .digest("hex");
}

export async function readRetainedBigQueryJob(
  target: BigQueryTarget,
  job: BigQueryJobIdentity,
) {
  try {
    const [metadata] = await target.bq
      .job(job.id, { location: job.location })
      .getMetadata();
    return metadata;
  } catch (error) {
    if ((error as { code?: number })?.code === 404) return null;
    throw error;
  }
}

const observedJob = z.object({
  jobReference: z.object({
    projectId: z.string(),
    location: z.string(),
    jobId: z.string(),
  }),
  configuration: retainedQueryConfiguration.extend({
    jobType: z.literal("QUERY").optional(),
    dryRun: z.literal(false).optional(),
    query: dispatchQuery.extend({ useQueryCache: z.boolean().optional() }),
  }),
  status: z.object({
    state: z.literal("DONE"),
    errorResult: z.object({ reason: z.string().min(1) }).optional(),
  }),
  statistics: z
    .object({
      query: z
        .object({
          statementType: z.string().optional(),
          numDmlAffectedRows: z.unknown().optional(),
        })
        .optional(),
    })
    .optional(),
});

function sameBigQueryLocation(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Match the provider's job, including execution options, before interpreting DONE. */
export function retainedQueryOutcome(
  job: BigQueryJobIdentity,
  expected: RetainedQueryConfiguration,
  response: unknown,
  statementType:
    "MERGE" | "DELETE" | "INSERT" | "CREATE_SNAPSHOT_TABLE" = "MERGE",
  expectedAffectedRows?: number,
): "succeeded" | "failed" | null {
  const parsed = observedJob.safeParse(response);
  if (!parsed.success) return null;
  const {
    jobReference,
    configuration: observed,
    status,
    statistics,
  } = parsed.data;
  if (
    jobReference.projectId !== job.project ||
    jobReference.jobId !== job.id ||
    !sameBigQueryLocation(jobReference.location, job.location) ||
    observed.query.query !== expected.query.query ||
    observed.query.priority !== expected.query.priority ||
    observed.query.maximumBytesBilled !== expected.query.maximumBytesBilled ||
    observed.jobTimeoutMs !== expected.jobTimeoutMs ||
    stableStringify(observed.labels ?? {}) !==
      stableStringify(expected.labels ?? {})
  ) {
    return null;
  }
  const observedType = statistics?.query?.statementType;
  if (observedType && observedType !== statementType) return null;
  if (status.errorResult) return "failed";
  if (
    expectedAffectedRows !== undefined &&
    statistics?.query?.numDmlAffectedRows !== String(expectedAffectedRows)
  ) {
    return null;
  }
  return observedType === statementType ? "succeeded" : null;
}
