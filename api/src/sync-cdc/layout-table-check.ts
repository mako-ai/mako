/**
 * A flow's entity layouts against the destination tables they describe.
 *
 * On 17 Nov 2026 two Close shadow flows carried layouts saying partition field
 * `_syncedAt` while the destination tables were partitioned on `date_created`.
 * The layout only matters when a table is created, so the flows ran and the
 * mismatch stayed invisible. This check reads each BigQuery table's metadata
 * (free) and names every layout that disagrees with its table, at flow save
 * and in `check_flow_files`.
 *
 * A table that does not exist yet passes: the layout creates it. A metadata
 * read that fails passes too: a save must not depend on a flaky read.
 */
import { loggers } from "../logging";
import { connectionsRepo } from "../repositories/connections";
import {
  resolveCdcDestinationAdapter,
  resolveEntityClustering,
  resolveEntityPartitioning,
  type CdcDestinationAdapter,
  type LiveTableDescription,
} from "./adapters/registry";
import { cdcLiveTableName } from "./normalization";

const log = loggers.sync("cdc.layout-table-check");

export type LayoutMismatchKind =
  "partition_field" | "partition_granularity" | "cluster_fields";

export interface LayoutTableMismatch {
  entity: string;
  table: string;
  kind: LayoutMismatchKind;
  /** What the layout says. */
  layoutValue: string;
  /** What the table has. */
  realValue: string;
  /** One sentence: the mismatch and how to fix it. */
  message: string;
}

/** The slice of an entity layout this check reads. */
export interface LayoutToCheck {
  entity: string;
  partitionField?: string;
  partitionGranularity?: string;
  clusterFields?: string[];
  enabled?: boolean;
}

const MAX_CLUSTER_FIELDS = 4;
const MAX_PARALLEL_TABLE_READS = 8;

const NO_PARTITIONING = "no partitioning";

function realPartitionField(table: LiveTableDescription): string {
  if (table.timePartitioning) {
    return table.timePartitioning.field ?? "_PARTITIONTIME (ingestion time)";
  }
  if (table.rangePartitionField) {
    return `${table.rangePartitionField} (integer range)`;
  }
  return NO_PARTITIONING;
}

function fix(p: {
  entity: string;
  table: string;
  what: string;
  layoutValue: string;
  realValue: string;
  layoutKey: string;
}): string {
  return (
    `Entity "${p.entity}", table "${p.table}": the layout ${p.what} is ${p.layoutValue}, the table has ${p.realValue}. ` +
    `Fix it one of two ways. Set ${p.layoutKey} to match the table, or repartition the table explicitly to match the layout (a layout change with a repartition rewrites the table).`
  );
}

/** Mismatches between one layout and the real table it writes. */
export function compareLayoutToTable(p: {
  entity: string;
  table: string;
  layout: LayoutToCheck;
  real: LiveTableDescription;
}): LayoutTableMismatch[] {
  const { entity, table, layout, real } = p;
  if (!real.exists) return [];
  const out: LayoutTableMismatch[] = [];
  const realField = realPartitionField(real);
  const layoutField = layout.partitionField;

  // BigQuery column names are case-insensitive.
  if (
    layoutField &&
    layoutField.toLowerCase() !== real.timePartitioning?.field?.toLowerCase()
  ) {
    const layoutValue = `\`${layoutField}\``;
    const realValue =
      realField === NO_PARTITIONING ? realField : `\`${realField}\``;
    out.push({
      entity,
      table,
      kind: "partition_field",
      layoutValue: layoutField,
      realValue: realField,
      message: fix({
        entity,
        table,
        what: "partition_field",
        layoutValue,
        realValue,
        layoutKey: "partition_field",
      }),
    });
  } else if (layoutField && real.timePartitioning?.field) {
    const layoutGran = (layout.partitionGranularity || "day").toLowerCase();
    const realGran = (real.timePartitioning.type || "DAY").toLowerCase();
    if (layoutGran !== realGran) {
      out.push({
        entity,
        table,
        kind: "partition_granularity",
        layoutValue: layoutGran,
        realValue: realGran,
        message: fix({
          entity,
          table,
          what: "partition_granularity",
          layoutValue: layoutGran,
          realValue: realGran,
          layoutKey: "partition_granularity",
        }),
      });
    }
  }

  // The table is created with the first four cluster fields.
  const layoutCluster = (layout.clusterFields ?? []).slice(
    0,
    MAX_CLUSTER_FIELDS,
  );
  if (
    layoutCluster.length > 0 &&
    layoutCluster.join(",").toLowerCase() !==
      real.clusterFields.join(",").toLowerCase()
  ) {
    const layoutValue = layoutCluster.join(", ");
    const realValue = real.clusterFields.length
      ? real.clusterFields.join(", ")
      : "no clustering";
    out.push({
      entity,
      table,
      kind: "cluster_fields",
      layoutValue,
      realValue,
      message: fix({
        entity,
        table,
        what: "cluster_fields",
        layoutValue: `[${layoutValue}]`,
        realValue: real.clusterFields.length ? `[${realValue}]` : realValue,
        layoutKey: "cluster_fields",
      }),
    });
  }
  return out;
}

/** All mismatches as one message, one sentence per mismatch. */
export function formatLayoutMismatches(m: LayoutTableMismatch[]): string {
  return `Layout does not match the existing table. ${m.map(x => x.message).join(" ")}`;
}

/** The flow fields the check reads. A Flow document or a plain object fits. */
export interface FlowForLayoutCheck {
  _id?: unknown;
  workspaceId: unknown;
  destinationDatabaseId?: unknown;
  destinationDatabaseName?: string;
  tableDestination?: {
    connectionId?: unknown;
    schema?: string;
    tableName?: string;
    partitioning?: unknown;
    clustering?: unknown;
  } | null;
  entityLayouts?: ArrayLike<LayoutToCheck> | null;
  entityFilter?: ArrayLike<string> | null;
}

/** What a layout and the flow's table defaults resolve to when it creates a table. */
function effectiveLayout(
  layout: LayoutToCheck,
  td: FlowForLayoutCheck["tableDestination"],
): LayoutToCheck {
  const partitioning = resolveEntityPartitioning(
    layout,
    td?.partitioning as Parameters<typeof resolveEntityPartitioning>[1],
  );
  const clustering = resolveEntityClustering(
    layout,
    td?.clustering as Parameters<typeof resolveEntityClustering>[1],
  );
  return {
    entity: layout.entity,
    enabled: layout.enabled,
    partitionField: partitioning?.field,
    partitionGranularity: partitioning?.granularity,
    clusterFields: clustering?.fields
      ? Array.from(clustering.fields)
      : undefined,
  };
}

function layoutKey(l: LayoutToCheck): string {
  return JSON.stringify([
    l.entity,
    l.enabled !== false,
    (l.partitionField ?? "").toLowerCase(),
    (l.partitionGranularity ?? "day").toLowerCase(),
    Array.from(l.clusterFields ?? []).map(f => f.toLowerCase()),
  ]);
}

/** The slice of a stored definition a layout is judged against. */
export interface PreviousLayouts {
  entityLayouts?: ArrayLike<LayoutToCheck> | null;
  tableDestination?: {
    connectionId?: unknown;
    schema?: string;
    tableName?: string;
    partitioning?: unknown;
    clustering?: unknown;
  } | null;
}

/** A plain copy of the layouts and destination, safe to keep while a document mutates. */
export function snapshotLayouts(flow: FlowForLayoutCheck): PreviousLayouts {
  const td = flow.tableDestination;
  return {
    entityLayouts: Array.from(flow.entityLayouts ?? []).map(l => ({
      entity: l.entity,
      enabled: l.enabled,
      partitionField: l.partitionField,
      partitionGranularity: l.partitionGranularity,
      clusterFields: Array.from(l.clusterFields ?? []),
    })),
    tableDestination: td
      ? {
          connectionId: td.connectionId ? String(td.connectionId) : undefined,
          schema: td.schema,
          tableName: td.tableName,
          partitioning: td.partitioning
            ? JSON.parse(JSON.stringify(td.partitioning))
            : undefined,
          clustering: td.clustering
            ? JSON.parse(JSON.stringify(td.clustering))
            : undefined,
        }
      : null,
  };
}

function sameDestination(
  a: PreviousLayouts["tableDestination"],
  b: PreviousLayouts["tableDestination"],
): boolean {
  return (
    String(a?.connectionId ?? "") === String(b?.connectionId ?? "") &&
    (a?.schema ?? "") === (b?.schema ?? "") &&
    (a?.tableName ?? "") === (b?.tableName ?? "")
  );
}

/** The tables one layout writes: its entity, or each selected `entity:sub`. */
function entitiesForLayout(
  layout: LayoutToCheck,
  entityFilter: string[],
): string[] {
  // No selection: the layout's own entity. With a selection, a layout for an
  // entity outside it writes nothing.
  if (entityFilter.length === 0) return [layout.entity];
  return entityFilter.filter(
    e => e === layout.entity || e.split(":")[0] === layout.entity,
  );
}

async function mapWithLimit<T, R>(
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
 * Every layout of a BigQuery CDC flow that disagrees with its existing table.
 * Empty for other destinations, flows without layouts, missing tables and
 * unreadable metadata.
 *
 * With `previous`, only layouts that are new or changed against that stored
 * definition are judged (all of them when the destination moved). A flow
 * saved with an old mismatch it did not touch stays saveable.
 */
export async function findLayoutTableMismatches(
  flow: FlowForLayoutCheck,
  deps: {
    /** Test seam: the adapter that reads table metadata. */
    adapterFor?: (args: { schema: string }) => CdcDestinationAdapter;
    previous?: PreviousLayouts;
  } = {},
): Promise<LayoutTableMismatch[]> {
  const td = flow.tableDestination;
  let layouts = Array.from(flow.entityLayouts ?? []).filter(
    l => l && l.enabled !== false && l.entity,
  );
  if (deps.previous && sameDestination(deps.previous.tableDestination, td)) {
    const before = new Set(
      Array.from(deps.previous.entityLayouts ?? []).map(l =>
        layoutKey(effectiveLayout(l, deps.previous?.tableDestination)),
      ),
    );
    layouts = layouts.filter(
      l => !before.has(layoutKey(effectiveLayout(l, td))),
    );
  }
  if (layouts.length === 0 || !td?.connectionId) return [];

  const workspaceId = String(flow.workspaceId);
  const destination = await connectionsRepo.findDatabaseConnectionSummary(
    String(td.connectionId),
    workspaceId,
  );
  if (destination?.type?.toLowerCase() !== "bigquery") return [];

  const schema = td.schema || "public";
  const entityFilter = Array.from(flow.entityFilter ?? []);
  try {
    const adapter = deps.adapterFor
      ? deps.adapterFor({ schema })
      : resolveCdcDestinationAdapter({
          destinationType: destination.type,
          flowId: flow._id ? String(flow._id) : undefined,
          workspaceId,
          destinationDatabaseId: String(
            flow.destinationDatabaseId ?? td.connectionId,
          ),
          destinationDatabaseName: flow.destinationDatabaseName,
          tableDestination: {
            connectionId: String(td.connectionId),
            schema,
            tableName: td.tableName ?? "",
          },
        });
    const describe = adapter.describeLiveTable?.bind(adapter);
    if (!describe) return [];

    const jobs: Array<{
      entity: string;
      table: string;
      layout: LayoutToCheck;
    }> = [];
    const seen = new Set<string>();
    for (const layout of layouts) {
      const effective = effectiveLayout(layout, td);
      for (const entity of entitiesForLayout(layout, entityFilter)) {
        const table = cdcLiveTableName(
          td.tableName,
          entity,
          flow._id ? String(flow._id) : undefined,
        );
        if (seen.has(table)) continue;
        seen.add(table);
        jobs.push({ entity, table, layout: effective });
      }
    }
    const results = await mapWithLimit(
      jobs,
      MAX_PARALLEL_TABLE_READS,
      async job => {
        const real = await describe(job.table);
        return real ? compareLayoutToTable({ ...job, real }) : [];
      },
    );
    return results.flat();
  } catch (err) {
    log.warn("Layout check skipped: could not read the destination", {
      flowId: flow._id ? String(flow._id) : undefined,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Mismatches split by whether this change caused them: `changed` are layouts
 * the change adds or edits (refused), `untouched` are old ones it leaves
 * alone (a warning). Without `previous` every mismatch is `changed`.
 */
export async function splitLayoutMismatches(
  flow: FlowForLayoutCheck,
  previous?: PreviousLayouts,
): Promise<{
  changed: LayoutTableMismatch[];
  untouched: LayoutTableMismatch[];
}> {
  const changed = await findLayoutTableMismatches(flow, { previous });
  if (!previous) return { changed, untouched: [] };
  const all = await findLayoutTableMismatches(flow);
  const key = (m: LayoutTableMismatch) => `${m.table}|${m.kind}`;
  const changedKeys = new Set(changed.map(key));
  return { changed, untouched: all.filter(m => !changedKeys.has(key(m))) };
}

/** The view-only warnings stored on a flow row. */
export function toLayoutWarnings(
  mismatches: LayoutTableMismatch[],
  refused: boolean,
) {
  return mismatches.map(m => ({
    entity: m.entity,
    table: m.table,
    kind: m.kind,
    layoutValue: m.layoutValue,
    realValue: m.realValue,
    message: m.message,
    refused,
  }));
}
