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
import { DatabaseConnection } from "../database/workspace-schema";
import { loggers } from "../logging";
import { inWorkspace } from "../utils/workspace-scope";
import {
  resolveCdcDestinationAdapter,
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

  if (layoutField && layoutField !== real.timePartitioning?.field) {
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

  const layoutCluster = layout.clusterFields ?? [];
  if (
    layoutCluster.length > 0 &&
    layoutCluster.join(",") !== real.clusterFields.join(",")
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
  } | null;
  entityLayouts?: ArrayLike<LayoutToCheck> | null;
  entityFilter?: ArrayLike<string> | null;
}

/** The tables one layout writes: its entity, or each selected `entity:sub`. */
function entitiesForLayout(
  layout: LayoutToCheck,
  entityFilter: string[],
): string[] {
  const matching = entityFilter.filter(
    e => e === layout.entity || e.split(":")[0] === layout.entity,
  );
  return matching.length > 0 ? matching : [layout.entity];
}

/**
 * Every layout of a BigQuery CDC flow that disagrees with its existing table.
 * Empty for other destinations, flows without layouts, missing tables and
 * unreadable metadata.
 */
export async function findLayoutTableMismatches(
  flow: FlowForLayoutCheck,
  deps: {
    /** Test seam: the adapter that reads table metadata. */
    adapterFor?: (args: { schema: string }) => CdcDestinationAdapter;
  } = {},
): Promise<LayoutTableMismatch[]> {
  const layouts = Array.from(flow.entityLayouts ?? []).filter(
    l => l && l.enabled !== false && l.entity,
  );
  const td = flow.tableDestination;
  if (layouts.length === 0 || !td?.connectionId) return [];

  const workspaceId = String(flow.workspaceId);
  const destination = await DatabaseConnection.findOne(
    inWorkspace(td.connectionId as string, workspaceId),
  )
    .select({ type: 1 })
    .lean();
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
    if (!adapter.describeLiveTable) return [];

    const mismatches: LayoutTableMismatch[] = [];
    const seen = new Set<string>();
    for (const layout of layouts) {
      for (const entity of entitiesForLayout(layout, entityFilter)) {
        const table = cdcLiveTableName(
          td.tableName,
          entity,
          flow._id ? String(flow._id) : undefined,
        );
        if (seen.has(table)) continue;
        seen.add(table);
        const real = await adapter.describeLiveTable(table);
        if (!real) continue;
        mismatches.push(
          ...compareLayoutToTable({ entity, table, layout, real }),
        );
      }
    }
    return mismatches;
  } catch (err) {
    log.warn("Layout check skipped: could not read the destination", {
      flowId: flow._id ? String(flow._id) : undefined,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
