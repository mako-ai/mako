/**
 * Data-diff check: catch a write that silently empties columns.
 *
 * Before a flow write that can rewrite existing rows, the runtime counts the
 * non-null values of every column of each destination table (one query per
 * table). After the run, it counts again and flags each column whose non-null
 * count fell by more than DATA_DIFF_MIN_LOST rows and DATA_DIFF_MIN_RATIO of
 * its baseline. A table over 1 GB is measured on a 10% block sample and
 * judged on column shares (see DATA_DIFF_SAMPLE_OVER_BYTES). A table that shrank (a purge, a hard delete) scales each
 * column's baseline down by the same ratio, so a column is flagged only for
 * values lost beyond the rows that went.
 *
 * What opens a check, for every connector and destination alike:
 *   - a backfill or scheduled resync run (the run start);
 *   - an entity reset or a resync that drops tables (before the drop);
 *   - a run whose source connection, connector code (built-in directory hash,
 *     or a workspace connector's build/registry hash and runtime) or
 *     destination tables differ from the last run's (`dataDiffFingerprint`).
 * The next successful run compares. The baseline is stored (rows and
 * per-column counts), not time-travelled, because a reset drops the table and
 * a destination change reads another one.
 *
 * Flags log at warn under `api.flow-data-diff` and land in
 * `flow_data_diffs`, read by flow_status and flow_data_diff.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Types } from "mongoose";

import {
  ConnectorDefinition,
  DatabaseConnection,
  Flow,
  FlowDataDiff,
  SourceConnection,
  type FlowDataDiffReason,
  type IFlow,
  type IFlowDataDiffCounts,
  type IFlowDataDiffFlag,
  type IFlowDataDiffTable,
} from "../database/workspace-schema";
import { databaseRegistry } from "../databases/registry";
import { escapeSqlLiteral } from "../databases/sql-utils";
import { loggers } from "../logging";
import { withQueryLabels } from "../services/bigquery-labels";
import { inWorkspace } from "../utils/workspace-scope";
import { cdcLiveTableName } from "./normalization";

const log = loggers.api("flow-data-diff");

/** A column is flagged when it lost more than this many values… */
export const DATA_DIFF_MIN_LOST = 10;
/** …and more than this share of its baseline (0.5%). */
export const DATA_DIFF_MIN_RATIO = 0.005;
/**
 * A table over this size is measured on a 10% block sample: its exact row
 * count from metadata, each column's non-null share from the sample, scaled
 * to the rows. Block samples follow write order, so a column's share moves a
 * lot between two samples: up to 72% on `call_activities` for columns over
 * 1% full. A sampled column is flagged only when it lost more than
 * DATA_DIFF_SAMPLED_MIN_RATIO of its share, which still catches a column a
 * rewrite emptied.
 */
export const DATA_DIFF_SAMPLE_OVER_BYTES = 1e9;
export const DATA_DIFF_SAMPLE_PERCENT = 10;
export const DATA_DIFF_SAMPLED_MIN_RATIO = 0.75;
/** An open baseline older than this is stale: a fresh one replaces it. */
const OPEN_BASELINE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** Tables counted at once on one destination. */
const COUNT_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Comparison (pure)
// ---------------------------------------------------------------------------

export function compareCounts(params: {
  entity: string;
  table: string;
  before: IFlowDataDiffCounts;
  after: IFlowDataDiffCounts;
}): IFlowDataDiffFlag[] {
  const { entity, table, before, after } = params;
  const flags: IFlowDataDiffFlag[] = [];
  const sampled = Boolean(before.sampled || after.sampled);
  const flag = (
    column: string,
    was: number,
    now: number,
    expected: number,
    minRatio = DATA_DIFF_MIN_RATIO,
  ) => {
    const lost = expected - now;
    if (
      lost > DATA_DIFF_MIN_LOST &&
      expected > 0 &&
      lost / expected > minRatio
    ) {
      flags.push({
        entity,
        table,
        column,
        before: was,
        after: now,
        expected,
        lost,
        lostPct: Math.round((lost / expected) * 10_000) / 100,
      });
    }
  };

  flag("(rows)", before.rows, after.rows, before.rows);
  // Exact counts scale the baseline down when the table shrank. Sampled
  // counts compare ratios: the baseline scales to the new row count either
  // way, so a column is judged on its share of the rows.
  const scale =
    before.rows <= 0
      ? 1
      : sampled || after.rows < before.rows
        ? after.rows / before.rows
        : 1;
  const afterByName = new Map(after.columns.map(c => [c.name, c.nonNull]));
  for (const column of before.columns) {
    flag(
      column.name,
      column.nonNull,
      afterByName.get(column.name) ?? 0,
      Math.round(column.nonNull * scale),
      sampled ? DATA_DIFF_SAMPLED_MIN_RATIO : DATA_DIFF_MIN_RATIO,
    );
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/** One table's counts, or why it has none. */
export interface CountedTable {
  entity: string;
  table: string;
  counts?: IFlowDataDiffCounts;
  error?: string;
}

const EMPTY: IFlowDataDiffCounts = { rows: 0, columns: [] };

export interface DataDiffDestination {
  connectionId: string;
  schema: string;
  tablePrefix: string;
}

const destinationKey = (d: DataDiffDestination) =>
  `${d.connectionId}|${d.schema}|${d.tablePrefix}`;

function parseDestinationKey(key: string): DataDiffDestination | null {
  const [connectionId, schema, tablePrefix] = key.split("|");
  if (!connectionId || !schema) return null;
  return { connectionId, schema, tablePrefix: tablePrefix ?? "" };
}

function destinationOf(
  flow: Pick<IFlow, "tableDestination">,
): DataDiffDestination | null {
  const td = flow.tableDestination;
  if (!td?.connectionId || !td.schema) return null;
  return {
    connectionId: String(td.connectionId),
    schema: td.schema,
    tablePrefix: td.tableName || "",
  };
}

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** The SELECT that counts rows and each column's non-null values. */
export function buildNonNullCountQuery(params: {
  tableRef: string;
  columns: string[];
  quote: (name: string) => string;
}): string {
  const counts = params.columns.map(
    (name, i) => `COUNT(${params.quote(name)}) AS c_${i}`,
  );
  return `SELECT ${["COUNT(*) AS n", ...counts].join(", ")} FROM ${params.tableRef}`;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/**
 * Per-column non-null counts of each entity's live table on `destination`.
 * One column-list query, then one count query per table. A table that does
 * not exist counts as empty; any other failure is the table's `error`.
 */
export async function countEntityTables(params: {
  workspaceId: string;
  flowId: string;
  destination: DataDiffDestination;
  entities: string[];
}): Promise<CountedTable[]> {
  const { workspaceId, flowId, destination, entities } = params;
  const tables = entities.map(entity => ({
    entity,
    table: cdcLiveTableName(destination.tablePrefix, entity),
  }));
  const failAll = (error: string): CountedTable[] =>
    tables.map(t => ({ ...t, error }));

  const connection = await DatabaseConnection.findOne(
    inWorkspace(destination.connectionId, workspaceId),
  );
  if (!connection) return failAll("destination connection not found");
  const driver = databaseRegistry.getDriver(connection.type);
  if (!driver?.executeQuery || connection.type === "mongodb") {
    return failAll(`no SQL count on a ${connection.type} destination`);
  }
  const projectId = (connection as { connection?: { project_id?: string } })
    .connection?.project_id;
  const quote =
    driver.quoteIdentifier?.bind(driver) ??
    ((name: string) => `\`${name.replace(/`/g, "``")}\``);
  const tableRef = (table: string) =>
    driver.formatTableRef
      ? driver.formatTableRef(destination.schema, table, { projectId })
      : `"${destination.schema}"."${table}"`;
  const run = (sql: string) =>
    withQueryLabels(
      { mako_source: "flow", mako_flow: flowId, mako_purpose: "data_diff" },
      () => driver.executeQuery(connection, sql),
    );

  const names = tables.map(t => t.table);
  const listSql =
    driver.buildColumnListQuery?.(destination.schema, names, { projectId }) ??
    `SELECT table_name AS table_name, column_name AS column_name FROM information_schema.columns WHERE table_schema = ${escapeSqlLiteral(destination.schema)} AND table_name IN (${names.map(escapeSqlLiteral).join(",")})`;
  const listed = await run(listSql);
  if (!listed.success) return failAll(listed.error || "column list failed");
  const columnsByTable = new Map<string, string[]>();
  for (const row of (listed.data ?? []) as Record<string, unknown>[]) {
    const table = String(row.table_name ?? row.TABLE_NAME ?? "");
    const column = String(row.column_name ?? row.COLUMN_NAME ?? "");
    if (!table || !column) continue;
    const list = columnsByTable.get(table) ?? [];
    list.push(column);
    columnsByTable.set(table, list);
  }

  // Tables over 1 GB: exact rows from metadata, column shares from a sample.
  const largeRows = new Map<string, number>();
  const statsSql = driver.tableSampleClause
    ? driver.buildTableStatsQuery?.(destination.schema, names, { projectId })
    : undefined;
  if (statsSql) {
    const stats = await run(statsSql);
    const rows = (stats.success ? (stats.data ?? []) : []) as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      if (num(row.size_bytes) > DATA_DIFF_SAMPLE_OVER_BYTES) {
        largeRows.set(String(row.table_name), num(row.row_count));
      }
    }
  }

  return mapLimit(
    tables,
    COUNT_CONCURRENCY,
    async (t): Promise<CountedTable> => {
      const columns = columnsByTable.get(t.table);
      if (!columns?.length) {
        return { ...t, counts: EMPTY };
      }
      const exactRows = largeRows.get(t.table);
      const sample =
        exactRows !== undefined
          ? driver.tableSampleClause?.(DATA_DIFF_SAMPLE_PERCENT)
          : undefined;
      const result = await run(
        buildNonNullCountQuery({
          tableRef: sample
            ? `${tableRef(t.table)} ${sample}`
            : tableRef(t.table),
          columns,
          quote,
        }),
      );
      if (!result.success) {
        return { ...t, error: result.error || "count failed" };
      }
      const row = ((result.data ?? [])[0] ?? {}) as Record<string, unknown>;
      const counted = num(row.n);
      const rows = sample ? (exactRows ?? 0) : counted;
      const nonNull = (value: number) =>
        !sample
          ? value
          : counted > 0
            ? Math.round((value / counted) * rows)
            : 0;
      return {
        ...t,
        counts: {
          rows,
          ...(sample ? { sampled: true } : {}),
          columns: columns.map((name, i) => ({
            name,
            nonNull: nonNull(num(row[`c_${i}`])),
          })),
        },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Fingerprint: what a run writes with
// ---------------------------------------------------------------------------

const builtInCodeHashes = new Map<string, string>();

/** sha256 of a built-in connector's directory (tests excluded), cached. */
async function builtInCodeHash(type: string): Promise<string> {
  const cached = builtInCodeHashes.get(type);
  if (cached) return cached;
  const root = path.resolve(__dirname, "../connectors", type);
  const hash = createHash("sha256");
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (!/\.test\.|\.map$|\.d\.ts$/.test(entry.name)) {
        hash.update(path.relative(root, full));
        hash.update(await fs.readFile(full));
      }
    }
  };
  try {
    await walk(root);
  } catch {
    return "";
  }
  const digest = hash.digest("hex").slice(0, 16);
  builtInCodeHashes.set(type, digest);
  return digest;
}

async function connectorCodeHash(
  workspaceId: string,
  type: string,
): Promise<string> {
  if (!type.startsWith("ws:")) return `${type}@${await builtInCodeHash(type)}`;
  const row = await ConnectorDefinition.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
    slug: type.slice(3),
  })
    .select("runtime sourceSha build.hash registry.hash")
    .lean();
  if (!row) return type;
  const code = row.registry?.hash ?? row.build?.hash ?? row.sourceSha;
  return `${type}@${row.runtime}:${code}`;
}

export async function flowFingerprint(flow: IFlow): Promise<{
  source: string;
  code: string;
  destination: string;
}> {
  const workspaceId = String(flow.workspaceId);
  let type = "";
  if (flow.dataSourceId) {
    const source = await SourceConnection.findOne({
      _id: flow.dataSourceId,
      workspaceId: flow.workspaceId,
    })
      .select("type")
      .lean();
    type = source?.type ?? "";
  }
  const destination = destinationOf(flow);
  return {
    source: `${type}:${flow.dataSourceId ?? ""}`,
    code: type ? await connectorCodeHash(workspaceId, type) : "",
    destination: destination ? destinationKey(destination) : "",
  };
}

// ---------------------------------------------------------------------------
// Open (baseline) and compare
// ---------------------------------------------------------------------------

async function openCheck(flowId: Types.ObjectId) {
  const open = await FlowDataDiff.findOne({ flowId, status: "open" });
  if (
    open &&
    Date.now() - open.baselineAt.getTime() > OPEN_BASELINE_MAX_AGE_MS
  ) {
    open.status = "expired";
    await open.save();
    return null;
  }
  return open;
}

/**
 * Record a baseline for `entities` (those not already in the flow's open
 * check) and add `reasons` to it. Called before a drop (reset, resync) and
 * at a run's start. Never throws: a failed baseline only means no check.
 */
export async function openFlowDataDiff(params: {
  flow: Pick<IFlow, "_id" | "workspaceId" | "tableDestination">;
  entities: string[];
  reasons: FlowDataDiffReason[];
  /** Read the baseline here instead of the flow's current destination. */
  from?: DataDiffDestination | null;
}): Promise<void> {
  const { flow, entities, reasons } = params;
  try {
    const source = params.from ?? destinationOf(flow);
    if (!source || entities.length === 0 || reasons.length === 0) return;
    const open = await openCheck(flow._id);
    const have = new Set((open?.tables ?? []).map(t => t.entity));
    const missing = entities.filter(e => !have.has(e));
    const counted = missing.length
      ? await countEntityTables({
          workspaceId: String(flow.workspaceId),
          flowId: String(flow._id),
          destination: source,
          entities: missing,
        })
      : [];
    const tables: IFlowDataDiffTable[] = counted.map(({ counts, ...t }) => ({
      ...t,
      ...(counts ? { before: counts } : {}),
    }));
    if (open) {
      await FlowDataDiff.updateOne(
        { _id: open._id },
        {
          $addToSet: { reasons: { $each: reasons } },
          $push: { tables: { $each: tables } },
        },
      );
    } else {
      await FlowDataDiff.create({
        workspaceId: flow.workspaceId,
        flowId: flow._id,
        status: "open",
        reasons,
        baselineAt: new Date(),
        ...(params.from ? { from: destinationKey(params.from) } : {}),
        tables,
        flagged: [],
      });
    }
    log.info("Data-diff baseline recorded", {
      flowId: String(flow._id),
      reasons,
      tables: tables.length,
    });
  } catch (error) {
    log.warn("Data-diff baseline failed", {
      flowId: String(flow._id),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * A run's start: open a check when the run is a backfill, or when what the
 * flow writes with changed since the last run. Saves the new fingerprint.
 */
export async function prepareFlowDataDiff(params: {
  flowId: string;
  entities: string[];
  backfill: boolean;
}): Promise<{ reasons: FlowDataDiffReason[] }> {
  try {
    return await prepare(params);
  } catch (error) {
    log.warn("Data-diff preparation failed", {
      flowId: params.flowId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { reasons: [] };
  }
}

async function prepare(params: {
  flowId: string;
  entities: string[];
  backfill: boolean;
}): Promise<{ reasons: FlowDataDiffReason[] }> {
  const flow = await Flow.findById(params.flowId);
  if (!flow) return { reasons: [] };
  const current = await flowFingerprint(flow);
  const previous = flow.dataDiffFingerprint;
  const reasons: FlowDataDiffReason[] = [];
  if (params.backfill) {
    reasons.push(
      flow.backfillState?.trigger === "scheduled"
        ? "scheduled-resync"
        : "backfill",
    );
  }
  let from: DataDiffDestination | null = null;
  if (previous?.source || previous?.destination) {
    if (previous.source !== current.source) reasons.push("connector-change");
    else if (previous.code !== current.code) {
      reasons.push("connector-code-change");
    }
    if (previous.destination && previous.destination !== current.destination) {
      reasons.push("destination-change");
      from = parseDestinationKey(previous.destination);
    }
  }
  if (reasons.length > 0) {
    await openFlowDataDiff({ flow, entities: params.entities, reasons, from });
  }
  if (
    previous?.source !== current.source ||
    previous?.code !== current.code ||
    previous?.destination !== current.destination
  ) {
    await Flow.updateOne(
      { _id: flow._id },
      { $set: { dataDiffFingerprint: current } },
    );
  }
  return { reasons };
}

/**
 * A successful run's end: count the open check's tables again, flag the
 * columns that lost values, close it. Returns the flags, or null when no
 * check was open. Never throws.
 */
export async function compareFlowDataDiff(params: {
  flowId: string;
  executionId?: string;
}): Promise<{ flagged: IFlowDataDiffFlag[]; reasons: string[] } | null> {
  try {
    const flow = await Flow.findById(params.flowId);
    if (!flow) return null;
    const open = await openCheck(flow._id);
    if (!open) return null;
    const destination = destinationOf(flow);
    const withBaseline = open.tables.filter(t => t.before);
    const counted = destination
      ? await countEntityTables({
          workspaceId: String(flow.workspaceId),
          flowId: String(flow._id),
          destination,
          entities: withBaseline.map(t => t.entity),
        })
      : [];
    const afterByEntity = new Map(counted.map(c => [c.entity, c]));
    const flagged: IFlowDataDiffFlag[] = [];
    const tables = open.tables.map(t => {
      const plain = {
        entity: t.entity,
        table: t.table,
        ...(t.before ? { before: t.before } : {}),
        ...(t.error ? { error: t.error } : {}),
      };
      const now = afterByEntity.get(t.entity);
      if (!t.before || !now) return plain;
      if (now.error || !now.counts) {
        return { ...plain, error: now.error ?? "not counted" };
      }
      flagged.push(
        ...compareCounts({
          entity: t.entity,
          table: now.table,
          before: t.before,
          after: now.counts,
        }),
      );
      return { ...plain, after: now.counts };
    });
    await FlowDataDiff.updateOne(
      { _id: open._id },
      {
        $set: {
          status: "compared",
          comparedAt: new Date(),
          executionId: params.executionId,
          tables,
          flagged,
        },
      },
    );
    const summary = {
      flowId: String(flow._id),
      workspaceId: String(flow.workspaceId),
      flow: flow.name ?? flow.slug,
      reasons: open.reasons,
      tables: tables.length,
    };
    if (flagged.length > 0) {
      log.warn("Flow data diff: columns lost non-null values", {
        ...summary,
        flaggedCount: flagged.length,
        flagged: flagged.slice(0, 25).map(f => ({
          table: f.table,
          column: f.column,
          before: f.before,
          after: f.after,
          lostPct: f.lostPct,
        })),
      });
    } else {
      log.info("Flow data diff: no column lost values", summary);
    }
    return { flagged, reasons: open.reasons };
  } catch (error) {
    log.warn("Data-diff comparison failed", {
      flowId: params.flowId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** The flow's latest checks, newest first, for flow_status / flow_data_diff. */
export async function listFlowDataDiffs(flowId: Types.ObjectId, limit: number) {
  return FlowDataDiff.find({ flowId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .lean();
}
