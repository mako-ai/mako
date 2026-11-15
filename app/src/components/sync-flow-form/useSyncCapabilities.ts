import { useMemo } from "react";
import {
  SYNC_MODE_COMBOS,
  allowedModes,
  effectiveIncrementalMode,
  needsReconcileSuggestion,
  type IncrementalCapabilities,
} from "@mako/schemas";
import {
  useConnectorCatalogStore,
  type WebhookCapabilities,
} from "../../store/connectorCatalogStore";
import type { Flow } from "../../store/flowStore";
import type { TreeNode } from "../../store/schemaStore";
import {
  CDC_CAPABLE_TYPES,
  type EntityLayoutConfig,
  type FormData,
} from "./sync-flow-config";

export interface SyncCapabilitiesInput {
  flows: Flow[];
  databases: Array<{ id: string; name: string; type: string }>;
  connectors: any[];
  availableDatabases: TreeNode[];
  currentFlowId: string | undefined;
  isNewMode: boolean;
  transferQueriesSchema: any;
  watchDataSourceId: string;
  watchDestinationId: string;
  watchWebhookEnabled: boolean;
  watchEntityLayouts: EntityLayoutConfig[];
  watchSyncMode: FormData["syncMode"];
  watchWriteMode: FormData["writeMode"];
}

/**
 * What the selected source and destination support — webhook and
 * incremental capabilities, allowed sync-mode combos, entity layout mode —
 * derived from the connector catalog and the form's current values.
 */
export function useSyncCapabilities({
  flows,
  databases,
  connectors,
  availableDatabases,
  currentFlowId,
  isNewMode,
  transferQueriesSchema,
  watchDataSourceId,
  watchDestinationId,
  watchWebhookEnabled,
  watchEntityLayouts,
  watchSyncMode,
  watchWriteMode,
}: SyncCapabilitiesInput) {
  const connectorTypes = useConnectorCatalogStore(state => state.types);
  const webhookCapabilitiesByType = useMemo(() => {
    const map: Record<string, WebhookCapabilities> = {};
    for (const entry of connectorTypes || []) {
      map[entry.type] = entry.webhook;
    }
    return map;
  }, [connectorTypes]);

  const incrementalCapabilitiesByType = useMemo(() => {
    const map: Record<string, IncrementalCapabilities> = {};
    for (const entry of connectorTypes || []) {
      map[entry.type] = entry.incremental;
    }
    return map;
  }, [connectorTypes]);

  const selectedConnector = connectors.find(ds => ds._id === watchDataSourceId);
  const selectedConnectorType = selectedConnector?.type;
  const selectedWebhookCapabilities = selectedConnectorType
    ? webhookCapabilitiesByType[selectedConnectorType]
    : undefined;
  const connectorSupportsWebhook = Boolean(
    selectedWebhookCapabilities?.supported,
  );
  const provisioning = selectedWebhookCapabilities?.provisioning;
  const canProvisionWebhook =
    !isNewMode && Boolean(currentFlowId) && Boolean(provisioning?.supported);
  const provisionProviderLabel = provisioning?.providerLabel ?? "Provider";
  // Stored by the server when provisioning on save was refused.
  // The saved flow, for the status line (what runs now, not the form's edits).
  const existingFlowForStatus = flows.find(flow => flow._id === currentFlowId);
  const provisionErrorMessage = (
    flows.find(flow => flow._id === currentFlowId)?.webhookConfig as
      { provisionError?: { message?: string } | null } | undefined
  )?.provisionError?.message;
  const webhookSecretHelpText =
    selectedWebhookCapabilities?.secretHelpText ??
    "Enter the webhook signing secret from your provider";

  const selectedIncrementalCapabilities = selectedConnectorType
    ? incrementalCapabilitiesByType[selectedConnectorType]
    : undefined;
  // Which entities Incremental would actually apply to: the ones explicitly
  // enabled in the Entities step, or — before that step has any data (new
  // syncs, or a connector/entity list not loaded yet) — every entity the
  // connector declares a capability override for. Falls back to the
  // connector-level `mode` when neither is available.
  const enabledEntityNames = watchEntityLayouts
    .filter(l => l.enabled !== false)
    .map(l => l.entity)
    .filter(Boolean);
  const incrementalCheckEntities =
    enabledEntityNames.length > 0
      ? enabledEntityNames
      : Object.keys(selectedIncrementalCapabilities?.perEntity || {});
  const incrementalEntityModes = incrementalCheckEntities.length
    ? incrementalCheckEntities.map(entity =>
        effectiveIncrementalMode(selectedIncrementalCapabilities, entity),
      )
    : [selectedIncrementalCapabilities?.mode ?? "none"];
  // Hide "Incremental" entirely once we know NO relevant entity does better
  // than a full re-pull — a silently-full-repulling "Incremental" option is
  // worse than not offering it (see docs/sync-modes-hardening-plan.md,
  // Phase 4). Connectors not yet loaded (selectedIncrementalCapabilities
  // undefined) default to allowed so the dropdown isn't empty mid-load.
  const connectorSupportsIncremental =
    !selectedConnectorType ||
    !selectedIncrementalCapabilities ||
    incrementalEntityModes.some(mode => mode !== "none");
  const incrementalWarning = incrementalEntityModes.includes("created-anchor")
    ? selectedIncrementalCapabilities?.warning
    : undefined;

  const selectedDestination = databases.find(
    db => db.id === watchDestinationId,
  );
  // When editing an existing flow the connections cache may not (yet) contain
  // the destination — fall back to the type populated on the flow itself so
  // destination-dependent UI (reconcile trigger, delete mode, write modes)
  // renders correctly regardless of cache state.
  const editedFlow =
    !isNewMode && currentFlowId
      ? flows.find(f => f._id === currentFlowId)
      : null;
  const editedFlowDestType =
    editedFlow && typeof editedFlow.destinationDatabaseId === "object"
      ? editedFlow.destinationDatabaseId?.type
      : undefined;
  const destType = selectedDestination?.type ?? editedFlowDestType;
  const isBigQueryDest = destType === "bigquery";
  const isCdcCapableDest = CDC_CAPABLE_TYPES.includes(destType || "");
  const hasStagingDest = destType === "bigquery" || destType === "clickhouse";
  // Engine-agnostic layout hints map to each destination's native physical
  // layout: BigQuery/ClickHouse partition+cluster DDL; Postgres/Mongo
  // secondary indexes on the same fields.
  // Shared FE/BE matrix (`@mako/schemas` allowedModes) — SyncFlowForm and
  // validateSyncConfig cannot drift.
  const incrementalCheckEntitiesKey = incrementalCheckEntities.join("\0");
  const modesResult = useMemo(
    () =>
      allowedModes({
        incrementalCap: selectedIncrementalCapabilities,
        selectedEntities: incrementalCheckEntitiesKey
          ? incrementalCheckEntitiesKey.split("\0")
          : [],
        destinationType: isCdcCapableDest ? destType : undefined,
        webhookEnabled: watchWebhookEnabled,
      }),
    [
      selectedIncrementalCapabilities,
      incrementalCheckEntitiesKey,
      isCdcCapableDest,
      destType,
      watchWebhookEnabled,
    ],
  );
  const supportedWriteModes = useMemo(() => {
    const modes = new Set(modesResult.combos.map(c => c.writeMode));
    // Keep current selection visible even when orphaned (handled below).
    return Array.from(modes) as Array<"append_dedup" | "append" | "overwrite">;
  }, [modesResult.combos]);

  // Sync Mode dropdown options: the currently-loaded combo is ALWAYS kept
  // visible, even if it would otherwise be filtered out (e.g. an existing
  // flow saved as Incremental before this connector's capability was known,
  // or before it lost webhook/entity support). Without this, MUI's <Select>
  // can't find a matching MenuItem for the current value and silently
  // renders blank — which looks like the saved mode was lost, even though
  // `formTouchedRef` already protects the underlying value from being
  // rewritten on load. Only NEW selections are restricted to the visible
  // (supported) list.
  const visibleSyncModeCombos =
    !selectedConnectorType || !selectedIncrementalCapabilities
      ? SYNC_MODE_COMBOS.filter(combo =>
          supportedWriteModes.includes(combo.writeMode),
        )
      : modesResult.combos;
  const currentSyncModeValue = `${watchSyncMode}:${watchWriteMode}`;
  const currentSyncModeCombo = SYNC_MODE_COMBOS.find(
    c => c.value === currentSyncModeValue,
  );
  const currentSyncModeIsOrphaned =
    Boolean(currentSyncModeCombo) &&
    !visibleSyncModeCombos.some(c => c.value === currentSyncModeValue);
  const syncModeMenuCombos =
    currentSyncModeIsOrphaned && currentSyncModeCombo
      ? [currentSyncModeCombo, ...visibleSyncModeCombos]
      : visibleSyncModeCombos;
  const suggestReconcile =
    isCdcCapableDest &&
    needsReconcileSuggestion(
      watchSyncMode,
      selectedIncrementalCapabilities,
      incrementalCheckEntities,
    );

  const layoutMode: "partition" | "index" | "none" = hasStagingDest
    ? "partition"
    : destType === "postgresql" ||
        destType === "mongodb" ||
        destType === "mysql"
      ? "index"
      : "none";
  // Checkbox, Entity, Primary Key, Sync (incremental badge), then
  // layout-mode-specific columns (partition/index) or nothing ("none").
  const entityGridTemplate =
    layoutMode === "partition"
      ? "36px minmax(110px, 1.3fr) minmax(70px, 0.6fr) minmax(120px, 0.9fr) minmax(100px, 1fr) 80px minmax(100px, 1fr)"
      : layoutMode === "index"
        ? "36px minmax(110px, 1.3fr) minmax(70px, 0.6fr) minmax(120px, 0.9fr) minmax(100px, 1fr) minmax(100px, 1fr)"
        : "36px minmax(110px, 1.3fr) minmax(70px, 0.6fr) minmax(120px, 0.9fr)";
  // Schema may expose optional transferQueries (PostHog: HogQL optional when
  // syncing built-in entities like surveys) or required ones (GraphQL).
  const hasTransferQueries = !!transferQueriesSchema;
  const requiresQueries = Boolean(transferQueriesSchema?.required);
  const requiresDestinationDatabaseName =
    !isCdcCapableDest && availableDatabases.length > 0;
  // For Full Refresh on a CDC destination, "poll on a cron" and "periodic
  // full reconcile" both mean "run a complete backfill on this cadence" —
  // the same underlying operation exposed as two controls. Collapse to the
  // single reconcile cron below and hide the redundant Scheduled trigger.
  // Poll is always shown and never switched off behind the user's back: a
  // Full Refresh sync whose only trigger is its poll (Sway, WordPress…) must
  // keep it. Redundancy with the full resync is fine.
  const showScheduleTrigger = true;
  const reconcileDescription =
    watchSyncMode === "full" && watchWriteMode === "overwrite"
      ? "Refreshes an exact snapshot each run — additions, edits, and deletions at the source are all reflected."
      : watchWriteMode === "append"
        ? "Appends a full snapshot as new history rows each run."
        : "Upserts every current record on this cadence, reconciling drift. Rows removed at the source are NOT deleted automatically — use Full Refresh | Overwrite, or delete webhooks, to propagate deletions.";

  return {
    webhookCapabilitiesByType,
    incrementalCapabilitiesByType,
    selectedConnector,
    selectedConnectorType,
    selectedWebhookCapabilities,
    connectorSupportsWebhook,
    provisioning,
    canProvisionWebhook,
    provisionProviderLabel,
    existingFlowForStatus,
    provisionErrorMessage,
    webhookSecretHelpText,
    selectedIncrementalCapabilities,
    enabledEntityNames,
    incrementalCheckEntities,
    incrementalEntityModes,
    connectorSupportsIncremental,
    incrementalWarning,
    selectedDestination,
    editedFlow,
    editedFlowDestType,
    destType,
    isBigQueryDest,
    isCdcCapableDest,
    hasStagingDest,
    incrementalCheckEntitiesKey,
    modesResult,
    supportedWriteModes,
    visibleSyncModeCombos,
    currentSyncModeValue,
    currentSyncModeCombo,
    currentSyncModeIsOrphaned,
    syncModeMenuCombos,
    suggestReconcile,
    layoutMode,
    entityGridTemplate,
    hasTransferQueries,
    requiresQueries,
    requiresDestinationDatabaseName,
    showScheduleTrigger,
    reconcileDescription,
  };
}
