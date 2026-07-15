/**
 * Unified Sync builder.
 *
 * Replaces the ScheduledFlowForm / WebhookFlowForm split: the trigger set
 * (scheduled poll and/or webhook push) is a property of one Sync, chosen in
 * step 3, instead of a flow "type" picked up-front. Composed from the proven
 * pieces of both legacy forms (destination + schema/prefix, entity layout
 * table, webhook secret/provisioning block, cron presets).
 */
import { useEffect, useState, useMemo } from "react";
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

interface SyncModeCombo {
  value: string;
  syncMode: "full" | "incremental";
  writeMode: "append_dedup" | "append" | "overwrite";
  label: string;
  help: string;
}

/** Airbyte-style sync modes: read mode (Full Refresh / Incremental) | destination write mode. */
const SYNC_MODE_COMBOS: SyncModeCombo[] = [
  {
    value: "incremental:append_dedup",
    syncMode: "incremental",
    writeMode: "append_dedup",
    label: "Incremental | Append + Deduped",
    help: "Fetch new or updated records and upsert by primary key — one deduplicated row per record.",
  },
  {
    value: "incremental:append",
    syncMode: "incremental",
    writeMode: "append",
    label: "Incremental | Append",
    help: "Fetch new or updated records and add them as new rows — keeps every version (history).",
  },
  {
    value: "full:append_dedup",
    syncMode: "full",
    writeMode: "append_dedup",
    label: "Full Refresh | Deduped",
    help: "Re-fetch everything each run and upsert by primary key (reconciles drift).",
  },
  {
    value: "full:append",
    syncMode: "full",
    writeMode: "append",
    label: "Full Refresh | Append",
    help: "Re-fetch everything each run and add all rows — accumulates a snapshot per run.",
  },
  {
    value: "full:overwrite",
    syncMode: "full",
    writeMode: "overwrite",
    label: "Full Refresh | Overwrite",
    help: "Re-fetch everything each run; the destination is cleared first and ends up an exact snapshot.",
  },
];

const STEPS = [
  { label: "Source", description: "Where the data comes from" },
  { label: "Destination", description: "Where the data is written" },
  {
    label: "Triggers",
    description: "How the sync is triggered — schedule, webhook, or both",
  },
  {
    label: "Sync Configuration",
    description: "Sync mode, delete behavior, periodic reconcile",
  },
  { label: "Entities", description: "What data is synced" },
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
  const { schemas, fetchSchema } = useConnectorCatalogStore();

  const webhookCapabilitiesByType = useMemo(() => {
    const map: Record<string, WebhookCapabilities> = {};
    for (const entry of connectorTypes || []) {
      map[entry.type] = entry.webhook;
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

  const toggleStep = (stepIndex: number) => {
    setOpenSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepIndex)) next.delete(stepIndex);
      else next.add(stepIndex);
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

  const selectedDestination = databases.find(
    db => db.id === watchDestinationId,
  );
  const destType = selectedDestination?.type;
  const isBigQueryDest = destType === "bigquery";
  const isCdcCapableDest = CDC_CAPABLE_TYPES.includes(destType || "");
  const hasStagingDest = destType === "bigquery" || destType === "clickhouse";
  // Engine-agnostic layout hints map to each destination's native physical
  // layout: BigQuery/ClickHouse partition+cluster DDL; Postgres/Mongo
  // secondary indexes on the same fields.
  // Mirrors the server-side supportedCdcWriteModes capability.
  const supportedWriteModes: Array<"append_dedup" | "append" | "overwrite"> =
    !isCdcCapableDest || destType === "clickhouse"
      ? ["append_dedup"]
      : ["append_dedup", "append", "overwrite"];

  const layoutMode: "partition" | "index" | "none" = hasStagingDest
    ? "partition"
    : destType === "postgresql" ||
        destType === "mongodb" ||
        destType === "mysql"
      ? "index"
      : "none";
  const requiresQueries = !!transferQueriesSchema;
  const requiresDestinationDatabaseName =
    !isCdcCapableDest && availableDatabases.length > 0;

  useEffect(() => {
    if (isBigQueryDest && watchDeleteMode !== "soft") {
      setValue("deleteMode", "soft");
    }
  }, [isBigQueryDest, setValue, watchDeleteMode]);

  // Overwrite cannot be combined with a webhook trigger (the stream would
  // race the truncation) — fall back to the deduped default.
  const watchWriteMode = watch("writeMode");
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

  // transferQueries schema (GraphQL/PostHog-style connectors)
  useEffect(() => {
    if (!selectedConnectorType) {
      setTransferQueriesSchema(null);
      return;
    }
    const cachedSchema = schemas[selectedConnectorType];
    if (cachedSchema?.transferQueries) {
      setTransferQueriesSchema(cachedSchema.transferQueries);
    } else {
      fetchSchema(selectedConnectorType).then(schema => {
        setTransferQueriesSchema(schema?.transferQueries ?? null);
      });
    }
  }, [selectedConnectorType, schemas, fetchSchema]);

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
        setError("Failed to load connectors");
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

    // Trigger-set validation
    if (!data.scheduleEnabled && !data.webhookEnabled) {
      setError("Enable at least one trigger — a schedule, a webhook, or both.");
      setOpenSteps(prev => new Set([...prev, 2]));
      return;
    }
    if (data.scheduleEnabled && !data.scheduleCron.trim()) {
      setError("A cron expression is required for the scheduled trigger.");
      setOpenSteps(prev => new Set([...prev, 2]));
      return;
    }
    if (data.webhookEnabled && !connectorSupportsWebhook) {
      setError("This connector does not provide webhooks — use a schedule.");
      setOpenSteps(prev => new Set([...prev, 2]));
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
    if (requiresQueries && (!data.queries || data.queries.length === 0)) {
      setError("Please add at least one query to define what data to sync");
      setOpenSteps(prev => new Set([...prev, 4]));
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
      setOpenSteps(prev => new Set([...prev, 3]));
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
      if (!requiresQueries) {
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
          ].join("+"),
        });
        await useFlowStore.getState().fetchFlows(currentWorkspace.id);
        setIsNewMode(false);
        setCurrentFlowId(newFlow._id);
        onSaved?.(newFlow._id);
        reset(data);
        onSave?.();
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

  const handleProvisionWebhook = async () => {
    if (!currentWorkspace?.id || !currentFlowId) {
      setError("Save the sync first before creating the provider webhook");
      return;
    }
    setIsProvisioningWebhook(true);
    setError(null);
    try {
      const publicBaseUrl =
        typeof window !== "undefined" ? window.location.origin : undefined;
      const provisioned = await provisionFlowWebhook(
        currentWorkspace.id,
        currentFlowId,
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
        setTimeout(() => {
          setValue("webhookSecret", provisioned.webhookSecret!, {
            shouldDirty: true,
          });
        }, 0);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Failed to create webhook in ${provisionProviderLabel}`,
      );
    } finally {
      setIsProvisioningWebhook(false);
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
      ["scheduleCron"],
      [],
      [],
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
              if (confirm("Are you sure you want to delete this sync?")) {
                if (currentWorkspace?.id) {
                  try {
                    await deleteFlow(currentWorkspace.id, currentFlowId);
                    onCancel?.();
                  } catch {
                    setError("Failed to delete sync");
                  }
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
                    rules={{ required: "Data source is required" }}
                    render={({ field }) => (
                      <FormControl fullWidth error={!!errors.dataSourceId}>
                        <InputLabel>Data Source</InputLabel>
                        <Select
                          {...field}
                          label="Data Source"
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
                        Use a database source
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
                      Continue to Triggers
                    </Button>
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>

            {/* Step 3: Triggers */}
            <Accordion
              expanded={openSteps.has(2)}
              onChange={() => toggleStep(2)}
              sx={{ mb: 1 }}
            >
              {renderStepHeader(2)}
              <AccordionDetails>
                <Stack spacing={2}>
                  {!watchScheduleEnabled && !watchWebhookEnabled && (
                    <Alert severity="warning">
                      Enable at least one trigger — a schedule, a webhook, or
                      both.
                    </Alert>
                  )}

                  {/* Scheduled trigger */}
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
                            <MenuItem value="__custom__">Custom cron…</MenuItem>
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

                  {/* Webhook trigger */}
                  <Tooltip
                    title={
                      !watchDataSourceId
                        ? "Select a data source first"
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
                              Save the sync to generate the webhook URL and
                              secret.
                            </Alert>
                          ) : (
                            <>
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

                  <Box
                    sx={{ display: "flex", justifyContent: "flex-end", pt: 1 }}
                  >
                    <Button
                      variant="contained"
                      endIcon={<NextIcon />}
                      onClick={() => openNextStep(2)}
                      disabled={!watchScheduleEnabled && !watchWebhookEnabled}
                    >
                      Continue to Sync Configuration
                    </Button>
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>

            {/* Step 4: Sync Configuration */}
            <Accordion
              expanded={openSteps.has(3)}
              onChange={() => toggleStep(3)}
              sx={{ mb: 1 }}
            >
              {renderStepHeader(3)}
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
                        setValue("syncMode", combo.syncMode, {
                          shouldDirty: true,
                        });
                        setValue("writeMode", combo.writeMode, {
                          shouldDirty: true,
                        });
                      }}
                    >
                      {SYNC_MODE_COMBOS.filter(
                        combo =>
                          supportedWriteModes.includes(combo.writeMode) &&
                          !(
                            combo.writeMode === "overwrite" &&
                            watchWebhookEnabled
                          ),
                      ).map(combo => (
                        <MenuItem key={combo.value} value={combo.value}>
                          {combo.label}
                        </MenuItem>
                      ))}
                    </Select>
                    <FormHelperText>
                      {SYNC_MODE_COMBOS.find(
                        c =>
                          c.value ===
                          `${watch("syncMode")}:${watch("writeMode")}`,
                      )?.help ?? "How records are read and written each run."}
                    </FormHelperText>
                  </FormControl>

                  {isCdcCapableDest && (
                    <>
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

                      <Box
                        sx={{
                          border: 1,
                          borderColor: "divider",
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
                                  onChange={e =>
                                    field.onChange(e.target.checked)
                                  }
                                />
                              }
                              label={
                                <Box>
                                  <Typography variant="subtitle2">
                                    Periodic full reconcile
                                  </Typography>
                                  <Typography
                                    variant="caption"
                                    color="text.secondary"
                                  >
                                    Re-runs a complete backfill on a cadence to
                                    reconcile drift and deletions. Triggers stay
                                    active between runs.
                                  </Typography>
                                </Box>
                              }
                            />
                          )}
                        />
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
                    </>
                  )}

                  <Box
                    sx={{ display: "flex", justifyContent: "flex-end", pt: 1 }}
                  >
                    <Button
                      variant="contained"
                      endIcon={<NextIcon />}
                      onClick={() => openNextStep(3)}
                    >
                      Continue to Entities
                    </Button>
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>

            {/* Step 5: Entities */}
            <Accordion
              expanded={openSteps.has(4)}
              onChange={() => toggleStep(4)}
              sx={{ mb: 1 }}
            >
              {renderStepHeader(4)}
              <AccordionDetails>
                <Stack spacing={3}>
                  {/* Query-based connectors (GraphQL / PostHog) */}
                  {requiresQueries && transferQueriesSchema && (
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
                          Add at least one query to define what data to sync.
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

                  {/* Entity selection (all connectors with fixed entities) */}
                  {!requiresQueries && watchEntityLayouts.length > 0 && (
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
                        <Box sx={{ minWidth: layoutMode === "none" ? 0 : 560 }}>
                          <Box
                            sx={{
                              display: "grid",
                              gridTemplateColumns:
                                layoutMode === "partition"
                                  ? "36px minmax(120px, 1.5fr) minmax(100px, 1fr) 80px minmax(100px, 1fr)"
                                  : layoutMode === "index"
                                    ? "36px minmax(120px, 1.5fr) minmax(100px, 1fr) minmax(100px, 1fr)"
                                    : "36px 1fr",
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
                            const schemaFields =
                              entityMetadata.find(e => e.name === layout.entity)
                                ?.fields ?? [];
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
                            return (
                              <Box
                                key={layout.entity}
                                sx={{
                                  display: "grid",
                                  gridTemplateColumns:
                                    layoutMode === "partition"
                                      ? "36px minmax(120px, 1.5fr) minmax(100px, 1fr) 80px minmax(100px, 1fr)"
                                      : layoutMode === "index"
                                        ? "36px minmax(120px, 1.5fr) minmax(100px, 1fr) minmax(100px, 1fr)"
                                        : "36px 1fr",
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

                  {!requiresQueries &&
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

                  {isNewMode && (
                    <Button
                      variant="contained"
                      startIcon={<AddIcon />}
                      onClick={handleFormSubmit}
                      disabled={isSubmitting}
                      fullWidth
                    >
                      {isSubmitting ? "Creating..." : "Create Sync"}
                    </Button>
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
