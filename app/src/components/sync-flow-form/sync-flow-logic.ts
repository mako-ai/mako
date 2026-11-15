/**
 * Pure pieces of the Sync builder: loading a saved flow into the form,
 * pre-save validation, and the save payload. Kept out of the hook so they
 * can be tested without rendering.
 */
import { cronPresetValue } from "../flow-form/schedule-presets";
import type { Flow } from "../../store/flowStore";
import type { EntityLayoutConfig, FormData } from "./sync-flow-config";

/** Step indexes, as laid out in `STEPS`. */
export const SYNC_STEP = {
  source: 0,
  destination: 1,
  configuration: 2,
  entities: 3,
  triggers: 4,
} as const;

/** The saved-flow fields the form reads (the flows list payload). */
export type SavedSyncFlow = Pick<
  Flow,
  | "dataSourceId"
  | "destinationDatabaseId"
  | "destinationDatabaseName"
  | "schedule"
  | "webhookConfig"
  | "syncMode"
  | "writeMode"
  | "deleteMode"
  | "backfillSchedule"
  | "entityFilter"
  | "entityLayouts"
  | "queries"
  | "tableDestination"
>;

const idOf = (ref: string | { _id?: string } | null | undefined) =>
  typeof ref === "string" ? ref : ref?._id;

/**
 * Form values for a saved flow. `currentSecret` is the in-form webhook
 * secret: when a flows refresh races one-click provisioning (secret just
 * set in the form, not yet on the list payload), it is kept instead of
 * blanking the field.
 */
export function flowToFormData(
  flow: SavedSyncFlow,
  currentSecret: string | undefined,
): { formData: FormData; cronMode: "preset" | "custom" } {
  const hasWebhookTrigger = Boolean(
    flow.webhookConfig?.enabled && flow.webhookConfig?.endpoint,
  );
  const hasScheduleTrigger = Boolean(
    flow.schedule?.enabled && flow.schedule?.cron,
  );

  const formData: FormData = {
    dataSourceId: idOf(flow.dataSourceId) || "",
    destinationDatabaseId: idOf(flow.destinationDatabaseId) || "",
    destinationDatabaseName: flow.destinationDatabaseName || "",
    scheduleEnabled: hasScheduleTrigger,
    scheduleCron: flow.schedule?.cron || "0 * * * *",
    scheduleTimezone: flow.schedule?.timezone || "UTC",
    webhookEnabled: hasWebhookTrigger,
    webhookSecret: flow.webhookConfig?.secret || currentSecret || "",
    syncMode: (flow.syncMode as "full" | "incremental") || "full",
    writeMode:
      (flow.writeMode as "append_dedup" | "append" | "overwrite") ||
      "append_dedup",
    deleteMode: flow.deleteMode || "hard",
    backfillScheduleEnabled: flow.backfillSchedule?.enabled ?? false,
    backfillScheduleCron: flow.backfillSchedule?.cron || "0 3 * * *",
    backfillScheduleTimezone: flow.backfillSchedule?.timezone || "UTC",
    entityFilter: flow.entityFilter || [],
    entityLayouts: (flow.entityLayouts || []).map(l => ({
      ...l,
      enabled: l.enabled !== false,
    })),
    queries: flow.queries || [],
  };

  if (flow.tableDestination) {
    formData.tableDestination = {
      tablePrefix: flow.tableDestination.tableName || "",
      schema:
        flow.tableDestination.schema || flow.tableDestination.database || "",
    };
  }

  return {
    formData,
    cronMode:
      cronPresetValue(formData.scheduleCron) === "__custom__"
        ? "custom"
        : "preset",
  };
}

/**
 * Enabled entities whose partition or cluster layout differs from the saved
 * flow — those destination tables must be rebuilt for the change to apply.
 */
export function layoutChangedEntities(
  savedLayouts: EntityLayoutConfig[],
  layouts: EntityLayoutConfig[],
): string[] {
  const saved = new Map(savedLayouts.map(l => [l.entity, l]));
  const sortedFields = (fields?: string[]) =>
    JSON.stringify([...(fields || [])].sort());
  const changed: string[] = [];
  for (const layout of layouts) {
    if (layout.enabled === false) continue;
    const prev = saved.get(layout.entity);
    if (!prev || prev.enabled === false) continue;
    const partitionChanged =
      (prev.partitionField || "") !== (layout.partitionField || "") ||
      (prev.partitionGranularity || "") !== (layout.partitionGranularity || "");
    const clusterChanged =
      sortedFields(prev.clusterFields) !== sortedFields(layout.clusterFields);
    if (partitionChanged || clusterChanged) changed.push(layout.entity);
  }
  return changed;
}

export interface SyncSaveContext {
  connectorSupportsWebhook: boolean;
  isCdcCapableDest: boolean;
  isBigQueryDest: boolean;
  requiresDestinationDatabaseName: boolean;
  hasTransferQueries: boolean;
  requiresQueries: boolean;
  layoutMode: "partition" | "index" | "none";
}

/** Queries with both a name and a query body. */
export function validTransferQueries(data: FormData) {
  return (data.queries || []).filter(
    q =>
      typeof q?.name === "string" &&
      q.name.trim().length > 0 &&
      typeof q?.query === "string" &&
      q.query.trim().length > 0,
  );
}

/**
 * The first reason the form cannot be saved, and the step that fixes it —
 * or null when it can be.
 */
export function validateSyncSubmission(
  data: FormData,
  ctx: SyncSaveContext,
): { message: string; step: number } | null {
  if (data.scheduleEnabled && !data.scheduleCron.trim()) {
    return {
      message: "A cron expression is required for the scheduled trigger.",
      step: SYNC_STEP.triggers,
    };
  }
  if (data.webhookEnabled && !ctx.connectorSupportsWebhook) {
    return {
      message: "This connector does not provide webhooks — use a schedule.",
      step: SYNC_STEP.triggers,
    };
  }
  if (data.webhookEnabled && !ctx.isCdcCapableDest) {
    return {
      message:
        "Webhook-triggered syncs require a CDC-capable destination (BigQuery, PostgreSQL, ClickHouse, MongoDB, or MySQL).",
      step: SYNC_STEP.destination,
    };
  }
  if (ctx.isCdcCapableDest && !data.tableDestination?.schema?.trim()) {
    return {
      message: ctx.isBigQueryDest
        ? "A destination dataset is required."
        : "A destination schema is required.",
      step: SYNC_STEP.destination,
    };
  }
  if (
    ctx.requiresDestinationDatabaseName &&
    !data.destinationDatabaseName?.trim()
  ) {
    return {
      message:
        "Please select a destination database within the selected server.",
      step: SYNC_STEP.destination,
    };
  }
  const validQueries = validTransferQueries(data);
  const enabledBuiltinEntities = (data.entityLayouts || []).filter(
    l => l.enabled !== false,
  );
  if (ctx.requiresQueries && validQueries.length === 0) {
    return {
      message: "Please add at least one query to define what data to sync",
      step: SYNC_STEP.entities,
    };
  }
  if (
    ctx.hasTransferQueries &&
    !ctx.requiresQueries &&
    validQueries.length === 0 &&
    enabledBuiltinEntities.length === 0
  ) {
    return {
      message:
        "Enable at least one built-in entity (e.g. Surveys), or add a HogQL query",
      step: SYNC_STEP.entities,
    };
  }
  const reconcileCron = (data.backfillScheduleCron || "").trim();
  if (
    data.backfillScheduleEnabled &&
    reconcileCron.split(" ").filter(Boolean).length < 5
  ) {
    return {
      message:
        "A valid cron expression is required to enable the periodic full reconcile.",
      step: SYNC_STEP.triggers,
    };
  }
  return null;
}

export interface SyncPayloadContext extends SyncSaveContext {
  name: string;
  isNewMode: boolean;
  /** The saved flow being edited, if any. */
  existingFlow?: SavedSyncFlow;
}

/** The create/update body for a validated form. */
export function buildSyncPayload(data: FormData, ctx: SyncPayloadContext) {
  const payload: Record<string, unknown> = {
    name: ctx.name,
    dataSourceId: data.dataSourceId,
    destinationDatabaseId: data.destinationDatabaseId,
    syncMode: data.syncMode,
    writeMode: data.writeMode,
    schedule: data.scheduleEnabled
      ? {
          enabled: true,
          cron: data.scheduleCron.trim(),
          timezone: data.scheduleTimezone || "UTC",
        }
      : { enabled: false },
    queries: data.queries,
  };

  if (data.webhookEnabled) {
    payload.webhookSecret = data.webhookSecret || "";
  }
  // Webhooks on or off: on create when on; on edit only when the user
  // changed it from what the flow has, so a save never switches a sync's
  // webhooks off by accident. The server mints the URL and provisions the
  // subscription on save (adopting one already on the URL).
  const webhookOnNow = Boolean(
    ctx.existingFlow?.webhookConfig?.enabled &&
    ctx.existingFlow?.webhookConfig?.endpoint,
  );
  if (ctx.isNewMode) {
    if (data.webhookEnabled) payload.webhookConfig = { enabled: true };
  } else if (
    ctx.existingFlow &&
    Boolean(data.webhookEnabled) !== webhookOnNow
  ) {
    payload.webhookConfig = { enabled: Boolean(data.webhookEnabled) };
  }
  if (ctx.isCdcCapableDest) {
    payload.deleteMode = ctx.isBigQueryDest
      ? "soft"
      : data.deleteMode || "hard";
    payload.backfillSchedule = {
      enabled: Boolean(data.backfillScheduleEnabled),
      cron: (data.backfillScheduleCron || "").trim(),
      timezone: data.backfillScheduleTimezone || "UTC",
    };
    payload.tableDestination = {
      connectionId: data.destinationDatabaseId,
      schema: data.tableDestination?.schema,
      tableName: data.tableDestination?.tablePrefix || "",
      createIfNotExists: true,
    };
  } else if (data.destinationDatabaseName?.trim()) {
    payload.destinationDatabaseName = data.destinationDatabaseName.trim();
  }

  // Entity selection: staging destinations use the layout table; other
  // destinations use the same enabled-set without layout hints.
  // Hybrid connectors (PostHog) expose built-in entities via layouts AND
  // query-named entities via transferQueries — persist both so surveys
  // stay opt-in while HogQL queries still sync.
  const layouts = data.entityLayouts || [];
  if (ctx.hasTransferQueries) {
    const enabledBuiltins = layouts
      .filter(l => l.enabled !== false)
      .map(l => l.entity);
    const queryEntities = validTransferQueries(data).map(q => q.name.trim());
    payload.entityFilter = [...enabledBuiltins, ...queryEntities];
    if (ctx.layoutMode !== "none" && layouts.length > 0) {
      // entityLayouts take precedence over entityFilter at sync time
      // (resolveConfiguredEntities), and the layout table only knows the
      // data source's built-in entities — flow-level query entities live
      // in transferQueries. Append layout rows for them so they aren't
      // silently dropped from the sync.
      const layoutEntities = new Set(layouts.map(l => l.entity));
      const queryLayouts: EntityLayoutConfig[] = queryEntities
        .filter(name => !layoutEntities.has(name))
        .map(name => ({
          entity: name,
          label: name,
          partitionField: "_syncedAt",
          partitionGranularity: "day",
          clusterFields: ["_dataSourceId", "id"],
          enabled: true,
        }));
      payload.entityLayouts = [...layouts, ...queryLayouts];
    }
  } else {
    const enabledEntities = layouts
      .filter(l => l.enabled !== false)
      .map(l => l.entity);
    const allEnabled =
      enabledEntities.length > 0 && enabledEntities.length === layouts.length;
    payload.entityFilter = allEnabled ? [] : enabledEntities;
    // Layout hints are meaningful for every CDC destination: BQ/CH map
    // them to partition/cluster DDL, PG/Mongo to secondary indexes.
    if (ctx.layoutMode !== "none") {
      payload.entityLayouts = data.entityLayouts;
    }
  }

  return payload;
}
