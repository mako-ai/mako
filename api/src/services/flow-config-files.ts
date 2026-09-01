/**
 * Flow config as files (RFC #904): the pure format layer.
 *
 * - `flows/<slug>.yml` — ONE file per flow. A central registry would be a
 *   merge-conflict magnet; per-file is the recorded doctrine (apps.md §23).
 * - The filename slug is the flow's identity and never moves; `name:`
 *   inside is the editable display name.
 *
 * **What must never appear here** — the Flow schema interleaves runtime
 * state inside definition objects, so the split is per-field, not
 * per-object:
 *
 * | Excluded | Why |
 * | --- | --- |
 * | `incrementalConfig.lastValue` | a cursor that moves every sync — would commit on every run |
 * | `paginationConfig.lastKeysetValue` | same |
 * | `backfillSchedule.lastRunAt` | scheduler claim state |
 * | `webhookConfig.secret` | a credential |
 * | `webhookConfig.endpoint` | inbound URL identity; Mongo-side, must survive a rename |
 * | `webhookConfig.lastReceivedAt` / `totalReceived` | counters |
 * | `syncState`, `streamState`, `backfillState`, `lastRunAt`, … | run state |
 *
 * Credentials never appear either: connections are referenced by id,
 * exactly as `dbt/environments.yml` does.
 *
 * `parseFlowFile` exists for round-tripping and for block 3 (the push
 * reactor, where files become authoritative). While Mongo is authoritative
 * it is not yet a trust boundary — block 3 hardens validation before
 * flipping direction.
 */
import yaml from "js-yaml";

// Type-only: the format layer must stay free of runtime imports so it can
// be exercised without booting the git/mongo stack.
import type { IFlow } from "../database/workspace-schema";
import { slugifyName } from "../utils/slugify";

export const FLOWS_DIR = "flows";

export function flowFilePath(slug: string): string {
  return `${FLOWS_DIR}/${slug}.yml`;
}

export function slugFromFlowFilePath(repoRelative: string): string | null {
  const m = repoRelative.match(/^flows\/([a-z0-9][a-z0-9-]*)\.yml$/);
  return m ? m[1] : null;
}

/** Stable filename identity for a flow, derived once from its name. */
export function slugifyFlowName(name: string): string {
  return slugifyName(name, { fallback: "flow" });
}

export interface FlowFileSchedule {
  cron: string;
  timezone: string;
}

export interface FlowFile {
  name: string;
  type: "scheduled" | "webhook";
  source:
    | { type: "connector"; connectorId: string }
    | {
        type: "database";
        connectionId?: string;
        database?: string;
        query?: string;
      };
  destination: {
    connectionId: string;
    databaseName?: string;
    table?: {
      connectionId?: string;
      database?: string;
      schema?: string;
      tableName?: string;
      createIfNotExists?: boolean;
      partitioning?: Record<string, unknown>;
      clustering?: Record<string, unknown>;
    };
  };
  schedule?: FlowFileSchedule | null;
  backfillSchedule?: FlowFileSchedule | null;
  /** Only whether inbound delivery is on; never the endpoint or secret. */
  webhookEnabled?: boolean;
  sync: {
    mode?: string;
    writeMode?: string;
    engine?: string;
    deleteMode?: string;
    batchSize?: number;
  };
  entityFilter?: string[];
  entityLayouts?: Array<Record<string, unknown>>;
  /** Definition half only — never `lastValue`. */
  incremental?: { trackingColumn?: string; trackingType?: string };
  conflict?: { keyColumns?: string[]; strategy?: string };
  /** Definition half only — never `lastKeysetValue`. */
  pagination?: {
    mode?: string;
    keysetColumn?: string;
    keysetDirection?: string;
  };
  typeCoercions?: Array<Record<string, unknown>>;
  queries?: Array<Record<string, unknown>>;
}

/**
 * `partitioning` / `clustering` are pass-through blobs from the row, so
 * their keys arrive camelCase (`requirePartitionFilter`) while every other
 * key in the file is snake_case. Normalise both directions — cheap now,
 * a breaking format change once people hand-edit these files.
 */
function snakeKeys(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)] = val;
  }
  return out;
}

function camelKeys(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = val;
  }
  return out;
}

function omitEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v as object).length === 0
    ) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function serializeFlowFile(flow: FlowFile): string {
  const doc: Record<string, unknown> = { name: flow.name, type: flow.type };

  doc.source =
    flow.source.type === "database"
      ? omitEmpty({
          type: "database",
          connection_id: flow.source.connectionId,
          database: flow.source.database,
          query: flow.source.query,
        })
      : omitEmpty({ type: "connector", connector_id: flow.source.connectorId });

  const table = flow.destination.table;
  doc.destination = omitEmpty({
    connection_id: flow.destination.connectionId,
    database_name: flow.destination.databaseName,
    table: table
      ? omitEmpty({
          connection_id: table.connectionId,
          database: table.database,
          schema: table.schema,
          table_name: table.tableName,
          create_if_not_exists: table.createIfNotExists,
          partitioning: table.partitioning
            ? snakeKeys(table.partitioning)
            : undefined,
          clustering: table.clustering
            ? snakeKeys(table.clustering)
            : undefined,
        })
      : undefined,
  });

  if (flow.schedule) {
    doc.schedule = {
      cron: flow.schedule.cron,
      timezone: flow.schedule.timezone,
    };
  }
  if (flow.backfillSchedule) {
    doc.backfill_schedule = {
      cron: flow.backfillSchedule.cron,
      timezone: flow.backfillSchedule.timezone,
    };
  }
  if (flow.type === "webhook") {
    doc.webhook = { enabled: flow.webhookEnabled !== false };
  }

  const sync = omitEmpty({
    mode: flow.sync.mode,
    write_mode: flow.sync.writeMode,
    engine: flow.sync.engine,
    delete_mode: flow.sync.deleteMode,
    batch_size: flow.sync.batchSize,
  });
  if (Object.keys(sync).length > 0) doc.sync = sync;

  const entities = omitEmpty({
    filter: flow.entityFilter,
    layouts: flow.entityLayouts,
  });
  if (Object.keys(entities).length > 0) doc.entities = entities;

  const incremental = omitEmpty({
    tracking_column: flow.incremental?.trackingColumn,
    tracking_type: flow.incremental?.trackingType,
  });
  if (Object.keys(incremental).length > 0) doc.incremental = incremental;

  const conflict = omitEmpty({
    key_columns: flow.conflict?.keyColumns,
    strategy: flow.conflict?.strategy,
  });
  if (Object.keys(conflict).length > 0) doc.conflict = conflict;

  const pagination = omitEmpty({
    mode: flow.pagination?.mode,
    keyset_column: flow.pagination?.keysetColumn,
    keyset_direction: flow.pagination?.keysetDirection,
  });
  if (Object.keys(pagination).length > 0) doc.pagination = pagination;

  if (flow.typeCoercions?.length) doc.type_coercions = flow.typeCoercions;
  if (flow.queries?.length) doc.queries = flow.queries;

  return yaml.dump(doc, { lineWidth: 100, noRefs: true, sortKeys: false });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function scheduleFrom(v: unknown): FlowFileSchedule | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  const cron = str(s.cron);
  if (!cron) return null;
  return { cron, timezone: str(s.timezone) ?? "UTC" };
}

export function parseFlowFile(contents: string): FlowFile | null {
  let raw: unknown;
  try {
    raw = yaml.load(contents);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const doc = raw as Record<string, unknown>;

  const name = str(doc.name);
  const type = str(doc.type);
  if (!name || (type !== "scheduled" && type !== "webhook")) return null;

  const srcDoc = (doc.source ?? {}) as Record<string, unknown>;
  const source: FlowFile["source"] =
    str(srcDoc.type) === "database"
      ? {
          type: "database",
          connectionId: str(srcDoc.connection_id),
          database: str(srcDoc.database),
          query: str(srcDoc.query),
        }
      : { type: "connector", connectorId: str(srcDoc.connector_id) ?? "" };

  const destDoc = (doc.destination ?? {}) as Record<string, unknown>;
  const tableDoc = destDoc.table as Record<string, unknown> | undefined;
  const destination: FlowFile["destination"] = {
    connectionId: str(destDoc.connection_id) ?? "",
    databaseName: str(destDoc.database_name),
    table: tableDoc
      ? {
          connectionId: str(tableDoc.connection_id),
          database: str(tableDoc.database),
          schema: str(tableDoc.schema),
          tableName: str(tableDoc.table_name),
          createIfNotExists: tableDoc.create_if_not_exists as
            | boolean
            | undefined,
          partitioning: tableDoc.partitioning
            ? camelKeys(tableDoc.partitioning as Record<string, unknown>)
            : undefined,
          clustering: tableDoc.clustering
            ? camelKeys(tableDoc.clustering as Record<string, unknown>)
            : undefined,
        }
      : undefined,
  };

  const syncDoc = (doc.sync ?? {}) as Record<string, unknown>;
  const entitiesDoc = (doc.entities ?? {}) as Record<string, unknown>;
  const incDoc = (doc.incremental ?? {}) as Record<string, unknown>;
  const conflictDoc = (doc.conflict ?? {}) as Record<string, unknown>;
  const pageDoc = (doc.pagination ?? {}) as Record<string, unknown>;
  const webhookDoc = doc.webhook as Record<string, unknown> | undefined;

  return {
    name,
    type,
    source,
    destination,
    schedule: scheduleFrom(doc.schedule),
    backfillSchedule: scheduleFrom(doc.backfill_schedule),
    webhookEnabled: webhookDoc ? webhookDoc.enabled !== false : undefined,
    sync: {
      mode: str(syncDoc.mode),
      writeMode: str(syncDoc.write_mode),
      engine: str(syncDoc.engine),
      deleteMode: str(syncDoc.delete_mode),
      batchSize:
        typeof syncDoc.batch_size === "number" ? syncDoc.batch_size : undefined,
    },
    entityFilter: Array.isArray(entitiesDoc.filter)
      ? (entitiesDoc.filter.filter(e => typeof e === "string") as string[])
      : undefined,
    entityLayouts: Array.isArray(entitiesDoc.layouts)
      ? (entitiesDoc.layouts as Array<Record<string, unknown>>)
      : undefined,
    incremental: {
      trackingColumn: str(incDoc.tracking_column),
      trackingType: str(incDoc.tracking_type),
    },
    conflict: {
      keyColumns: Array.isArray(conflictDoc.key_columns)
        ? (conflictDoc.key_columns.filter(
            c => typeof c === "string",
          ) as string[])
        : undefined,
      strategy: str(conflictDoc.strategy),
    },
    pagination: {
      mode: str(pageDoc.mode),
      keysetColumn: str(pageDoc.keyset_column),
      keysetDirection: str(pageDoc.keyset_direction),
    },
    typeCoercions: Array.isArray(doc.type_coercions)
      ? (doc.type_coercions as Array<Record<string, unknown>>)
      : undefined,
    queries: Array.isArray(doc.queries)
      ? (doc.queries as Array<Record<string, unknown>>)
      : undefined,
  };
}

/**
 * The definition half of a flow row. Every exclusion here is deliberate —
 * see the table in flow-config-files.ts for what must never be written and
 * why (moving cursors, credentials, inbound URL identity, run state).
 */
export function flowToFile(flow: IFlow): FlowFile {
  const source: FlowFile["source"] =
    flow.sourceType === "database"
      ? {
          type: "database",
          connectionId: flow.databaseSource?.connectionId?.toString(),
          database: flow.databaseSource?.database,
          query: flow.databaseSource?.query,
        }
      : {
          type: "connector",
          connectorId: flow.dataSourceId?.toString() ?? "",
        };

  const t = flow.tableDestination;
  return {
    name: flow.name ?? "",
    type: flow.type,
    source,
    destination: {
      connectionId: flow.destinationDatabaseId?.toString() ?? "",
      databaseName: flow.destinationDatabaseName,
      table: t
        ? {
            connectionId: t.connectionId?.toString(),
            database: t.database,
            schema: t.schema,
            tableName: t.tableName,
            createIfNotExists: t.createIfNotExists,
            partitioning: t.partitioning as Record<string, unknown> | undefined,
            clustering: t.clustering as Record<string, unknown> | undefined,
          }
        : undefined,
    },
    // Schedules carry cron + timezone only; `backfillSchedule.lastRunAt` is
    // a scheduler claim and stays on the row.
    schedule:
      flow.schedule?.enabled && flow.schedule.cron
        ? {
            cron: flow.schedule.cron,
            timezone: flow.schedule.timezone || "UTC",
          }
        : null,
    backfillSchedule:
      flow.backfillSchedule?.enabled && flow.backfillSchedule.cron
        ? {
            cron: flow.backfillSchedule.cron,
            timezone: flow.backfillSchedule.timezone || "UTC",
          }
        : null,
    // Enabled-ness only: the endpoint is inbound URL identity and the
    // secret is a credential.
    webhookEnabled:
      flow.type === "webhook"
        ? flow.webhookConfig?.enabled !== false
        : undefined,
    sync: {
      mode: flow.syncMode,
      writeMode: flow.writeMode,
      engine: flow.syncEngine,
      deleteMode: flow.deleteMode,
      batchSize: flow.batchSize,
    },
    entityFilter: flow.entityFilter ? [...flow.entityFilter] : undefined,
    entityLayouts: flow.entityLayouts
      ? (flow.entityLayouts as unknown as Array<Record<string, unknown>>)
      : undefined,
    // Definition halves only — `lastValue` / `lastKeysetValue` are cursors
    // that move on every sync and must never reach a commit.
    incremental: flow.incrementalConfig
      ? {
          trackingColumn: flow.incrementalConfig.trackingColumn,
          trackingType: flow.incrementalConfig.trackingType,
        }
      : undefined,
    conflict: flow.conflictConfig
      ? {
          keyColumns: flow.conflictConfig.keyColumns
            ? [...flow.conflictConfig.keyColumns]
            : undefined,
          strategy: flow.conflictConfig.strategy,
        }
      : undefined,
    pagination: flow.paginationConfig
      ? {
          mode: flow.paginationConfig.mode,
          keysetColumn: flow.paginationConfig.keysetColumn,
          keysetDirection: flow.paginationConfig.keysetDirection,
        }
      : undefined,
    typeCoercions: flow.typeCoercions
      ? (flow.typeCoercions as unknown as Array<Record<string, unknown>>)
      : undefined,
    queries: flow.queries
      ? (flow.queries as unknown as Array<Record<string, unknown>>)
      : undefined,
  };
}
