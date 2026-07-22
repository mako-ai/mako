/**
 * Legacy → CDC flow migration planner (Phase 5 of the unified sync-flow plan).
 *
 * Pure decision logic: given a legacy flow and its destination/source, decide
 * whether and how it migrates onto the CDC engine:
 *
 * - `syncMode: "full"` scheduled flows become CDC flows whose cadence is the
 *   periodic full reconcile (`backfillSchedule`) — same behavior (periodic
 *   complete re-pull), but checkpointed, state-machine tracked, and MERGE-based
 *   instead of the legacy staging swap.
 * - `syncMode: "incremental"` scheduled flows keep their `schedule` as the
 *   CDC incremental poll trigger (anchored on `_syncedAt`).
 * - Mongo-collection destinations (no `tableDestination`) get a synthesized
 *   `tableDestination` whose table prefix is the data-source name, preserving
 *   the legacy `<dataSource>_<entity>` collection naming so existing data
 *   stays addressable.
 *
 * Kept dependency-free (structural types only) so the CLI, tests, and any
 * future admin route can share it.
 */

export const CDC_CAPABLE_DESTINATION_TYPES = [
  "bigquery",
  "clickhouse",
  "postgresql",
  "mysql",
  "mongodb",
] as const;

export interface MigrationFlowInput {
  _id: string;
  type?: "scheduled" | "webhook";
  sourceType?: "connector" | "database";
  syncEngine?: "legacy" | "cdc";
  syncMode?: "full" | "incremental";
  schedule?: { enabled?: boolean; cron?: string | null; timezone?: string };
  backfillSchedule?: {
    enabled?: boolean;
    cron?: string | null;
    timezone?: string;
  };
  tableDestination?: {
    connectionId?: unknown;
    schema?: string;
    tableName?: string;
  };
  destinationDatabaseId?: unknown;
  destinationDatabaseName?: string;
  deleteMode?: "hard" | "soft";
}

export interface MigrationDestinationInput {
  type?: string;
  /** For MongoDB destinations: the database name configured on the connection. */
  databaseName?: string;
  /** Whether this destination's CDC path requires soft-delete tombstones. */
  requiresSoftDeleteForCdc?: boolean;
}

export interface MigrationSourceInput {
  /** Data source (connector) name — used as the synthesized table prefix. */
  name?: string;
}

export type MigrationDecision =
  | {
      action: "migrate";
      flowId: string;
      updates: {
        syncEngine: "cdc";
        schedule?: { enabled: boolean; cron?: string; timezone?: string };
        backfillSchedule?: { enabled: boolean; cron: string; timezone: string };
        tableDestination?: {
          connectionId: unknown;
          schema: string;
          tableName: string;
          createIfNotExists: true;
        };
        deleteMode?: "soft";
      };
      notes: string[];
    }
  | {
      action: "skip";
      flowId: string;
      reason: string;
    }
  | {
      action: "blocked";
      flowId: string;
      reason: string;
    };

export function planLegacyFlowMigration(
  flow: MigrationFlowInput,
  destination: MigrationDestinationInput | null,
  source: MigrationSourceInput | null,
): MigrationDecision {
  const flowId = String(flow._id);

  if (flow.sourceType === "database") {
    return {
      action: "skip",
      flowId,
      reason: "database-query source (DB sync path, not connector CDC)",
    };
  }
  if (flow.syncEngine === "cdc") {
    return { action: "skip", flowId, reason: "already on the CDC engine" };
  }

  if (!destination || !destination.type) {
    return {
      action: "blocked",
      flowId,
      reason: "destination connection not found",
    };
  }

  const destType = destination.type.toLowerCase();
  if (
    !(CDC_CAPABLE_DESTINATION_TYPES as readonly string[]).includes(destType)
  ) {
    return {
      action: "blocked",
      flowId,
      reason: `no CDC adapter for destination type '${destType}'`,
    };
  }

  const notes: string[] = [];
  const updates: Extract<MigrationDecision, { action: "migrate" }>["updates"] =
    {
      syncEngine: "cdc",
    };

  // --- Destination table mapping -----------------------------------------
  const hasTableDestination = Boolean(
    flow.tableDestination &&
      (flow.tableDestination.connectionId ||
        flow.tableDestination.schema ||
        flow.tableDestination.tableName),
  );
  if (!hasTableDestination) {
    // Legacy Mongo collection destination: synthesize a tableDestination that
    // preserves `<dataSource>_<entity>` collection naming.
    if (destType !== "mongodb") {
      return {
        action: "blocked",
        flowId,
        reason: `legacy collection destination on non-mongodb type '${destType}' (no tableDestination to migrate)`,
      };
    }
    const prefix = (source?.name || "").trim();
    if (!prefix) {
      return {
        action: "blocked",
        flowId,
        reason: "cannot synthesize table prefix: data source name unknown",
      };
    }
    const schema =
      destination.databaseName?.trim() ||
      flow.destinationDatabaseName?.trim() ||
      "";
    if (!schema) {
      return {
        action: "blocked",
        flowId,
        reason: "cannot resolve destination database name for mongodb",
      };
    }
    updates.tableDestination = {
      connectionId: flow.destinationDatabaseId,
      schema,
      tableName: prefix,
      createIfNotExists: true,
    };
    notes.push(
      `synthesized tableDestination ${schema}.${prefix}_* (preserves legacy collection names)`,
    );
  } else if (!flow.tableDestination?.schema?.trim()) {
    if (destType === "postgresql") {
      updates.tableDestination = {
        connectionId:
          flow.tableDestination?.connectionId ?? flow.destinationDatabaseId,
        schema: "public",
        tableName: flow.tableDestination?.tableName || "",
        createIfNotExists: true,
      };
      notes.push("defaulted missing schema to 'public'");
    } else {
      return {
        action: "blocked",
        flowId,
        reason: `tableDestination has no schema/dataset (required for '${destType}')`,
      };
    }
  }

  // --- Trigger mapping -----------------------------------------------------
  const scheduleEnabled = Boolean(
    flow.schedule?.enabled && flow.schedule?.cron,
  );
  const timezone = flow.schedule?.timezone || "UTC";
  const syncMode = flow.syncMode || "full";

  if (scheduleEnabled && syncMode === "full") {
    // A scheduled FULL sync is a periodic complete re-pull — exactly what the
    // CDC reconcile trigger does (checkpointed). Note: for `append_dedup`
    // writeMode this only upserts current records — it does NOT remove rows
    // deleted at the source (only Overwrite mode or delete webhooks do
    // that today; see docs/sync-modes-hardening-plan.md, Phase 2).
    updates.backfillSchedule = {
      enabled: true,
      cron: String(flow.schedule?.cron),
      timezone,
    };
    updates.schedule = { enabled: false, timezone };
    notes.push(
      "full scheduled sync → periodic full reconcile (backfillSchedule); poll schedule disabled",
    );
  } else if (scheduleEnabled && syncMode === "incremental") {
    notes.push("incremental scheduled sync → CDC incremental poll (kept)");
    if (!flow.backfillSchedule?.enabled) {
      notes.push(
        "recommendation: enable the webhook trigger or Full Refresh | Overwrite to pick up source deletions — a periodic full reconcile in Deduped mode does not remove them",
      );
    }
  } else {
    notes.push("no enabled schedule — manual/trigger-less flow, engine only");
  }

  // --- Delete mode ---------------------------------------------------------
  if (destination.requiresSoftDeleteForCdc && flow.deleteMode !== "soft") {
    updates.deleteMode = "soft";
    notes.push("forced soft delete (destination CDC MERGE needs tombstones)");
  }

  return { action: "migrate", flowId, updates, notes };
}
