/**
 * Unified Sync builder.
 *
 * Replaces the ScheduledFlowForm / WebhookFlowForm split: the trigger set
 * (scheduled poll and/or webhook push) is a property of one Sync, chosen in
 * the last step, instead of a flow "type" picked up-front. Composed from the proven
 * pieces of both legacy forms (destination + schema/prefix, entity layout
 * table, webhook secret/provisioning block, cron presets).
 */
import { useEffect, useState, useMemo, useRef } from "react";
import { useForm, Controller, useFieldArray } from "react-hook-form";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Add as AddIcon,
  ContentCopy as CopyIcon,
  DataObject as DataIcon,
  Delete as DeleteIcon,
  ErrorOutline as ErrorOutlineIcon,
  ExpandMore as ExpandMoreIcon,
  NavigateNext as NextIcon,
  Save as SaveIcon,
  Storage as DatabaseIcon,
  Webhook as WebhookIcon,
} from "@mui/icons-material";
import {
  SYNC_MODE_COMBOS,
  allowedModes,
  effectiveIncrementalMode,
  needsReconcileSuggestion,
  type IncrementalCapabilities,
} from "@mako/schemas";
import { useWorkspace } from "../contexts/workspace-context";
import { useFlowStore } from "../store/flowStore";
import { useSchemaStore, type TreeNode } from "../store/schemaStore";
import {
  useConnectorCatalogStore,
  type WebhookCapabilities,
} from "../store/connectorCatalogStore";
import {
  useAvailableEntitiesStore,
  flattenConnectorEntities,
  type FlattenedConnectorEntity,
} from "../store/availableEntitiesStore";
import { trackEvent } from "../lib/analytics";
import { FlowRunNotificationsSection } from "./FlowRunNotificationsSection";
import { useConfirm } from "./ConfirmDialog";

interface SyncFlowFormProps {
  flowId?: string;
  isNew?: boolean;
  onSave?: () => void;
  onSaved?: (
    flowId: string,
    options?: { showBackfillPanel?: boolean; notice?: string },
  ) => void;
  onCancel?: () => void;
  /** New-sync flow only: user picked "Database query" as the source. */
  onSwitchToDbSync?: () => void;
}

interface EntityLayoutConfig {
  entity: string;
  label?: string;
  partitionField: string;
  partitionGranularity: "day" | "hour" | "month" | "year";
  clusterFields: string[];
  enabled?: boolean;
}

interface TransferQuery {
  name: string;
  query: string;
  data_path?: string;
  total_count_path?: string;
  has_next_page_path?: string;
  cursor_path?: string;
  batch_size?: number;
}

interface TransferQueryField {
  name: keyof TransferQuery;
  label: string;
  type: "string" | "number" | "textarea";
  required?: boolean;
  default?: string | number;
  placeholder?: string;
  helperText?: string;
  rows?: number;
}

interface FormData {
  dataSourceId: string;
  destinationDatabaseId: string;
  destinationDatabaseName?: string;
  tableDestination?: {
    tablePrefix?: string;
    schema?: string;
  };
  // Trigger set
  scheduleEnabled: boolean;
  scheduleCron: string;
  scheduleTimezone: string;
  webhookEnabled: boolean;
  webhookSecret?: string;
  // Sync configuration
  syncMode: "full" | "incremental";
  writeMode: "append_dedup" | "append" | "overwrite";
  deleteMode?: "hard" | "soft";
  backfillScheduleEnabled?: boolean;
  backfillScheduleCron?: string;
  backfillScheduleTimezone?: string;
  // Entities
  entityFilter: string[];
  entityLayouts?: EntityLayoutConfig[];
  queries: TransferQuery[];
}

const SYNC_ENGINE_PERMISSION_ERROR =
  "The sync was saved, but changing the sync engine requires the workspace Owner or Admin role. Ask an admin to upgrade your role, then save again.";

const SYSTEM_ENTITY_FIELDS = ["_syncedAt", "_dataSourceId", "id"];

const CDC_CAPABLE_TYPES = [
  "bigquery",
  "postgresql",
  "clickhouse",
  "mongodb",
  "mysql",
];

const SCHEDULE_PRESETS = [
  { label: "Every 5 minutes", cron: "*/5 * * * *" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every 30 minutes", cron: "*/30 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily at midnight", cron: "0 0 * * *" },
  { label: "Daily at 6 AM", cron: "0 6 * * *" },
  { label: "Weekly on Sunday", cron: "0 0 * * 0" },
  { label: "Monthly on 1st", cron: "0 0 1 * *" },
];

/**
 * Airbyte-style per-entity incremental badge — mirrors backend
 * `IncrementalMode` (BaseConnector.getIncrementalCapabilities). Shown in the
 * Entities table regardless of the currently-selected Sync Mode so users can
 * see stream-level capability before deciding.
 */
const INCREMENTAL_MODE_BADGE: Record<
  string,
  { label: string; color: "success" | "info" | "warning" | "default" }
> = {
  native: { label: "Incremental", color: "success" },
  "client-filter": { label: "Incremental (full scan)", color: "info" },
  "created-anchor": { label: "New records only", color: "warning" },
  none: { label: "Full re-pull only", color: "default" },
};

const STEPS = [
  { label: "Source", description: "Where the data comes from" },
  { label: "Destination", description: "Where the data is written" },
  {
    label: "Sync Configuration",
    description: "Sync mode and delete behavior",
  },
  { label: "Entities", description: "What data is synced" },
  {
    label: "Triggers",
    description:
      "How the sync is triggered — schedule, webhook, or periodic reconcile",
  },
];

export function SyncFlowForm({
  flowId,
  isNew = false,
  onSave,
  onSaved,
  onCancel,
  onSwitchToDbSync,
}: SyncFlowFormProps) {
  const { currentWorkspace } = useWorkspace();
  const confirm = useConfirm();
  const {
    flows: flowsMap,
    error: errorMap,
    createFlow,
    updateFlow,
    setSyncEngine,
    clearError,
    deleteFlow,
    fetchConnectors,
    provisionFlowWebhook,
    resyncCdcFlow,
  } = useFlowStore();

  const connectorTypes = useConnectorCatalogStore(state => state.types);
  const fetchCatalog = useConnectorCatalogStore(state => state.fetchCatalog);
  const fetchSchema = useConnectorCatalogStore(state => state.fetchSchema);

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

  const flows = useMemo(
    () => (currentWorkspace ? flowsMap[currentWorkspace.id] || [] : []),
    [currentWorkspace, flowsMap],
  );
  const storeError = currentWorkspace
    ? errorMap[currentWorkspace.id] || null
    : null;
  const connectionsMap = useSchemaStore(state => state.connections);
  const ensureConnections = useSchemaStore(state => state.ensureConnections);
  const ensureTreeRoot = useSchemaStore(state => state.ensureTreeRoot);
  const databases = useMemo(
    () => (currentWorkspace ? connectionsMap[currentWorkspace.id] || [] : []),
    [currentWorkspace, connectionsMap],
  );

  const [connectors, setConnectors] = useState<any[]>([]);
  const [isLoadingConnectors, setIsLoadingConnectors] = useState(false);
  const [availableDatabases, setAvailableDatabases] = useState<TreeNode[]>([]);
  const [webhookUrl, setWebhookUrl] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isProvisioningWebhook, setIsProvisioningWebhook] = useState(false);
  /** Keep Triggers expanded after create until the user can see provision result. */
  const [pinTriggersOpen, setPinTriggersOpen] = useState(false);
  const [webhookProvisionSucceeded, setWebhookProvisionSucceeded] =
    useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentFlowId, setCurrentFlowId] = useState<string | undefined>(
    flowId,
  );
  const [isNewMode, setIsNewMode] = useState(isNew);
  const [entityMetadata, setEntityMetadata] = useState<
    FlattenedConnectorEntity[]
  >([]);
  const [openSteps, setOpenSteps] = useState<Set<number>>(new Set([0]));
  const [scheduleCronMode, setScheduleCronMode] = useState<"preset" | "custom">(
    "preset",
  );
  const [pendingLayoutReset, setPendingLayoutReset] = useState<{
    data: FormData;
    entities: string[];
  } | null>(null);
  const [transferQueriesSchema, setTransferQueriesSchema] = useState<any>(null);
  // Guards the two auto-correction effects below (Incremental capability
  // downgrade, hidden-schedule collapse) so they never silently rewrite an
  // EXISTING flow's already-saved mode on load — only in reaction to the
  // user's own subsequent changes (Sync Mode select, entity toggles) during
  // this editing session. Without this, the connector capability catalog
  // resolving asynchronously after mount (a real network round trip, not a
  // same-tick event) would look identical to a user-driven change and could
  // downgrade a currently-working saved flow the instant it's opened — the
  // exact "must not break already-tested CDC/backfill flows" regression this
  // guards against. Reset to false whenever a different existing flow loads;
  // always "touched" for brand-new flows (nothing saved to protect there).
  const formTouchedRef = useRef(isNew);
  const reconcileAutoEnabledRef = useRef(false);

  const toggleStep = (stepIndex: number) => {
    // Keep Triggers open while provisioning, and after success until the
    // user dismisses the confirmation (pinTriggersOpen). Failures stay open
    // but can be collapsed once the error is visible (!isProvisioningWebhook).
    if (stepIndex === 4 && openSteps.has(4)) {
      if (isProvisioningWebhook) return;
      if (pinTriggersOpen && !error) return;
    }
    setOpenSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepIndex)) {
        next.delete(stepIndex);
        if (stepIndex === 4) setPinTriggersOpen(false);
      } else {
        next.add(stepIndex);
      }
      return next;
    });
  };

  const openNextStep = (currentStep: number) => {
    setOpenSteps(prev => {
      const next = new Set(prev);
      if (currentStep + 1 < STEPS.length) next.add(currentStep + 1);
      next.delete(currentStep);
      return next;
    });
  };

  const {
    control,
    handleSubmit,
    formState: { errors },
    reset,
    watch,
    getValues,
    setValue,
  } = useForm<FormData>({
    defaultValues: {
      dataSourceId: "",
      destinationDatabaseId: "",
      destinationDatabaseName: "",
      tableDestination: { tablePrefix: "", schema: "" },
      scheduleEnabled: true,
      scheduleCron: "0 * * * *",
      scheduleTimezone:
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      webhookEnabled: false,
      webhookSecret: "",
      syncMode: "incremental",
      writeMode: "append_dedup",
      deleteMode: "hard",
      backfillScheduleEnabled: false,
      backfillScheduleCron: "0 3 * * *",
      backfillScheduleTimezone: "UTC",
      entityFilter: [],
      entityLayouts: [],
      queries: [],
    },
  });

  const watchDataSourceId = watch("dataSourceId");
  const watchDestinationId = watch("destinationDatabaseId");
  const watchScheduleEnabled = watch("scheduleEnabled");
  const watchScheduleCron = watch("scheduleCron");
  const watchWebhookEnabled = watch("webhookEnabled");
  const watchEntityLayouts = watch("entityLayouts") || [];
  const watchDeleteMode = watch("deleteMode");
  const watchBackfillScheduleEnabled = watch("backfillScheduleEnabled");
  const watchSyncMode = watch("syncMode");
  const watchWriteMode = watch("writeMode");

  const {
    fields: queryFields,
    append: appendQuery,
    remove: removeQuery,
  } = useFieldArray({ control, name: "queries" });

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
  const showScheduleTrigger = !(isCdcCapableDest && watchSyncMode === "full");
  const reconcileDescription =
    watchSyncMode === "full" && watchWriteMode === "overwrite"
      ? "Refreshes an exact snapshot each run — additions, edits, and deletions at the source are all reflected."
      : watchWriteMode === "append"
        ? "Appends a full snapshot as new history rows each run."
        : "Upserts every current record on this cadence, reconciling drift. Rows removed at the source are NOT deleted automatically — use Full Refresh | Overwrite, or delete webhooks, to propagate deletions.";

  useEffect(() => {
    if (isBigQueryDest && watchDeleteMode !== "soft") {
      setValue("deleteMode", "soft");
    }
  }, [isBigQueryDest, setValue, watchDeleteMode]);

  // Overwrite cannot be combined with a webhook trigger (the stream would
  // race the truncation) — fall back to the deduped default.
  useEffect(() => {
    if (watchWebhookEnabled && watchWriteMode === "overwrite") {
      setValue("syncMode", "incremental");
      setValue("writeMode", "append_dedup");
    }
  }, [watchWebhookEnabled, watchWriteMode, setValue]);

  // Destinations that only support dedup (ClickHouse / legacy) force it.
  useEffect(() => {
    if (destType && !supportedWriteModes.includes(watchWriteMode)) {
      setValue("writeMode", "append_dedup");
    }
    // supportedWriteModes derives from destType
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destType, watchWriteMode, setValue]);

  // Webhook trigger requires a webhook-capable connector; auto-disable when
  // the user switches to a pull-only connector.
  useEffect(() => {
    if (
      watchWebhookEnabled &&
      selectedConnectorType &&
      !connectorSupportsWebhook
    ) {
      setValue("webhookEnabled", false);
    }
  }, [
    watchWebhookEnabled,
    selectedConnectorType,
    connectorSupportsWebhook,
    setValue,
  ]);

  // The Scheduled trigger is hidden (see showScheduleTrigger) once Full
  // Refresh + a CDC destination make it redundant with the reconcile cron —
  // disable it too so it doesn't keep firing invisibly in the background.
  useEffect(() => {
    if (
      !showScheduleTrigger &&
      watchScheduleEnabled &&
      formTouchedRef.current
    ) {
      setValue("scheduleEnabled", false);
    }
  }, [showScheduleTrigger, watchScheduleEnabled, setValue]);

  // Incremental requires at least one selected entity to do better than a
  // full re-pull; fall back to Full Refresh | Deduped when the connector (or
  // the current entity selection) can't support it.
  useEffect(() => {
    if (
      watchSyncMode === "incremental" &&
      selectedConnectorType &&
      !connectorSupportsIncremental &&
      formTouchedRef.current
    ) {
      setValue("syncMode", "full");
      setValue("writeMode", "append_dedup");
    }
  }, [
    watchSyncMode,
    selectedConnectorType,
    connectorSupportsIncremental,
    setValue,
  ]);

  // Auto-suggest (and once soft-enable) periodic reconcile for Incremental
  // flows whose selected entities are created-anchor or none — polls alone
  // cannot catch updates / will silent-full-repull those streams.
  useEffect(() => {
    if (!suggestReconcile || !formTouchedRef.current) return;
    if (watchBackfillScheduleEnabled) return;
    if (reconcileAutoEnabledRef.current) return;
    reconcileAutoEnabledRef.current = true;
    setValue("backfillScheduleEnabled", true, { shouldDirty: true });
    const cron = getValues("backfillScheduleCron");
    if (!cron) {
      setValue("backfillScheduleCron", "0 3 * * *", { shouldDirty: true });
    }
    const tz = getValues("backfillScheduleTimezone");
    if (!tz) {
      setValue("backfillScheduleTimezone", "UTC", { shouldDirty: true });
    }
  }, [suggestReconcile, watchBackfillScheduleEnabled, setValue, getValues]);

  // transferQueries schema (GraphQL/PostHog-style connectors).
  // Stale-while-revalidate: show the persisted cache immediately, but always
  // refetch — the cache lives in localStorage, so schema changes (e.g.
  // transferQueries.required flipping) would otherwise never reach the form.
  useEffect(() => {
    if (!selectedConnectorType) {
      setTransferQueriesSchema(null);
      return;
    }
    const cachedSchema =
      useConnectorCatalogStore.getState().schemas[selectedConnectorType];
    if (cachedSchema) {
      setTransferQueriesSchema(cachedSchema.transferQueries ?? null);
    }
    fetchSchema(selectedConnectorType, true).then(schema => {
      if (schema) {
        setTransferQueriesSchema(schema.transferQueries ?? null);
      } else if (!cachedSchema) {
        setTransferQueriesSchema(null);
      }
    });
  }, [selectedConnectorType, fetchSchema]);

  // Multi-database servers (non-CDC destinations): list databases to pick one.
  useEffect(() => {
    const loadDatabases = async () => {
      if (!watchDestinationId || !currentWorkspace?.id) {
        setAvailableDatabases([]);
        return;
      }
      try {
        const nodes = await ensureTreeRoot(
          currentWorkspace.id,
          watchDestinationId,
        );
        setAvailableDatabases(nodes.filter(node => node.kind === "database"));
      } catch {
        setAvailableDatabases([]);
      }
    };
    void loadDatabases();
  }, [watchDestinationId, currentWorkspace?.id, ensureTreeRoot]);

  // Entity metadata + layout defaults (schema-driven, connector-agnostic).
  useEffect(() => {
    if (
      !watchDataSourceId ||
      connectors.length === 0 ||
      !currentWorkspace?.id
    ) {
      return;
    }
    let cancelled = false;
    (async () => {
      const list = await useAvailableEntitiesStore
        .getState()
        .fetch(currentWorkspace.id, watchDataSourceId);
      if (cancelled) return;
      const entities = flattenConnectorEntities(list);
      setEntityMetadata(entities);

      const existingFlow =
        !isNewMode && currentFlowId
          ? flows.find(j => j._id === currentFlowId)
          : null;
      const savedLayouts: EntityLayoutConfig[] =
        existingFlow?.entityLayouts || getValues("entityLayouts") || [];
      const savedByEntity = new Map(
        savedLayouts.map((l: EntityLayoutConfig) => [l.entity, l]),
      );
      const savedFilter: string[] =
        existingFlow?.entityFilter || getValues("entityFilter") || [];
      setValue(
        "entityLayouts",
        entities.map(e => {
          const saved = savedByEntity.get(e.name);
          if (saved) {
            return {
              ...saved,
              label: e.label,
              enabled: saved.enabled !== false,
            };
          }
          // When editing a flow without saved layouts, respect its
          // entityFilter; new syncs enable everything by default.
          const enabled =
            savedFilter.length === 0 || savedFilter.includes(e.name);
          return {
            entity: e.name,
            label: e.label,
            partitionField: e.partitionField,
            partitionGranularity: e.partitionGranularity,
            clusterFields: e.clusterFields,
            enabled,
          };
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchDataSourceId, connectors, currentWorkspace?.id]);

  // Load connectors + connections + catalog.
  useEffect(() => {
    if (!currentWorkspace?.id) return;
    (async () => {
      setIsLoadingConnectors(true);
      try {
        const sources = await fetchConnectors(currentWorkspace.id);
        setConnectors(sources || []);
      } catch {
        setError("Failed to load source connections");
      } finally {
        setIsLoadingConnectors(false);
      }
    })();
    ensureConnections(currentWorkspace.id);
    fetchCatalog(currentWorkspace.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id]);

  // Load existing flow into the form.
  useEffect(() => {
    if (isNewMode || !currentFlowId || flows.length === 0) return;
    const flow = flows.find(j => j._id === currentFlowId);
    if (!flow) return;

    const dataSourceId =
      typeof flow.dataSourceId === "string"
        ? flow.dataSourceId
        : flow.dataSourceId?._id;
    const destinationDatabaseId =
      typeof flow.destinationDatabaseId === "string"
        ? flow.destinationDatabaseId
        : flow.destinationDatabaseId?._id;

    const hasWebhookTrigger = Boolean(
      flow.webhookConfig?.enabled && flow.webhookConfig?.endpoint,
    );
    const hasScheduleTrigger = Boolean(
      flow.schedule?.enabled && flow.schedule?.cron,
    );

    const formData: FormData = {
      dataSourceId: dataSourceId || "",
      destinationDatabaseId: destinationDatabaseId || "",
      destinationDatabaseName: flow.destinationDatabaseName || "",
      scheduleEnabled: hasScheduleTrigger,
      scheduleCron: flow.schedule?.cron || "0 * * * *",
      scheduleTimezone: flow.schedule?.timezone || "UTC",
      webhookEnabled: hasWebhookTrigger,
      // Prefer the server secret when present. If a flows refresh races with
      // one-click provisioning (secret just set in the form, not yet visible
      // on the list payload), keep the in-form value instead of blanking it.
      webhookSecret:
        flow.webhookConfig?.secret || getValues("webhookSecret") || "",
      syncMode: (flow.syncMode as "full" | "incremental") || "full",
      writeMode:
        (flow.writeMode as "append_dedup" | "append" | "overwrite") ||
        "append_dedup",
      deleteMode: flow.deleteMode || "hard",
      backfillScheduleEnabled: flow.backfillSchedule?.enabled ?? false,
      backfillScheduleCron: flow.backfillSchedule?.cron || "0 3 * * *",
      backfillScheduleTimezone: flow.backfillSchedule?.timezone || "UTC",
      entityFilter: flow.entityFilter || [],
      entityLayouts: (flow.entityLayouts || []).map((l: any) => ({
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
    if (flow.webhookConfig?.endpoint) {
      setWebhookUrl(flow.webhookConfig.endpoint);
    }

    setScheduleCronMode(
      SCHEDULE_PRESETS.some(p => p.cron === formData.scheduleCron)
        ? "preset"
        : "custom",
    );
    formTouchedRef.current = false;
    reset(formData);
  }, [isNewMode, currentFlowId, flows, reset, getValues]);

  useEffect(() => {
    return () => {
      if (currentWorkspace?.id) clearError(currentWorkspace.id);
    };
  }, [clearError, currentWorkspace?.id]);

  // Layout changes on an existing flow require destination table rebuilds.
  const getLayoutChangedEntities = (data: FormData): string[] => {
    if (isNewMode || !currentFlowId) return [];
    const flow = flows.find(f => f._id === currentFlowId);
    const saved = new Map(
      (flow?.entityLayouts || []).map((l: EntityLayoutConfig) => [l.entity, l]),
    );
    const sortedFields = (fields?: string[]) =>
      JSON.stringify([...(fields || [])].sort());
    const changed: string[] = [];
    for (const layout of data.entityLayouts || []) {
      if (layout.enabled === false) continue;
      const prev = saved.get(layout.entity);
      if (!prev || prev.enabled === false) continue;
      const partitionChanged =
        (prev.partitionField || "") !== (layout.partitionField || "") ||
        (prev.partitionGranularity || "") !==
          (layout.partitionGranularity || "");
      const clusterChanged =
        sortedFields(prev.clusterFields) !== sortedFields(layout.clusterFields);
      if (partitionChanged || clusterChanged) changed.push(layout.entity);
    }
    return changed;
  };

  const onSubmit = async (data: FormData) => {
    const changedEntities = hasStagingDest
      ? getLayoutChangedEntities(data)
      : [];
    if (changedEntities.length > 0) {
      setPendingLayoutReset({ data, entities: changedEntities });
      return;
    }
    await executeSave(data, {});
  };

  const executeSave = async (
    data: FormData,
    opts: { resetEntities?: string[] },
  ) => {
    if (!currentWorkspace?.id) {
      setError("No workspace selected");
      return;
    }

    // Trigger-set validation. The periodic full reconcile is a real trigger
    // (migrated legacy full-refresh syncs run on it exclusively), but it only
    // exists for CDC-capable destinations.
    const hasReconcileTrigger =
      isCdcCapableDest && Boolean(data.backfillScheduleEnabled);
    if (!data.scheduleEnabled && !data.webhookEnabled && !hasReconcileTrigger) {
      setError(
        "Enable at least one trigger — a schedule, a webhook, or a periodic full reconcile.",
      );
      setOpenSteps(prev => new Set([...prev, 4]));
      return;
    }
    if (data.scheduleEnabled && !data.scheduleCron.trim()) {
      setError("A cron expression is required for the scheduled trigger.");
      setOpenSteps(prev => new Set([...prev, 4]));
      return;
    }
    if (data.webhookEnabled && !connectorSupportsWebhook) {
      setError("This connector does not provide webhooks — use a schedule.");
      setOpenSteps(prev => new Set([...prev, 4]));
      return;
    }
    if (data.webhookEnabled && !isCdcCapableDest) {
      setError(
        "Webhook-triggered syncs require a CDC-capable destination (BigQuery, PostgreSQL, ClickHouse, MongoDB, or MySQL).",
      );
      setOpenSteps(prev => new Set([...prev, 1]));
      return;
    }
    if (isCdcCapableDest && !data.tableDestination?.schema?.trim()) {
      setError(
        isBigQueryDest
          ? "A destination dataset is required."
          : "A destination schema is required.",
      );
      setOpenSteps(prev => new Set([...prev, 1]));
      return;
    }
    if (
      requiresDestinationDatabaseName &&
      !data.destinationDatabaseName?.trim()
    ) {
      setError(
        "Please select a destination database within the selected server.",
      );
      setOpenSteps(prev => new Set([...prev, 1]));
      return;
    }
    const validQueries = (data.queries || []).filter(
      q =>
        typeof q?.name === "string" &&
        q.name.trim().length > 0 &&
        typeof q?.query === "string" &&
        q.query.trim().length > 0,
    );
    const enabledBuiltinEntities = (data.entityLayouts || []).filter(
      l => l.enabled !== false,
    );
    if (requiresQueries && validQueries.length === 0) {
      setError("Please add at least one query to define what data to sync");
      setOpenSteps(prev => new Set([...prev, 3]));
      return;
    }
    if (
      hasTransferQueries &&
      !requiresQueries &&
      validQueries.length === 0 &&
      enabledBuiltinEntities.length === 0
    ) {
      setError(
        "Enable at least one built-in entity (e.g. Surveys), or add a HogQL query",
      );
      setOpenSteps(prev => new Set([...prev, 3]));
      return;
    }
    const backfillSchedule = {
      enabled: Boolean(data.backfillScheduleEnabled),
      cron: (data.backfillScheduleCron || "").trim(),
      timezone: data.backfillScheduleTimezone || "UTC",
    };
    if (
      backfillSchedule.enabled &&
      backfillSchedule.cron.split(" ").filter(Boolean).length < 5
    ) {
      setError(
        "A valid cron expression is required to enable the periodic full reconcile.",
      );
      setOpenSteps(prev => new Set([...prev, 4]));
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const selectedSource = connectors.find(
        ds => ds._id === data.dataSourceId,
      );
      const selectedDatabase = databases.find(
        db => db.id === data.destinationDatabaseId,
      );
      const generatedName = `${selectedSource?.name || "Source"} → ${selectedDatabase?.name || "Destination"}`;

      // Back-compat `type`: webhook-only syncs are "webhook"; anything with a
      // poll schedule is "scheduled" — EXCEPT hybrids, which must stay
      // "webhook" so the inbound webhook receiver (type-keyed) accepts events.
      // The backend persists the schedule for webhook flows under the flag.
      const flowType = data.webhookEnabled ? "webhook" : "scheduled";

      const payload: any = {
        name: generatedName,
        type: flowType,
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
      if (isCdcCapableDest) {
        payload.deleteMode = isBigQueryDest
          ? "soft"
          : data.deleteMode || "hard";
        payload.backfillSchedule = backfillSchedule;
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
      if (hasTransferQueries) {
        const enabledBuiltins = (data.entityLayouts || [])
          .filter(l => l.enabled !== false)
          .map(l => l.entity);
        const queryEntities = validQueries.map(q => q.name.trim());
        payload.entityFilter = [...enabledBuiltins, ...queryEntities];
        if (layoutMode !== "none" && (data.entityLayouts || []).length > 0) {
          // entityLayouts take precedence over entityFilter at sync time
          // (resolveConfiguredEntities), and the layout table only knows the
          // data source's built-in entities — flow-level query entities live
          // in transferQueries. Append layout rows for them so they aren't
          // silently dropped from the sync.
          const layoutEntities = new Set(
            (data.entityLayouts || []).map(l => l.entity),
          );
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
          payload.entityLayouts = [
            ...(data.entityLayouts || []),
            ...queryLayouts,
          ];
        }
      } else {
        const enabledEntities = (data.entityLayouts || [])
          .filter(l => l.enabled !== false)
          .map(l => l.entity);
        const allEnabled =
          enabledEntities.length > 0 &&
          enabledEntities.length === (data.entityLayouts || []).length;
        payload.entityFilter = allEnabled ? [] : enabledEntities;
        // Layout hints are meaningful for every CDC destination: BQ/CH map
        // them to partition/cluster DDL, PG/Mongo to secondary indexes.
        if (layoutMode !== "none") {
          payload.entityLayouts = data.entityLayouts;
        }
      }

      if (isNewMode) {
        const newFlow = await createFlow(currentWorkspace.id, payload);
        trackEvent("flow_created", {
          flow_type: flowType,
          connector_type: selectedSource?.type,
          triggers: [
            ...(data.scheduleEnabled ? ["schedule"] : []),
            ...(data.webhookEnabled ? ["webhook"] : []),
            ...(isCdcCapableDest && data.backfillScheduleEnabled
              ? ["reconcile"]
              : []),
          ].join("+"),
        });
        await useFlowStore.getState().fetchFlows(currentWorkspace.id);
        setIsNewMode(false);
        setCurrentFlowId(newFlow._id);
        onSaved?.(newFlow._id);
        reset(data);
        onSave?.();

        // Triggers is last: stay on it after create so webhook URL/secret are
        // visible. Pin open until provisioning finishes (or URL is shown).
        if (data.webhookEnabled) {
          setPinTriggersOpen(true);
          setWebhookProvisionSucceeded(false);
          setOpenSteps(new Set([4]));
          if (provisioning?.supported) {
            const ok = await provisionWebhookForFlow(newFlow._id);
            if (ok) {
              setWebhookProvisionSucceeded(true);
            }
          }
        }
      } else if (currentFlowId) {
        await updateFlow(currentWorkspace.id, currentFlowId, payload);

        // Webhook-triggered syncs must run on the CDC engine.
        const currentEngine =
          flows.find(flow => flow._id === currentFlowId)?.syncEngine ??
          "legacy";
        if (data.webhookEnabled && currentEngine !== "cdc") {
          const ok = await setSyncEngine(
            currentWorkspace.id,
            currentFlowId,
            "cdc",
          );
          if (!ok) {
            await useFlowStore.getState().fetchFlows(currentWorkspace.id);
            setError(SYNC_ENGINE_PERMISSION_ERROR);
            return;
          }
        }
        await useFlowStore.getState().fetchFlows(currentWorkspace.id);

        if (opts.resetEntities && opts.resetEntities.length > 0) {
          await resyncCdcFlow(currentWorkspace.id, currentFlowId, {
            deleteDestination: true,
            entities: opts.resetEntities,
          });
          onSaved?.(currentFlowId, {
            showBackfillPanel: true,
            notice: `Repartition job queued for ${opts.resetEntities.join(", ")}. Watch the Stream column for progress.`,
          });
        } else {
          onSaved?.(currentFlowId);
        }
        reset(data);
        onSave?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save sync");
    } finally {
      setIsSubmitting(false);
    }
  };

  const provisionWebhookForFlow = async (
    flowIdToProvision: string,
  ): Promise<boolean> => {
    if (!currentWorkspace?.id) {
      setError("Save the sync first before creating the provider webhook");
      return false;
    }
    setIsProvisioningWebhook(true);
    setError(null);
    setWebhookProvisionSucceeded(false);
    try {
      const publicBaseUrl =
        typeof window !== "undefined" ? window.location.origin : undefined;
      const provisioned = await provisionFlowWebhook(
        currentWorkspace.id,
        flowIdToProvision,
        { verifySsl: true, publicBaseUrl },
      );
      if (!provisioned) {
        throw new Error("Webhook provisioning returned no data");
      }
      if (provisioned.endpoint) setWebhookUrl(provisioned.endpoint);
      if (provisioned.webhookSecret) {
        setValue("webhookSecret", provisioned.webhookSecret, {
          shouldDirty: true,
        });
      }
      await useFlowStore.getState().fetchFlows(currentWorkspace.id);
      // fetchFlows triggers the flows→reset useEffect. Re-apply after that
      // paint so a missing/racy list secret can't wipe the provisioned value.
      if (provisioned.webhookSecret) {
        const secret = provisioned.webhookSecret;
        setTimeout(() => {
          setValue("webhookSecret", secret, {
            shouldDirty: true,
          });
        }, 0);
      }
      return Boolean(provisioned.endpoint && provisioned.webhookSecret);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Failed to create webhook in ${provisionProviderLabel}`,
      );
      return false;
    } finally {
      setIsProvisioningWebhook(false);
    }
  };

  const handleProvisionWebhook = async () => {
    if (!currentFlowId) {
      setError("Save the sync first before creating the provider webhook");
      return;
    }
    setPinTriggersOpen(true);
    setOpenSteps(prev => new Set([...prev, 4]));
    const ok = await provisionWebhookForFlow(currentFlowId);
    if (ok) {
      setWebhookProvisionSucceeded(true);
    }
  };

  const stepHasError = (stepIndex: number): boolean => {
    switch (stepIndex) {
      case 0:
        return !!errors.dataSourceId;
      case 1:
        return (
          !!errors.destinationDatabaseId || !!errors.tableDestination?.schema
        );
      default:
        return false;
    }
  };

  const handleFormSubmit = handleSubmit(onSubmit, fieldErrors => {
    const errorStepFields: string[][] = [
      ["dataSourceId"],
      ["destinationDatabaseId", "tableDestination", "destinationDatabaseName"],
      [],
      [],
      ["scheduleCron"],
    ];
    const firstErrorStep = errorStepFields.findIndex(fields =>
      fields.some(f => f in fieldErrors),
    );
    if (firstErrorStep >= 0) {
      setOpenSteps(prev => new Set([...prev, firstErrorStep]));
    }
  });

  const renderStepHeader = (stepIndex: number) => (
    <AccordionSummary
      expandIcon={<ExpandMoreIcon />}
      sx={{
        "& .MuiAccordionSummary-content": { alignItems: "center", gap: 1 },
      }}
    >
      <Typography
        sx={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          bgcolor: "primary.main",
          color: "primary.contrastText",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "0.75rem",
          fontWeight: "bold",
          flexShrink: 0,
        }}
      >
        {stepIndex + 1}
      </Typography>
      {stepHasError(stepIndex) && (
        <ErrorOutlineIcon color="error" sx={{ fontSize: 16 }} />
      )}
      <Box>
        <Typography variant="subtitle2">{STEPS[stepIndex].label}</Typography>
        <Typography variant="caption" color="text.secondary">
          {STEPS[stepIndex].description}
        </Typography>
      </Box>
    </AccordionSummary>
  );

  const cronPresetValue = SCHEDULE_PRESETS.some(
    p => p.cron === watchScheduleCron,
  )
    ? watchScheduleCron
    : "__custom__";

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Dialog
        open={pendingLayoutReset !== null}
        onClose={() => !isSubmitting && setPendingLayoutReset(null)}
      >
        <DialogTitle>Rebuild destination tables?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            You changed the partition or cluster layout for{" "}
            <strong>{pendingLayoutReset?.entities.join(", ")}</strong>. These
            settings are fixed when a destination table is created, so the
            table(s) must be rebuilt for the change to take effect.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setPendingLayoutReset(null)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            color="warning"
            variant="contained"
            disabled={isSubmitting}
            onClick={async () => {
              const pending = pendingLayoutReset;
              if (!pending) return;
              setPendingLayoutReset(null);
              await executeSave(pending.data, {
                resetEntities: pending.entities,
              });
            }}
          >
            {isSubmitting ? "Rebuilding..." : "Save & rebuild tables"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Top bar */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 2,
          py: 1,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        {!isNewMode && currentFlowId && (
          <Button
            color="error"
            size="small"
            startIcon={<DeleteIcon />}
            onClick={async () => {
              if (
                !(await confirm({
                  title: "Are you sure you want to delete this sync?",
                  confirmLabel: "Delete",
                  destructive: true,
                }))
              ) {
                return;
              }
              if (currentWorkspace?.id) {
                try {
                  await deleteFlow(currentWorkspace.id, currentFlowId);
                  onCancel?.();
                } catch {
                  setError("Failed to delete sync");
                }
              }
            }}
            disabled={isSubmitting}
          >
            Delete
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Box sx={{ display: "flex", gap: 1 }}>
          {onCancel && (
            <Button size="small" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
          )}
          <Button
            type="submit"
            variant="contained"
            size="small"
            startIcon={isNewMode ? <AddIcon /> : <SaveIcon />}
            disabled={isSubmitting}
            onClick={handleFormSubmit}
          >
            {isNewMode ? "Create" : "Save"}
          </Button>
        </Box>
      </Box>

      {/* Main content */}
      <Box sx={{ flex: 1, overflow: "auto", p: { xs: 2, sm: 3 } }}>
        <Box sx={{ maxWidth: "800px", mx: "auto" }}>
          {(error || storeError) && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error || storeError}
            </Alert>
          )}

          {currentFlowId && (
            <Typography variant="body1" sx={{ mb: 2 }}>
              <strong>Sync ID:</strong> {currentFlowId}
            </Typography>
          )}

          <form onSubmit={handleFormSubmit}>
            {/* Step 1: Source */}
            <Accordion
              expanded={openSteps.has(0)}
              onChange={() => toggleStep(0)}
              sx={{ mb: 1 }}
            >
              {renderStepHeader(0)}
              <AccordionDetails>
                <Stack spacing={3}>
                  <Controller
                    name="dataSourceId"
                    control={control}
                    rules={{ required: "Source connection is required" }}
                    render={({ field }) => (
                      <FormControl fullWidth error={!!errors.dataSourceId}>
                        <InputLabel>Source connection</InputLabel>
                        <Select
                          {...field}
                          label="Source connection"
                          startAdornment={
                            <DataIcon sx={{ mr: 1, color: "action.active" }} />
                          }
                          disabled={isLoadingConnectors || !isNewMode}
                        >
                          {connectors.map(source => (
                            <MenuItem key={source._id} value={source._id}>
                              <Box
                                sx={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 1,
                                }}
                              >
                                {source.name}
                                <Chip label={source.type} size="small" />
                                {webhookCapabilitiesByType[source.type]
                                  ?.supported && (
                                  <Chip
                                    label="webhook"
                                    size="small"
                                    variant="outlined"
                                  />
                                )}
                              </Box>
                            </MenuItem>
                          ))}
                        </Select>
                        {errors.dataSourceId && (
                          <FormHelperText>
                            {errors.dataSourceId.message}
                          </FormHelperText>
                        )}
                      </FormControl>
                    )}
                  />

                  {isNewMode && onSwitchToDbSync && (
                    <Typography variant="caption" color="text.secondary">
                      Syncing from a database query instead?{" "}
                      <Button size="small" onClick={onSwitchToDbSync}>
                        Use a database connection
                      </Button>
                    </Typography>
                  )}

                  <Box
                    sx={{ display: "flex", justifyContent: "flex-end", pt: 1 }}
                  >
                    <Button
                      variant="contained"
                      endIcon={<NextIcon />}
                      onClick={() => openNextStep(0)}
                      disabled={!watchDataSourceId}
                    >
                      Continue to Destination
                    </Button>
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>

            {/* Step 2: Destination */}
            <Accordion
              expanded={openSteps.has(1)}
              onChange={() => toggleStep(1)}
              sx={{ mb: 1 }}
            >
              {renderStepHeader(1)}
              <AccordionDetails>
                <Stack spacing={3}>
                  <Controller
                    name="destinationDatabaseId"
                    control={control}
                    rules={{ required: "Destination database is required" }}
                    render={({ field }) => (
                      <FormControl
                        fullWidth
                        error={!!errors.destinationDatabaseId}
                      >
                        <InputLabel>Destination Database</InputLabel>
                        <Select
                          {...field}
                          label="Destination Database"
                          disabled={!isNewMode}
                          startAdornment={
                            <DatabaseIcon
                              sx={{ mr: 1, color: "action.active" }}
                            />
                          }
                        >
                          {databases.map(db => (
                            <MenuItem key={db.id} value={db.id}>
                              <Box
                                sx={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 1,
                                }}
                              >
                                {db.name}
                                <Chip label={db.type} size="small" />
                              </Box>
                            </MenuItem>
                          ))}
                        </Select>
                        {errors.destinationDatabaseId && (
                          <FormHelperText>
                            {errors.destinationDatabaseId.message}
                          </FormHelperText>
                        )}
                      </FormControl>
                    )}
                  />

                  {isCdcCapableDest && (
                    <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                      <Controller
                        name="tableDestination.schema"
                        control={control}
                        render={({ field }) => (
                          <TextField
                            {...field}
                            label={
                              isBigQueryDest ? "Dataset" : "Schema / Database"
                            }
                            placeholder={
                              isBigQueryDest ? "my_dataset" : "public"
                            }
                            fullWidth
                            size="small"
                            disabled={!isNewMode}
                            error={!!errors.tableDestination?.schema}
                            helperText={
                              errors.tableDestination?.schema?.message ||
                              (isBigQueryDest
                                ? "BigQuery dataset name"
                                : "Target schema or database name")
                            }
                          />
                        )}
                      />
                      <Controller
                        name="tableDestination.tablePrefix"
                        control={control}
                        render={({ field }) => (
                          <TextField
                            {...field}
                            label="Table Prefix (optional)"
                            placeholder="e.g. crm"
                            fullWidth
                            size="small"
                            disabled={!isNewMode}
                            helperText={
                              field.value
                                ? `Tables: ${field.value}_leads, ${field.value}_contacts, ...`
                                : "Tables: leads, contacts, ... (no prefix)"
                            }
                          />
                        )}
                      />
                    </Stack>
                  )}

                  {requiresDestinationDatabaseName && (
                    <Controller
                      name="destinationDatabaseName"
                      control={control}
                      render={({ field }) => (
                        <FormControl fullWidth>
                          <InputLabel>Destination Database Name</InputLabel>
                          <Select
                            {...field}
                            label="Destination Database Name"
                            displayEmpty
                          >
                            <MenuItem value="">
                              <em>Select a database</em>
                            </MenuItem>
                            {availableDatabases.map(db => (
                              <MenuItem key={db.id} value={db.id}>
                                {db.label || db.id}
                              </MenuItem>
                            ))}
                          </Select>
                          <FormHelperText>
                            This server hosts multiple databases — pick the one
                            that receives the synced records.
                          </FormHelperText>
                        </FormControl>
                      )}
                    />
                  )}

                  <Box
                    sx={{ display: "flex", justifyContent: "flex-end", pt: 1 }}
                  >
                    <Button
                      variant="contained"
                      endIcon={<NextIcon />}
                      onClick={() => openNextStep(1)}
                      disabled={!watchDestinationId}
                    >
                      Continue to Sync Configuration
                    </Button>
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>

            {/* Step 3: Sync Configuration */}
            <Accordion
              expanded={openSteps.has(2)}
              onChange={() => toggleStep(2)}
              sx={{ mb: 1 }}
            >
              {renderStepHeader(2)}
              <AccordionDetails>
                <Stack spacing={3}>
                  <FormControl fullWidth>
                    <InputLabel>Sync Mode</InputLabel>
                    <Select
                      label="Sync Mode"
                      value={`${watch("syncMode")}:${watch("writeMode")}`}
                      onChange={e => {
                        const combo = SYNC_MODE_COMBOS.find(
                          c => c.value === e.target.value,
                        );
                        if (!combo) return;
                        formTouchedRef.current = true;
                        setValue("syncMode", combo.syncMode, {
                          shouldDirty: true,
                        });
                        setValue("writeMode", combo.writeMode, {
                          shouldDirty: true,
                        });
                      }}
                    >
                      {syncModeMenuCombos.map(combo => (
                        <MenuItem key={combo.value} value={combo.value}>
                          {combo.label}
                          {currentSyncModeIsOrphaned &&
                            combo.value === currentSyncModeValue &&
                            " (unsupported — pick a different mode)"}
                        </MenuItem>
                      ))}
                    </Select>
                    <FormHelperText>
                      {currentSyncModeCombo?.help ??
                        "How records are read and written each run."}
                    </FormHelperText>
                  </FormControl>

                  {currentSyncModeIsOrphaned && (
                    <Alert severity="warning">
                      This sync was saved as Incremental before{" "}
                      {selectedConnector?.name || "this connector"} lost support
                      for it (or the selected entities changed). It keeps
                      running as-is until you pick a different Sync Mode above
                      and save.
                    </Alert>
                  )}

                  {!connectorSupportsIncremental &&
                    selectedConnectorType &&
                    !currentSyncModeIsOrphaned && (
                      <Alert severity="info">
                        Incremental is hidden —{" "}
                        {selectedConnector?.name || "this connector"} has no way
                        to fetch only changed records for the selected entities,
                        so every run would silently re-fetch everything anyway.
                        Use Full Refresh, and add the webhook trigger or a
                        periodic full reconcile to stay current between runs.
                      </Alert>
                    )}

                  {watchSyncMode === "incremental" && incrementalWarning && (
                    <Alert severity="warning">{incrementalWarning}</Alert>
                  )}

                  {suggestReconcile && (
                    <Alert
                      severity="info"
                      action={
                        !watchBackfillScheduleEnabled ? (
                          <Button
                            color="inherit"
                            size="small"
                            onClick={() => {
                              formTouchedRef.current = true;
                              setValue("backfillScheduleEnabled", true, {
                                shouldDirty: true,
                              });
                              setOpenSteps(prev => {
                                const next = new Set(prev);
                                next.add(4);
                                return next;
                              });
                            }}
                          >
                            Enable reconcile
                          </Button>
                        ) : undefined
                      }
                    >
                      {watchBackfillScheduleEnabled
                        ? "Periodic full reconcile is on — it covers updates and snapshot entities that Incremental polls cannot see."
                        : "Enable the periodic full reconcile trigger (step 3) so created-anchor / full-repull entities stay current."}
                    </Alert>
                  )}

                  {isCdcCapableDest && (
                    <Controller
                      name="deleteMode"
                      control={control}
                      render={({ field }) => (
                        <FormControl fullWidth>
                          <InputLabel>Delete Mode</InputLabel>
                          <Select
                            {...field}
                            label="Delete Mode"
                            value={
                              isBigQueryDest ? "soft" : field.value || "hard"
                            }
                            disabled={isBigQueryDest}
                          >
                            {!isBigQueryDest && (
                              <MenuItem value="hard">
                                Hard delete (remove rows)
                              </MenuItem>
                            )}
                            <MenuItem value="soft">
                              Soft delete (set is_deleted flag)
                            </MenuItem>
                          </Select>
                          <FormHelperText>
                            {isBigQueryDest
                              ? "BigQuery syncs always use soft delete (CDC tombstones)."
                              : "How source deletions are applied in the destination"}
                          </FormHelperText>
                        </FormControl>
                      )}
                    />
                  )}

                  <Box
                    sx={{ display: "flex", justifyContent: "flex-end", pt: 1 }}
                  >
                    <Button
                      variant="contained"
                      endIcon={<NextIcon />}
                      onClick={() => openNextStep(2)}
                    >
                      Continue to Entities
                    </Button>
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>

            {/* Step 4: Entities */}
            <Accordion
              expanded={openSteps.has(3)}
              onChange={() => toggleStep(3)}
              sx={{ mb: 1 }}
            >
              {renderStepHeader(3)}
              <AccordionDetails>
                <Stack spacing={3}>
                  {/* Query-based connectors (GraphQL / PostHog) */}
                  {hasTransferQueries && transferQueriesSchema && (
                    <Box>
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          mb: 2,
                        }}
                      >
                        <Typography variant="subtitle2">
                          {transferQueriesSchema.label || "Queries"}
                        </Typography>
                        <Button
                          size="small"
                          startIcon={<AddIcon />}
                          onClick={() => {
                            const defaultQuery: Record<string, unknown> = {
                              name: "",
                              query: "",
                            };
                            transferQueriesSchema.fields?.forEach(
                              (f: TransferQueryField) => {
                                if (f.default !== undefined) {
                                  defaultQuery[f.name] = f.default;
                                } else if (f.type === "number") {
                                  defaultQuery[f.name] = undefined;
                                } else {
                                  defaultQuery[f.name] = "";
                                }
                              },
                            );
                            appendQuery(
                              defaultQuery as unknown as TransferQuery,
                            );
                          }}
                        >
                          Add Query
                        </Button>
                      </Box>
                      {queryFields.length === 0 ? (
                        <Alert severity="info">
                          {requiresQueries
                            ? "Add at least one query to define what data to sync."
                            : "Optional: add HogQL queries, or sync built-in entities below (Surveys)."}
                        </Alert>
                      ) : (
                        queryFields.map((field, index) => (
                          <Box
                            key={field.id}
                            sx={{
                              border: 1,
                              borderColor: "divider",
                              borderRadius: 1,
                              p: 2,
                              mb: 2,
                            }}
                          >
                            <Box
                              sx={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                mb: 2,
                              }}
                            >
                              <Typography variant="subtitle2">
                                Query {index + 1}
                              </Typography>
                              <IconButton
                                size="small"
                                color="error"
                                onClick={() => removeQuery(index)}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Box>
                            <Stack spacing={2}>
                              {transferQueriesSchema.fields?.map(
                                (schemaField: TransferQueryField) => (
                                  <Controller
                                    key={schemaField.name}
                                    name={
                                      `queries.${index}.${schemaField.name}` as any
                                    }
                                    control={control}
                                    rules={{
                                      required: schemaField.required
                                        ? `${schemaField.label} is required`
                                        : false,
                                    }}
                                    render={({
                                      field: formField,
                                      fieldState,
                                    }) => (
                                      <TextField
                                        {...formField}
                                        label={schemaField.label}
                                        placeholder={schemaField.placeholder}
                                        error={!!fieldState.error}
                                        helperText={
                                          fieldState.error?.message ||
                                          schemaField.helperText
                                        }
                                        multiline={
                                          schemaField.type === "textarea"
                                        }
                                        rows={
                                          schemaField.type === "textarea"
                                            ? schemaField.rows || 6
                                            : undefined
                                        }
                                        type={
                                          schemaField.type === "number"
                                            ? "number"
                                            : "text"
                                        }
                                        size="small"
                                        fullWidth
                                        onChange={e =>
                                          formField.onChange(
                                            schemaField.type === "number"
                                              ? e.target.value
                                                ? parseInt(e.target.value)
                                                : undefined
                                              : e.target.value,
                                          )
                                        }
                                      />
                                    )}
                                  />
                                ),
                              )}
                            </Stack>
                          </Box>
                        ))
                      )}
                    </Box>
                  )}

                  {/* Entity selection (fixed + hybrid connectors with builtins) */}
                  {watchEntityLayouts.length > 0 && (
                    <Box>
                      <Typography variant="subtitle2" sx={{ mb: 1 }}>
                        Entities
                        {layoutMode === "partition"
                          ? " & Table Configuration"
                          : layoutMode === "index"
                            ? " & Index Configuration"
                            : ""}
                      </Typography>
                      <Box
                        sx={{
                          border: 1,
                          borderColor: "divider",
                          borderRadius: 1,
                          overflowX: "auto",
                        }}
                      >
                        <Box sx={{ minWidth: layoutMode === "none" ? 0 : 720 }}>
                          <Box
                            sx={{
                              display: "grid",
                              gridTemplateColumns: entityGridTemplate,
                              gap: 1,
                              px: 1,
                              py: 0.5,
                              bgcolor: "action.hover",
                              alignItems: "center",
                            }}
                          >
                            <Checkbox
                              size="small"
                              checked={watchEntityLayouts.every(
                                l => l.enabled !== false,
                              )}
                              indeterminate={
                                watchEntityLayouts.some(
                                  l => l.enabled !== false,
                                ) &&
                                !watchEntityLayouts.every(
                                  l => l.enabled !== false,
                                )
                              }
                              onChange={e => {
                                formTouchedRef.current = true;
                                const layouts =
                                  getValues("entityLayouts") || [];
                                setValue(
                                  "entityLayouts",
                                  layouts.map(l => ({
                                    ...l,
                                    enabled: e.target.checked,
                                  })),
                                  { shouldDirty: true },
                                );
                              }}
                            />
                            <Typography variant="caption" fontWeight="bold">
                              Entity{layoutMode !== "none" ? " Table" : ""}
                            </Typography>
                            <Typography variant="caption" fontWeight="bold">
                              Primary Key
                            </Typography>
                            <Typography variant="caption" fontWeight="bold">
                              Sync
                            </Typography>
                            {layoutMode === "partition" && (
                              <>
                                <Typography variant="caption" fontWeight="bold">
                                  Partition Field
                                </Typography>
                                <Typography variant="caption" fontWeight="bold">
                                  Granularity
                                </Typography>
                                <Typography variant="caption" fontWeight="bold">
                                  Cluster Fields
                                </Typography>
                              </>
                            )}
                            {layoutMode === "index" && (
                              <>
                                <Typography variant="caption" fontWeight="bold">
                                  Time Field (indexed)
                                </Typography>
                                <Typography variant="caption" fontWeight="bold">
                                  Indexed Fields
                                </Typography>
                              </>
                            )}
                          </Box>
                          {watchEntityLayouts.map((layout, idx) => {
                            const entityMeta = entityMetadata.find(
                              e => e.name === layout.entity,
                            );
                            const schemaFields = entityMeta?.fields ?? [];
                            const entityFields =
                              schemaFields.length > 0
                                ? schemaFields.map(f => f.name)
                                : SYSTEM_ENTITY_FIELDS;
                            const timestampFields =
                              schemaFields.length > 0
                                ? schemaFields
                                    .filter(f => f.type === "timestamp")
                                    .map(f => f.name)
                                : ["_syncedAt"];
                            if (!timestampFields.includes("_syncedAt")) {
                              timestampFields.push("_syncedAt");
                            }
                            const isEnabled = layout.enabled !== false;
                            const keyColumns = entityMeta?.keyColumns ?? ["id"];
                            const incrementalBadge = entityMeta?.incrementalMode
                              ? INCREMENTAL_MODE_BADGE[
                                  entityMeta.incrementalMode
                                ]
                              : undefined;
                            return (
                              <Box
                                key={layout.entity}
                                sx={{
                                  display: "grid",
                                  gridTemplateColumns: entityGridTemplate,
                                  gap: 1,
                                  px: 1,
                                  py: 0.5,
                                  borderTop: 1,
                                  borderColor: "divider",
                                  alignItems: "center",
                                  opacity: isEnabled ? 1 : 0.4,
                                }}
                              >
                                <Checkbox
                                  size="small"
                                  checked={isEnabled}
                                  onChange={e => {
                                    formTouchedRef.current = true;
                                    const layouts =
                                      getValues("entityLayouts") || [];
                                    setValue(
                                      "entityLayouts",
                                      layouts.map((l, i) =>
                                        i === idx
                                          ? { ...l, enabled: e.target.checked }
                                          : l,
                                      ),
                                      { shouldDirty: true },
                                    );
                                  }}
                                />
                                <Typography variant="body2">
                                  {layout.label || layout.entity}
                                </Typography>
                                <Tooltip
                                  title={`Rows are deduplicated/merged on ${keyColumns.join(", ")}. Set by the connector — not user-configurable today.`}
                                >
                                  <Typography
                                    variant="caption"
                                    color="text.secondary"
                                    sx={{ fontFamily: "monospace" }}
                                  >
                                    {keyColumns.join(", ")}
                                  </Typography>
                                </Tooltip>
                                {incrementalBadge ? (
                                  <Tooltip
                                    title={
                                      incrementalCheckEntities.includes(
                                        layout.entity,
                                      ) && incrementalWarning
                                        ? incrementalWarning
                                        : `Incremental capability for this entity: ${entityMeta?.incrementalMode}`
                                    }
                                  >
                                    <Chip
                                      size="small"
                                      variant="outlined"
                                      label={incrementalBadge.label}
                                      color={incrementalBadge.color}
                                    />
                                  </Tooltip>
                                ) : (
                                  <Typography
                                    variant="caption"
                                    color="text.secondary"
                                  >
                                    —
                                  </Typography>
                                )}
                                {layoutMode !== "none" && (
                                  <>
                                    <Controller
                                      name={`entityLayouts.${idx}.partitionField`}
                                      control={control}
                                      render={({ field }) => (
                                        <Select
                                          {...field}
                                          size="small"
                                          value={field.value || "_syncedAt"}
                                          disabled={!isEnabled}
                                        >
                                          {timestampFields.map(f => (
                                            <MenuItem key={f} value={f}>
                                              {f}
                                            </MenuItem>
                                          ))}
                                        </Select>
                                      )}
                                    />
                                    {layoutMode === "partition" && (
                                      <Controller
                                        name={`entityLayouts.${idx}.partitionGranularity`}
                                        control={control}
                                        render={({ field }) => (
                                          <Select
                                            {...field}
                                            size="small"
                                            value={field.value || "day"}
                                            disabled={!isEnabled}
                                          >
                                            <MenuItem value="hour">
                                              hour
                                            </MenuItem>
                                            <MenuItem value="day">day</MenuItem>
                                            <MenuItem value="month">
                                              month
                                            </MenuItem>
                                            <MenuItem value="year">
                                              year
                                            </MenuItem>
                                          </Select>
                                        )}
                                      />
                                    )}
                                    <Controller
                                      name={`entityLayouts.${idx}.clusterFields`}
                                      control={control}
                                      render={({ field }) => (
                                        <Select
                                          multiple
                                          size="small"
                                          value={field.value || []}
                                          disabled={!isEnabled}
                                          onChange={e =>
                                            field.onChange(
                                              typeof e.target.value === "string"
                                                ? e.target.value.split(",")
                                                : e.target.value,
                                            )
                                          }
                                          renderValue={selected => (
                                            <Box
                                              sx={{
                                                display: "flex",
                                                flexWrap: "wrap",
                                                gap: 0.5,
                                              }}
                                            >
                                              {(selected as string[]).map(
                                                val => (
                                                  <Chip
                                                    key={val}
                                                    label={val}
                                                    size="small"
                                                  />
                                                ),
                                              )}
                                            </Box>
                                          )}
                                          displayEmpty
                                        >
                                          {entityFields.map(f => (
                                            <MenuItem key={f} value={f}>
                                              {f}
                                            </MenuItem>
                                          ))}
                                        </Select>
                                      )}
                                    />
                                  </>
                                )}
                              </Box>
                            );
                          })}
                        </Box>
                      </Box>
                    </Box>
                  )}

                  {!hasTransferQueries &&
                    watchEntityLayouts.length === 0 &&
                    watchDataSourceId && (
                      <Alert severity="info">
                        Loading entities for this connector…
                      </Alert>
                    )}

                  {currentWorkspace && (
                    <FlowRunNotificationsSection
                      workspaceId={currentWorkspace.id}
                      resourceType="flow"
                      resourceId={currentFlowId ?? undefined}
                      workspaceRole={currentWorkspace.role}
                    />
                  )}

                  <Box
                    sx={{ display: "flex", justifyContent: "flex-end", pt: 1 }}
                  >
                    <Button
                      variant="contained"
                      endIcon={<NextIcon />}
                      onClick={() => openNextStep(3)}
                    >
                      Continue to Triggers
                    </Button>
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>
            {/* Step 5: Triggers */}
            <Accordion
              expanded={
                openSteps.has(4) || pinTriggersOpen || isProvisioningWebhook
              }
              onChange={() => toggleStep(4)}
              sx={{ mb: 1 }}
            >
              {renderStepHeader(4)}
              <AccordionDetails>
                <Stack spacing={2}>
                  {!watchScheduleEnabled &&
                    !watchWebhookEnabled &&
                    !(isCdcCapableDest && watchBackfillScheduleEnabled) && (
                      <Alert severity="warning">
                        Enable at least one trigger — a schedule, a webhook, or
                        a periodic full reconcile.
                      </Alert>
                    )}

                  {/* Scheduled trigger. Hidden for Full Refresh on CDC
                      destinations: "poll on a cron" and "periodic full
                      reconcile" are the same operation there (a full
                      backfill), so showing both would just be two cron
                      controls for one behavior. The reconcile trigger below
                      becomes the sync's single cron in that case. */}
                  {showScheduleTrigger && (
                    <Box
                      sx={{
                        border: 1,
                        borderColor: "divider",
                        borderRadius: 1,
                        p: 2,
                      }}
                    >
                      <Controller
                        name="scheduleEnabled"
                        control={control}
                        render={({ field }) => (
                          <FormControlLabel
                            control={
                              <Checkbox
                                checked={Boolean(field.value)}
                                onChange={e => field.onChange(e.target.checked)}
                              />
                            }
                            label={
                              <Box>
                                <Typography variant="subtitle2">
                                  Scheduled
                                </Typography>
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                >
                                  Poll the source on a cron cadence.
                                </Typography>
                              </Box>
                            }
                          />
                        )}
                      />
                      {watchScheduleEnabled && (
                        <Stack
                          direction={{ xs: "column", sm: "row" }}
                          spacing={2}
                          sx={{ mt: 1 }}
                        >
                          <FormControl size="small" fullWidth>
                            <InputLabel>Cadence</InputLabel>
                            <Select
                              label="Cadence"
                              value={
                                scheduleCronMode === "custom"
                                  ? "__custom__"
                                  : cronPresetValue
                              }
                              onChange={e => {
                                const value = e.target.value;
                                if (value === "__custom__") {
                                  setScheduleCronMode("custom");
                                } else {
                                  setScheduleCronMode("preset");
                                  setValue("scheduleCron", value, {
                                    shouldDirty: true,
                                  });
                                }
                              }}
                            >
                              {SCHEDULE_PRESETS.map(preset => (
                                <MenuItem key={preset.cron} value={preset.cron}>
                                  {preset.label}
                                </MenuItem>
                              ))}
                              <MenuItem value="__custom__">
                                Custom cron…
                              </MenuItem>
                            </Select>
                          </FormControl>
                          {scheduleCronMode === "custom" && (
                            <Controller
                              name="scheduleCron"
                              control={control}
                              render={({ field }) => (
                                <TextField
                                  {...field}
                                  label="Cron Expression"
                                  placeholder="0 * * * *"
                                  size="small"
                                  fullWidth
                                  helperText="Format: minute hour day month weekday"
                                />
                              )}
                            />
                          )}
                          <Controller
                            name="scheduleTimezone"
                            control={control}
                            render={({ field }) => (
                              <TextField
                                {...field}
                                label="Timezone"
                                placeholder="UTC"
                                size="small"
                                fullWidth
                              />
                            )}
                          />
                        </Stack>
                      )}
                    </Box>
                  )}

                  {/* Webhook trigger */}
                  <Tooltip
                    title={
                      !watchDataSourceId
                        ? "Select a source connection first"
                        : connectorSupportsWebhook
                          ? ""
                          : "This connector does not provide webhooks — use a schedule"
                    }
                    placement="top-start"
                  >
                    <Box
                      sx={{
                        border: 1,
                        borderColor: "divider",
                        borderRadius: 1,
                        p: 2,
                        opacity: connectorSupportsWebhook ? 1 : 0.55,
                      }}
                    >
                      <Controller
                        name="webhookEnabled"
                        control={control}
                        render={({ field }) => (
                          <FormControlLabel
                            control={
                              <Checkbox
                                checked={Boolean(field.value)}
                                disabled={!connectorSupportsWebhook}
                                onChange={e => field.onChange(e.target.checked)}
                              />
                            }
                            label={
                              <Box>
                                <Typography variant="subtitle2">
                                  Webhook
                                </Typography>
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                >
                                  Receive pushed changes in real time
                                  {connectorSupportsWebhook
                                    ? "."
                                    : " (unavailable for this connector)."}
                                </Typography>
                              </Box>
                            }
                          />
                        )}
                      />

                      {watchWebhookEnabled && (
                        <Stack spacing={2} sx={{ mt: 1 }}>
                          {!isCdcCapableDest && (
                            <Alert severity="warning">
                              Webhook-triggered syncs require a CDC-capable
                              destination (BigQuery, PostgreSQL, ClickHouse, or
                              MongoDB).
                            </Alert>
                          )}
                          {isNewMode ? (
                            <Alert severity="info" icon={<WebhookIcon />}>
                              {provisioning?.supported
                                ? `Create the sync below — we'll generate the webhook URL and create it in ${provisionProviderLabel} automatically.`
                                : "Create the sync below to generate the webhook URL, then paste the signing secret from your provider."}
                            </Alert>
                          ) : (
                            <>
                              {isProvisioningWebhook && (
                                <Alert severity="info" icon={<WebhookIcon />}>
                                  Creating webhook in {provisionProviderLabel}…
                                </Alert>
                              )}
                              {webhookProvisionSucceeded &&
                                !isProvisioningWebhook && (
                                  <Alert
                                    severity="success"
                                    onClose={() => {
                                      setWebhookProvisionSucceeded(false);
                                      setPinTriggersOpen(false);
                                    }}
                                  >
                                    Webhook created in {provisionProviderLabel}.
                                    URL and signing secret are filled below —
                                    save if you change anything.
                                  </Alert>
                                )}
                              {webhookUrl && (
                                <TextField
                                  value={webhookUrl}
                                  label="Webhook URL"
                                  fullWidth
                                  size="small"
                                  InputProps={{
                                    readOnly: true,
                                    endAdornment: (
                                      <Button
                                        size="small"
                                        onClick={() =>
                                          navigator.clipboard.writeText(
                                            webhookUrl,
                                          )
                                        }
                                      >
                                        <CopyIcon fontSize="small" />
                                      </Button>
                                    ),
                                  }}
                                />
                              )}
                              <Controller
                                name="webhookSecret"
                                control={control}
                                render={({ field }) => (
                                  <TextField
                                    {...field}
                                    label="Webhook Secret"
                                    placeholder="Enter webhook secret"
                                    fullWidth
                                    size="small"
                                    helperText={webhookSecretHelpText}
                                  />
                                )}
                              />
                              {canProvisionWebhook && (
                                <Box>
                                  <Button
                                    size="small"
                                    variant="outlined"
                                    onClick={handleProvisionWebhook}
                                    disabled={
                                      isSubmitting || isProvisioningWebhook
                                    }
                                  >
                                    {isProvisioningWebhook
                                      ? `Creating in ${provisionProviderLabel}...`
                                      : webhookProvisionSucceeded
                                        ? `Recreate in ${provisionProviderLabel}`
                                        : `Create in ${provisionProviderLabel}`}
                                  </Button>
                                </Box>
                              )}
                            </>
                          )}
                        </Stack>
                      )}
                    </Box>
                  </Tooltip>

                  {/* Periodic full reconcile trigger (CDC destinations).
                      For Full Refresh, this IS the schedule (see
                      showScheduleTrigger above) — the label and helper text
                      reflect that instead of duplicating a second cron. */}
                  {isCdcCapableDest && (
                    <Box
                      sx={{
                        border: 1,
                        borderColor:
                          suggestReconcile && !watchBackfillScheduleEnabled
                            ? "warning.main"
                            : "divider",
                        borderRadius: 1,
                        p: 2,
                      }}
                    >
                      <Controller
                        name="backfillScheduleEnabled"
                        control={control}
                        render={({ field }) => (
                          <FormControlLabel
                            control={
                              <Checkbox
                                checked={Boolean(field.value)}
                                onChange={e => field.onChange(e.target.checked)}
                              />
                            }
                            label={
                              <Box>
                                <Typography variant="subtitle2">
                                  {showScheduleTrigger
                                    ? "Periodic full reconcile"
                                    : "Schedule (periodic full reconcile)"}
                                  {suggestReconcile ? " (recommended)" : ""}
                                </Typography>
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                >
                                  {reconcileDescription}
                                  {showScheduleTrigger &&
                                    " Other triggers stay active between runs."}
                                </Typography>
                              </Box>
                            }
                          />
                        )}
                      />
                      {suggestReconcile && !watchBackfillScheduleEnabled && (
                        <Alert
                          severity="warning"
                          sx={{ mt: 1 }}
                          action={
                            <Button
                              color="inherit"
                              size="small"
                              onClick={() => {
                                formTouchedRef.current = true;
                                setValue("backfillScheduleEnabled", true, {
                                  shouldDirty: true,
                                });
                                if (!getValues("backfillScheduleCron")) {
                                  setValue(
                                    "backfillScheduleCron",
                                    "0 3 * * *",
                                    { shouldDirty: true },
                                  );
                                }
                              }}
                            >
                              Enable daily
                            </Button>
                          }
                        >
                          Incremental polls for the selected entities miss
                          updates (created-only) or silently re-fetch
                          everything. Enable a periodic full reconcile so the
                          destination stays honest between webhook events.
                        </Alert>
                      )}
                      {watchBackfillScheduleEnabled &&
                        watchSyncMode === "incremental" &&
                        watchWriteMode === "append" && (
                          <Alert severity="warning" sx={{ mt: 1 }}>
                            Combined with Incremental | Append, each reconcile
                            run appends a full duplicate snapshot into the
                            history table. Consider Full Refresh | Append (a
                            snapshot-per-run table) or Deduped instead.
                          </Alert>
                        )}
                      {watchBackfillScheduleEnabled && (
                        <Stack
                          direction={{ xs: "column", sm: "row" }}
                          spacing={2}
                          sx={{ mt: 2 }}
                        >
                          <Controller
                            name="backfillScheduleCron"
                            control={control}
                            render={({ field }) => (
                              <TextField
                                {...field}
                                label="Cron expression"
                                placeholder="0 3 * * *"
                                size="small"
                                fullWidth
                                helperText="e.g. '0 3 * * *' = daily at 03:00"
                              />
                            )}
                          />
                          <Controller
                            name="backfillScheduleTimezone"
                            control={control}
                            render={({ field }) => (
                              <TextField
                                {...field}
                                label="Timezone"
                                placeholder="UTC"
                                size="small"
                                fullWidth
                              />
                            )}
                          />
                        </Stack>
                      )}
                    </Box>
                  )}

                  {isNewMode ? (
                    <Button
                      variant="contained"
                      startIcon={<AddIcon />}
                      onClick={handleFormSubmit}
                      disabled={
                        isSubmitting ||
                        (!watchScheduleEnabled &&
                          !watchWebhookEnabled &&
                          !(isCdcCapableDest && watchBackfillScheduleEnabled))
                      }
                      fullWidth
                    >
                      {isSubmitting
                        ? "Creating..."
                        : watchWebhookEnabled && provisioning?.supported
                          ? `Create Sync & connect ${provisionProviderLabel}`
                          : "Create Sync"}
                    </Button>
                  ) : (
                    <Box
                      sx={{
                        display: "flex",
                        justifyContent: "flex-end",
                        pt: 1,
                      }}
                    >
                      <Button
                        variant="contained"
                        onClick={handleFormSubmit}
                        disabled={
                          isSubmitting ||
                          (!watchScheduleEnabled &&
                            !watchWebhookEnabled &&
                            !(isCdcCapableDest && watchBackfillScheduleEnabled))
                        }
                      >
                        {isSubmitting ? "Saving..." : "Save triggers"}
                      </Button>
                    </Box>
                  )}
                </Stack>
              </AccordionDetails>
            </Accordion>
          </form>
        </Box>
      </Box>
    </Box>
  );
}
