/**
 * Parity between a live flow and its boxed shadow, and the switch gate built
 * on it (RFC connector-runtime §10, iteration 5).
 *
 * The gate is evidence, same day:
 * 1. the shadow's full-history backfill has completed;
 * 2. one check compares every row of every entity: keys on both sides, and
 *    a field checksum per row, with the differing fields and samples;
 * 3. the same check covers 2 h of live updates since that backfill: live
 *    changes the shadow also has, and how much later it wrote them.
 * A clean check under 90 minutes old opens the gate. Shadow on to switched
 * is then backfill time plus 2 h plus one check.
 *
 * Checks run hourly for every active shadow (connector-parity.ts) and on
 * demand (`flow_shadow` with `action: "check"`). Queries are SELECTs on the
 * destination, labelled with the flow; they never write.
 */
import { Types } from "mongoose";
import {
  CdcEntityState,
  DatabaseConnection,
  WebhookEvent,
  Flow,
  FlowExecution,
  FlowParityCheck,
  type IDatabaseConnection,
  type IFlow,
  type IFlowParityCheck,
  type IFlowParityEntity,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { withQueryLabels } from "../../services/bigquery-labels";
import { databaseConnectionService } from "../../services/database-connection.service";
import { cdcLiveTableName } from "../../sync-cdc/normalization";
import { hasWebhookTrigger } from "../../services/flow-triggers.service";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import { PARITY_GATE } from "./config";
import {
  bqTable,
  buildColumnsSql,
  buildSamplesSql,
  buildSummarySql,
  comparableColumns,
  readSummaryRow,
  type ParityTables,
} from "./parity-sql";

const logger = loggers.connector();

/** Runs one SELECT on the destination; tests replace it. */
export type ParityQuery = (
  destination: IDatabaseConnection,
  sql: string,
  location: string | undefined,
) => Promise<Array<Record<string, unknown>>>;

export interface ParityDeps {
  query: ParityQuery;
  /** The entity's key columns, from the live flow's built-in connector. */
  keyColumns: (live: IFlow, entity: string) => Promise<string[]>;
  now: () => Date;
}

const defaultQuery: ParityQuery = async (destination, sql, location) => {
  const result = await databaseConnectionService.executeQuery(
    destination,
    sql,
    { location, bigQueryJobMaxWaitMs: 10 * 60 * 1000 },
  );
  if (!result.success) throw new Error(result.error || "query failed");
  return Array.isArray(result.data) ? result.data : [];
};

const defaultKeyColumns = async (live: IFlow, entity: string) => {
  try {
    const source = await sourceConnectionManager.getSourceConnection(
      String(live.dataSourceId),
      String(live.workspaceId),
    );
    const connector = source
      ? await syncConnectorRegistry.getConnectorFor(source)
      : null;
    const schema = connector ? await connector.resolveSchema(entity) : null;
    if (schema?.keyColumns?.length) return schema.keyColumns;
  } catch (error) {
    logger.warn("Parity: key columns fell back to id", {
      entity,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return ["id"];
};

export const defaultParityDeps: ParityDeps = {
  query: defaultQuery,
  keyColumns: defaultKeyColumns,
  now: () => new Date(),
};

const MINUTE = 60_000;

/**
 * Names that reach parity SQL. They come from flow files and from the
 * warehouse, so each is checked before any SQL is built, on top of the
 * quoting (escId).
 */
export const SAFE_NAME = /^[A-Za-z0-9_]+$/;
/** A GCP project id, optionally domain-scoped (`example.com:proj`). */
export const SAFE_PROJECT = /^[A-Za-z0-9.:-]+$/;

export function assertSafeName(kind: string, name: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(
      `The ${kind} name ${JSON.stringify(name.slice(0, 80))} is not plain letters, digits and underscores; parity does not query it`,
    );
  }
}

/** When the shadow's full-history backfill completed, or null. */
export async function shadowBackfillCompletedAt(
  shadow: Pick<IFlow, "_id" | "backfillState">,
): Promise<Date | null> {
  if (
    shadow.backfillState?.status === "completed" &&
    shadow.backfillState.completedAt
  ) {
    return new Date(shadow.backfillState.completedAt);
  }
  return null;
}

/** Start of the side's last successful run, or null. */
async function lastSuccessfulStart(flowId: Types.ObjectId) {
  const run = (await FlowExecution.findOne({ flowId, success: true })
    .sort({ startedAt: -1 })
    .select("startedAt")
    .lean()) as { startedAt?: Date } | null;
  return run?.startedAt ? new Date(run.startedAt) : null;
}

/**
 * Rows either side changed at or after this are not compared: the shadow
 * (and a polled live flow) may not have read them yet. The later of the two
 * flows' last successful run starts bounds what both have seen; a live flow
 * on webhooks is current to within the margin.
 */
export function parityCutoff(input: {
  now: Date;
  shadowLastStart: Date | null;
  liveLastStart: Date | null;
  liveOnWebhooks: boolean;
}): Date {
  const margin = PARITY_GATE.cutoffMarginMinutes * MINUTE;
  const bounds = [input.now.getTime()];
  if (input.shadowLastStart) bounds.push(input.shadowLastStart.getTime());
  if (!input.liveOnWebhooks && input.liveLastStart) {
    bounds.push(input.liveLastStart.getTime());
  }
  return new Date(Math.min(...bounds) - margin);
}

/** The live-update window: the 2 h before the cutoff, after the backfill. */
export function parityWindow(cutoff: Date, backfillCompletedAt: Date | null) {
  const earliest = cutoff.getTime() - PARITY_GATE.windowMinutes * MINUTE;
  const start = new Date(
    Math.max(earliest, backfillCompletedAt?.getTime() ?? cutoff.getTime()),
  );
  const startClamped = start > cutoff ? cutoff : start;
  return {
    start: startClamped,
    end: cutoff,
    coverageMinutes: Math.floor(
      (cutoff.getTime() - startClamped.getTime()) / MINUTE,
    ),
  };
}

/**
 * Why one entity blocks the gate (`reasons`), and what it found that does
 * not block (`notes`). The gate (config.ts PARITY_GATE): 0 key gaps on the
 * compared keys, every live column in the shadow, 0 new NULL rows, and in
 * the window every live update matched within the lag bound.
 */
export function entityVerdict(
  e: Omit<IFlowParityEntity, "clean" | "reasons" | "notes">,
): { reasons: string[]; notes: string[] } {
  if (e.error) return { reasons: [`${e.entity}: ${e.error}`], notes: [] };
  const reasons: string[] = [];
  const notes: string[] = [];
  const gaps = e.liveOnly + e.shadowOnly;
  if (gaps > 0) {
    reasons.push(
      `${e.entity}: ${gaps} of ${e.compared} keys are on one side only (${e.liveOnly} live only, ${e.shadowOnly} shadow only)`,
    );
  }
  if (e.liveOnlyColumns.length > 0) {
    reasons.push(
      `${e.entity}: the shadow lacks ${e.liveOnlyColumns.length} live column${e.liveOnlyColumns.length === 1 ? "" : "s"}: ${e.liveOnlyColumns.join(", ")}`,
    );
  }
  if ((e.newNullRows ?? 0) > 0) {
    reasons.push(
      `${e.entity}: ${e.newNullRows} rows have a value on live and NULL on the shadow (${(
        e.newNullFields ?? []
      )
        .slice(0, 5)
        .map(f => `${f.field} ${f.rows}`)
        .join(", ")})`,
    );
  }
  if (e.window.missingOrBehind > 0) {
    reasons.push(
      `${e.entity}: ${e.window.missingOrBehind} of ${e.window.liveRows} live updates in the last ${PARITY_GATE.windowMinutes} min are missing or older in the shadow`,
    );
  }
  if (
    e.window.lagP95Seconds !== null &&
    e.window.lagP95Seconds > PARITY_GATE.maxLagP95Seconds
  ) {
    reasons.push(
      `${e.entity}: shadow lag p95 is ${e.window.lagP95Seconds} s, over ${PARITY_GATE.maxLagP95Seconds} s`,
    );
  }
  if (e.rowsDiffering > 0) {
    notes.push(
      `${e.entity}: ${e.rowsDiffering} rows differ in field values (see topFields)`,
    );
  }
  if (e.shadowOnlyColumns.length > 0) {
    notes.push(
      `${e.entity}: the shadow adds ${e.shadowOnlyColumns.length} column${e.shadowOnlyColumns.length === 1 ? "" : "s"}: ${e.shadowOnlyColumns.join(", ")}`,
    );
  }
  return { reasons, notes };
}

/** Why one entity blocks the gate; empty when it does not. */
export function entityReasons(
  e: Omit<IFlowParityEntity, "clean" | "reasons" | "notes">,
): string[] {
  return entityVerdict(e).reasons;
}

/**
 * The shadow's failures since `since`: failed runs, entities whose last
 * failure is in the window, and failed box-lane webhook events.
 */
export async function shadowErrorsSince(shadowId: Types.ObjectId, since: Date) {
  const ids = { $in: [shadowId, String(shadowId)] };
  const [failedRuns, entities, failedWebhookEvents] = await Promise.all([
    FlowExecution.countDocuments({
      flowId: shadowId,
      status: "failed",
      startedAt: { $gte: since },
    }),
    CdcEntityState.find({ flowId: ids, lastFailedAt: { $gte: since } })
      .select("entity")
      .lean(),
    WebhookEvent.countDocuments({
      flowId: shadowId,
      lane: "box",
      status: "failed",
      receivedAt: { $gte: since },
    }),
  ]);
  return {
    failedRuns,
    failedEntities: (entities as Array<{ entity: string }>)
      .map(e => String(e.entity))
      .sort(),
    failedWebhookEvents,
  };
}

/** The entities both flows have synced, sorted. */
async function parityEntities(
  live: IFlow,
  shadow: IFlow,
): Promise<{ both: string[]; liveOnly: string[] }> {
  const ids = (f: IFlow) => ({ $in: [f._id, String(f._id)] });
  const [liveStates, shadowStates] = await Promise.all([
    CdcEntityState.distinct("entity", { flowId: ids(live) }),
    CdcEntityState.distinct("entity", { flowId: ids(shadow) }),
  ]);
  const onLive = new Set((liveStates as string[]).map(String));
  const onShadow = new Set((shadowStates as string[]).map(String));
  return {
    both: [...onShadow].filter(entity => onLive.has(entity)).sort(),
    // An entity the live flow syncs and the shadow never did: after a
    // switch it would stop updating, so it keeps the gate closed.
    liveOnly: [...onLive].filter(entity => !onShadow.has(entity)).sort(),
  };
}

function bigQueryTarget(destination: IDatabaseConnection) {
  const conn =
    (destination as { connection?: Record<string, unknown> }).connection ?? {};
  return {
    project: String(conn.project_id ?? ""),
    location: typeof conn.location === "string" ? conn.location : undefined,
  };
}

/**
 * Run one check of a shadow against its live flow and store it. Never
 * throws for a data problem: errors are recorded on the check.
 */
export async function runParityCheck(input: {
  shadowFlowId: string;
  trigger: "scheduled" | "manual";
  deps?: Partial<ParityDeps>;
}): Promise<IFlowParityCheck> {
  const deps = { ...defaultParityDeps, ...input.deps };
  const shadow = (await Flow.findById(
    input.shadowFlowId,
  ).lean()) as IFlow | null;
  if (!shadow?.shadowOf) {
    throw new Error(`Flow ${input.shadowFlowId} is not a shadow`);
  }
  const live = (await Flow.findOne({
    _id: shadow.shadowOf,
    workspaceId: shadow.workspaceId,
  }).lean()) as IFlow | null;
  if (!live) throw new Error("The shadow's live flow no longer exists");

  const startedAt = deps.now();
  const check = await FlowParityCheck.create({
    workspaceId: shadow.workspaceId,
    flowId: live._id,
    shadowFlowId: shadow._id,
    trigger: input.trigger,
    status: "running",
    startedAt,
    entities: [],
    clean: false,
    reasons: [],
  });

  const finish = async (
    patch: Partial<IFlowParityCheck>,
  ): Promise<IFlowParityCheck> => {
    const done = {
      ...patch,
      finishedAt: deps.now(),
    };
    await FlowParityCheck.updateOne({ _id: check._id }, { $set: done });
    return (await FlowParityCheck.findById(
      check._id,
    ).lean()) as IFlowParityCheck;
  };

  try {
    // Hydrated, as the CDC adapter reads it: the credential decrypts on read.
    const destination = (await DatabaseConnection.findOne({
      _id: shadow.destinationDatabaseId,
      workspaceId: shadow.workspaceId,
    })) as IDatabaseConnection | null;
    if (!destination) throw new Error("Destination connection not found");
    if (String(destination.type).toLowerCase() !== "bigquery") {
      throw new Error(
        `Parity runs on BigQuery destinations; this one is ${destination.type}`,
      );
    }
    const { project, location } = bigQueryTarget(destination);
    const liveDataset = live.tableDestination?.schema;
    const shadowDataset = shadow.tableDestination?.schema;
    if (!project || !liveDataset || !shadowDataset) {
      throw new Error("The destination project or a dataset is not set");
    }
    if (liveDataset === shadowDataset) {
      throw new Error("The shadow and live flows write the same dataset");
    }
    if (!SAFE_PROJECT.test(project)) {
      throw new Error("The destination project id is not a plain project id");
    }
    assertSafeName("dataset", liveDataset);
    assertSafeName("dataset", shadowDataset);

    const backfillCompletedAt = await shadowBackfillCompletedAt(shadow);
    const cutoff = parityCutoff({
      now: startedAt,
      shadowLastStart: await lastSuccessfulStart(shadow._id),
      liveLastStart: await lastSuccessfulStart(live._id),
      liveOnWebhooks: hasWebhookTrigger(live),
    });
    const window = parityWindow(cutoff, backfillCompletedAt);

    const { both: entities, liveOnly: missingEntities } = await parityEntities(
      live,
      shadow,
    );
    const reasons: string[] = [];
    if (missingEntities.length > 0) {
      reasons.push(
        `The shadow has not synced ${missingEntities.length} entit${missingEntities.length === 1 ? "y" : "ies"} the live flow syncs: ${missingEntities.join(", ")}`,
      );
    }
    if (!backfillCompletedAt) {
      reasons.push("The shadow's full backfill has not completed");
    }
    if (entities.length === 0) {
      reasons.push("No entity has been synced by both flows yet");
    }

    const tableOf = (flow: IFlow, entity: string) =>
      cdcLiveTableName(
        flow.tableDestination?.tableName,
        entity,
        String(flow._id),
      );

    const columnsOf = async (dataset: string, tables: string[]) => {
      const out = new Map<string, string[]>();
      // An unsafe table name is refused per entity below, never queried.
      tables = tables.filter(table => SAFE_NAME.test(table));
      if (tables.length === 0) return out;
      const rows = await deps.query(
        destination,
        buildColumnsSql(project, dataset, tables),
        location,
      );
      for (const row of rows) {
        const table = String(row.table_name);
        out.set(table, [...(out.get(table) ?? []), String(row.column_name)]);
      }
      return out;
    };
    const labels = {
      mako_source: "parity",
      mako_flow: String(live._id),
      mako_dataset: shadowDataset,
    };
    const [liveColumns, shadowColumns] = await withQueryLabels(labels, () =>
      Promise.all([
        columnsOf(
          liveDataset,
          entities.map(e => tableOf(live, e)),
        ),
        columnsOf(
          shadowDataset,
          entities.map(e => tableOf(shadow, e)),
        ),
      ]),
    );

    const results: IFlowParityEntity[] = [];
    for (const entity of entities) {
      const liveTable = tableOf(live, entity);
      const shadowTable = tableOf(shadow, entity);
      const base = {
        entity,
        table: shadowTable,
        keyColumns: [] as string[],
        liveRows: 0,
        shadowRows: 0,
        recent: 0,
        compared: 0,
        bothKeys: 0,
        liveOnly: 0,
        shadowOnly: 0,
        rowsDiffering: 0,
        liveChecksum: null,
        shadowChecksum: null,
        liveOnlyColumns: [] as string[],
        shadowOnlyColumns: [] as string[],
        topFields: [] as IFlowParityEntity["topFields"],
        newNullRows: 0,
        newNullFields: [] as IFlowParityEntity["newNullFields"],
        window: {
          liveRows: 0,
          matched: 0,
          missingOrBehind: 0,
          lagP50Seconds: null,
          lagP95Seconds: null,
        },
      };
      try {
        const lc = liveColumns.get(liveTable);
        const sc = shadowColumns.get(shadowTable);
        if (!lc || !sc) {
          throw new Error(
            `table ${!lc ? `${liveDataset}.${liveTable}` : `${shadowDataset}.${shadowTable}`} not found`,
          );
        }
        assertSafeName("table", liveTable);
        assertSafeName("table", shadowTable);
        for (const column of [...lc, ...sc]) assertSafeName("column", column);
        const cols = comparableColumns(lc, sc);
        const keyColumns = await deps.keyColumns(live, entity);
        for (const key of keyColumns) assertSafeName("key column", key);
        const missingKey = keyColumns.filter(k => !cols.common.includes(k));
        if (missingKey.length) {
          throw new Error(`key column ${missingKey.join(", ")} missing`);
        }
        const tables: ParityTables = {
          live: bqTable(project, liveDataset, liveTable),
          shadow: bqTable(project, shadowDataset, shadowTable),
          keyColumns,
          columns: cols.common,
          cutoff,
          windowStart: window.start,
          hasIngestSeq:
            lc.includes("_mako_ingest_seq") && sc.includes("_mako_ingest_seq"),
        };
        const [row] = await withQueryLabels(labels, () =>
          deps.query(destination, buildSummarySql(tables), location),
        );
        const summary = readSummaryRow(row ?? {}, cols.common);
        const top = summary.fieldDiffs.slice(0, PARITY_GATE.topFields);
        let topFields: IFlowParityEntity["topFields"] = top.map(d => ({
          ...d,
          samples: [],
        }));
        if (top.length > 0) {
          const sampleRows = await withQueryLabels(labels, () =>
            deps.query(
              destination,
              buildSamplesSql(
                tables,
                top.map(d => d.field),
                PARITY_GATE.samplesPerField,
              ),
              location,
            ),
          );
          const byField = new Map(
            sampleRows.map(r => [String(r.field), r.samples]),
          );
          topFields = topFields.map(d => ({
            ...d,
            samples: (
              (byField.get(d.field) as Array<Record<string, unknown>>) ?? []
            ).map(s => ({
              key: String(s.key ?? ""),
              live:
                s.live === null || s.live === undefined ? null : String(s.live),
              shadow:
                s.shadow === null || s.shadow === undefined
                  ? null
                  : String(s.shadow),
            })),
          }));
        }
        const { fieldDiffs: _f, ...counts } = summary;
        const result = {
          ...base,
          ...counts,
          keyColumns,
          liveOnlyColumns: cols.liveOnly,
          shadowOnlyColumns: cols.shadowOnly,
          topFields,
        };
        const verdict = entityVerdict(result);
        results.push({
          ...result,
          clean: verdict.reasons.length === 0,
          reasons: verdict.reasons,
          notes: verdict.notes,
        });
        reasons.push(...verdict.reasons);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed = { ...base, error: message };
        const verdict = entityVerdict(failed);
        results.push({
          ...failed,
          clean: false,
          reasons: verdict.reasons,
          notes: [],
        });
        reasons.push(...verdict.reasons);
      }
    }

    // Errors in the freshness window: any failed shadow run, entity or
    // webhook batch since the window opened blocks the gate.
    const errors = await shadowErrorsSince(shadow._id, window.start);
    if (errors.failedRuns > 0) {
      reasons.push(
        `${errors.failedRuns} shadow run${errors.failedRuns === 1 ? "" : "s"} failed in the window`,
      );
    }
    if (errors.failedEntities.length > 0) {
      reasons.push(
        `Shadow entities failed in the window: ${errors.failedEntities.join(", ")}`,
      );
    }
    if (errors.failedWebhookEvents > 0) {
      reasons.push(
        `${errors.failedWebhookEvents} shadow webhook event${errors.failedWebhookEvents === 1 ? "" : "s"} failed in the window`,
      );
    }

    return await finish({
      status: "done",
      cutoff,
      window,
      errors,
      twin: {
        slug: shadow.boxedApproval?.slug ?? "",
        sourceSha: shadow.boxedApproval?.sourceSha,
      },
      shadowBackfillCompletedAt: backfillCompletedAt,
      entities: results,
      clean: reasons.length === 0,
      reasons,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Parity check failed", {
      shadowFlowId: input.shadowFlowId,
      error: message,
    });
    return finish({
      status: "error",
      error: message,
      clean: false,
      reasons: [message],
    });
  }
}

export interface ParityGate {
  open: boolean;
  reasons: string[];
  shadowFlowId: string | null;
  check: Pick<
    IFlowParityCheck,
    "_id" | "startedAt" | "finishedAt" | "clean" | "window" | "reasons"
  > | null;
}

/** The newest shadow of a live flow, or null. */
export async function shadowOf(
  live: Pick<IFlow, "_id" | "workspaceId">,
): Promise<IFlow | null> {
  return (await Flow.findOne({
    workspaceId: live.workspaceId,
    shadowOf: live._id,
  })
    .sort({ createdAt: -1 })
    .lean()) as IFlow | null;
}

/**
 * Whether a live flow may switch to its folder twin now: its shadow's latest
 * finished check is clean, covers 2 h of live updates after the full
 * backfill, and is under 90 minutes old.
 */
export async function parityGate(
  live: Pick<IFlow, "_id" | "workspaceId">,
  now: Date = new Date(),
  /**
   * The twin a switch would approve (slug and code). The check must be
   * evidence about THAT code: a clean check of `close` opens no gate for
   * `close-v2`, nor for `close` after new code was pushed.
   */
  expectTwin?: { slug: string; sourceSha?: string },
): Promise<ParityGate> {
  const shadow = await shadowOf(live);
  if (!shadow) {
    return {
      open: false,
      reasons: ["No shadow: start one with flow_shadow"],
      shadowFlowId: null,
      check: null,
    };
  }
  const check = (await FlowParityCheck.findOne({
    shadowFlowId: shadow._id,
    status: { $in: ["done", "error"] },
  })
    .sort({ startedAt: -1 })
    .lean()) as IFlowParityCheck | null;
  const reasons: string[] = [];
  if (!check) {
    reasons.push("No parity check has run on the shadow yet");
  } else {
    if (!check.clean) {
      reasons.push(...(check.reasons ?? ["The check is not clean"]));
    }
    const coverage = check.window?.coverageMinutes ?? 0;
    if (coverage < PARITY_GATE.windowMinutes) {
      reasons.push(
        `The check covers ${coverage} min of live updates after the shadow's backfill; the gate needs ${PARITY_GATE.windowMinutes}`,
      );
    }
    if (
      expectTwin &&
      (check.twin?.slug !== expectTwin.slug ||
        (check.twin?.sourceSha ?? "") !== (expectTwin.sourceSha ?? ""))
    ) {
      reasons.push(
        `The latest check ran ${check.twin?.slug || "another twin"}${check.twin?.sourceSha ? ` at ${check.twin.sourceSha.slice(0, 8)}` : ""}; the switch would run ${expectTwin.slug}${expectTwin.sourceSha ? ` at ${expectTwin.sourceSha.slice(0, 8)}` : ""}. Restart the shadow and check again`,
      );
    }
    // Evidence about the shadow's CURRENT backfill, not an earlier one.
    const current = await shadowBackfillCompletedAt(shadow);
    const checked = check.shadowBackfillCompletedAt
      ? new Date(check.shadowBackfillCompletedAt).getTime()
      : null;
    if (!current || checked !== current.getTime()) {
      reasons.push(
        "The latest check predates the shadow's current backfill; check again once it completes",
      );
    }
    const finished = check.finishedAt ?? check.startedAt;
    const age = Math.floor(
      (now.getTime() - new Date(finished).getTime()) / MINUTE,
    );
    if (age > PARITY_GATE.maxCheckAgeMinutes) {
      reasons.push(
        `The latest check is ${age} min old; the gate needs one under ${PARITY_GATE.maxCheckAgeMinutes}`,
      );
    }
  }
  return {
    open: reasons.length === 0,
    reasons,
    shadowFlowId: String(shadow._id),
    check: check
      ? {
          _id: check._id,
          startedAt: check.startedAt,
          finishedAt: check.finishedAt,
          clean: check.clean,
          window: check.window,
          reasons: check.reasons,
        }
      : null,
  };
}

/** Active shadows the scheduled check covers. */
export async function activeShadowFlowIds(): Promise<string[]> {
  const filter: Record<string, unknown> = {
    shadowOf: { $exists: true, $ne: null },
    "schedule.enabled": true,
  };
  const rows = (await Flow.find(filter).select("_id").lean()) as Array<{
    _id: Types.ObjectId;
  }>;
  return rows.map(r => String(r._id));
}
