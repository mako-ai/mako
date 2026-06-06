import { Types } from "mongoose";
import {
  DatabaseConnection,
  type IDatabaseConnection,
} from "../../database/workspace-schema";
import type { ReverseFlowSpec } from "../../schemas/reverse-flow.schema";
import { assertSchema, mapRow } from "./mapping-engine";
import { readReverseEtlSourcePage } from "./source-reader";
import { getOutboundConnector } from "./outbound";

export interface ReverseEtlDryRunRow {
  sourceRow: Record<string, unknown>;
  payload: Record<string, unknown>;
  match?: {
    status: string;
    remoteId?: string;
    matchCount?: number;
  };
  fieldDiffs?: {
    field: string;
    before: unknown;
    after: unknown;
    willOverwrite: boolean;
  }[];
  outcome: {
    status: string;
    error?: string;
    retryable?: boolean;
  };
}

export interface ReverseEtlDryRunResult {
  rows: ReverseEtlDryRunRow[];
  summary: {
    sampleSize: number;
    accepted: number;
    rejected: number;
    ambiguous: number;
    rejectedFields: { field: string; reason: string }[];
    passed: boolean;
  };
}

export async function dryRunReverseEtl(
  workspaceId: string,
  spec: ReverseFlowSpec,
  sampleSize = 25,
): Promise<ReverseEtlDryRunResult> {
  const connectionDoc = await DatabaseConnection.findOne({
    _id: new Types.ObjectId(spec.source.connectionId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!connectionDoc) {
    throw new Error("Source database connection not found");
  }

  const outbound = await getOutboundConnector(spec.destination.connectorId);
  const outboundSchema = await outbound.resolveOutboundSchema(
    spec.destination.entity,
  );
  const connection = connectionDoc.toObject({
    getters: true,
  }) as IDatabaseConnection;
  const page = await readReverseEtlSourcePage({
    connection,
    spec: {
      ...spec,
      safety: {
        ...spec.safety,
        batchSize: Math.min(sampleSize, spec.safety.batchSize),
        maxRowsPerRun: Math.min(sampleSize, spec.safety.maxRowsPerRun),
      },
    },
  });

  assertSchema(spec, page.columns, outboundSchema);

  const mapped = page.rows.map(row => ({
    row,
    mapped: mapRow(spec, row),
  }));
  const validRecords = mapped
    .filter(item => item.mapped.errors.length === 0)
    .map(item => ({
      sourcePk: String(item.row[spec.source.primaryKey] ?? ""),
      payload: item.mapped.payload,
    }))
    .filter(record => record.sourcePk);

  const writeResults =
    validRecords.length > 0
      ? (
          await outbound.writeBatch({
            entity: spec.destination.entity,
            records: validRecords,
            writeMode: spec.destination.allowCreate
              ? spec.destination.writeMode
              : "update",
            updateFieldStrategy: spec.destination.updateFieldStrategy,
            match: spec.destination.match,
            dryRun: true,
          })
        ).results
      : [];
  const resultsByPk = new Map(
    writeResults.map(result => [result.sourcePk, result]),
  );
  const rejectedFields: { field: string; reason: string }[] = [];

  const rows = mapped.map(({ row, mapped: mappedRow }) => {
    const sourcePk = String(row[spec.source.primaryKey] ?? "");
    const result = sourcePk ? resultsByPk.get(sourcePk) : undefined;
    for (const error of mappedRow.errors) {
      rejectedFields.push({ field: sourcePk || "row", reason: error });
    }
    for (const rejected of result?.rejectedFields || []) {
      rejectedFields.push({ field: rejected.field, reason: rejected.reason });
    }
    return {
      sourceRow: row,
      payload: mappedRow.payload,
      match: result
        ? {
            status: result.status,
            remoteId: result.remoteId,
            matchCount: result.matchCount,
          }
        : undefined,
      fieldDiffs: result?.fieldDiffs,
      outcome: {
        status:
          mappedRow.errors.length > 0 ? "failed" : result?.status || "skipped",
        error: mappedRow.errors[0] || result?.error,
        retryable: result?.retryable,
      },
    };
  });

  const accepted = rows.filter(row =>
    ["created", "updated", "skipped"].includes(row.outcome.status),
  ).length;
  const ambiguous = rows.filter(
    row => row.outcome.status === "ambiguous",
  ).length;
  const rejected = rows.length - accepted - ambiguous;

  return {
    rows,
    summary: {
      sampleSize: rows.length,
      accepted,
      rejected,
      ambiguous,
      rejectedFields,
      passed: rejected === 0 && ambiguous === 0,
    },
  };
}
