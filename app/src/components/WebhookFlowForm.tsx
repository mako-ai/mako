import { useEffect, useState, useMemo } from "react";
import { useForm, Controller } from "react-hook-form";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Button,
  Typography,
  FormHelperText,
  Alert,
  Chip,
  Stack,
  Checkbox,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from "@mui/material";
import {
  Save as SaveIcon,
  DataObject as DataIcon,
  Storage as DatabaseIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
  Webhook as WebhookIcon,
  ContentCopy as CopyIcon,
  ExpandMore as ExpandMoreIcon,
  NavigateNext as NextIcon,
  ErrorOutline as ErrorOutlineIcon,
} from "@mui/icons-material";
import { useWorkspace } from "../contexts/workspace-context";
import { useFlowStore } from "../store/flowStore";
import { useSchemaStore } from "../store/schemaStore";
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

interface WebhookFlowFormProps {
  flowId?: string;
  isNew?: boolean;
  onSave?: () => void;
  onSaved?: (flowId: string) => void;
  onCancel?: () => void;
}

interface EntityLayoutConfig {
  entity: string;
  label?: string;
  partitionField: string;
  partitionGranularity: "day" | "hour" | "month" | "year";
  clusterFields: string[];
  enabled?: boolean;
}

const SYNC_ENGINE_PERMISSION_ERROR =
  "The flow was saved, but changing the sync engine requires the workspace Owner or Admin role. Ask an admin to upgrade your role, then set the sync engine again.";

// Always-selectable fallback when the connector exposes no schema fields.
const SYSTEM_ENTITY_FIELDS = ["_syncedAt", "_dataSourceId", "id"];

interface FormData {
  dataSourceId: string;
  destinationDatabaseId: string;
  webhookSecret?: string;
  syncEngine?: "legacy" | "cdc";
  deleteMode?: "hard" | "soft";
  tableDestination?: {
    tablePrefix?: string;
    schema?: string;
  };
  entityLayouts?: EntityLayoutConfig[];
  backfillScheduleEnabled?: boolean;
  backfillScheduleCron?: string;
  backfillScheduleTimezone?: string;
}

const STEPS = [
  { label: "Source", description: "Select the data source connector" },
  { label: "Destination", description: "Configure destination database" },
  {
    label: "Sync Configuration",
    description: "Delete behavior and scheduled backfill",
  },
  {
    label: "Entity Configuration",
    description: "Configure per-entity table layouts",
  },
  { label: "Webhook Setup", description: "Webhook URL and signing secret" },
];

export function WebhookFlowForm({
  flowId,
  isNew = false,
  onSave,
  onSaved,
  onCancel,
}: WebhookFlowFormProps) {
  const { currentWorkspace } = useWorkspace();
  const {
    flows: flowsMap,
    loading: loadingMap,
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
  const webhookCapabilitiesByType = useMemo(() => {
    const map: Record<string, WebhookCapabilities> = {};
    for (const entry of connectorTypes || []) {
      map[entry.type] = entry.webhook;
    }
    return map;
  }, [connectorTypes]);
  const isWebhookCapableType = (type: string | undefined): boolean =>
    Boolean(type && webhookCapabilitiesByType[type]?.supported);

  // Get workspace-specific data
  const flows = useMemo(
    () => (currentWorkspace ? flowsMap[currentWorkspace.id] || [] : []),
    [currentWorkspace, flowsMap],
  );
  void loadingMap; // Acknowledge loadingMap is available but not currently used
  const storeError = currentWorkspace
    ? errorMap[currentWorkspace.id] || null
    : null;
  const connectionsMap = useSchemaStore(state => state.connections);
  const ensureConnections = useSchemaStore(state => state.ensureConnections);
  const databases = currentWorkspace
    ? connectionsMap[currentWorkspace.id] || []
    : [];

  const [connectors, setConnectors] = useState<any[]>([]);
  const [isLoadingConnectors, setIsLoadingConnectors] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isProvisioningWebhook, setIsProvisioningWebhook] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [_copySuccess, setCopySuccess] = useState(false);
  const [currentFlowId, setCurrentFlowId] = useState<string | undefined>(
    flowId,
  );
  const [isNewMode, setIsNewMode] = useState(isNew);
  // When a layout change on an existing flow requires recreating destination
  // tables, hold the pending save until the user confirms the reset.
  const [pendingLayoutReset, setPendingLayoutReset] = useState<{
    data: FormData;
    entities: string[];
  } | null>(null);
  const [entityMetadata, setEntityMetadata] = useState<
    FlattenedConnectorEntity[]
  >([]);
  const [openSteps, setOpenSteps] = useState<Set<number>>(new Set([0]));

  const toggleStep = (stepIndex: number) => {
    setOpenSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepIndex)) {
        next.delete(stepIndex);
      } else {
        next.add(stepIndex);
      }
      return next;
    });
  };

  const openNextStep = (currentStep: number, closeCurrentStep = true) => {
    setOpenSteps(prev => {
      const next = new Set(prev);
      const nextStep = currentStep + 1;
      if (nextStep < STEPS.length) {
        next.add(nextStep);
      }
      if (closeCurrentStep) {
        next.delete(currentStep);
      }
      return next;
    });
  };

  const {
    control,
    handleSubmit,
    formState: { errors },
    reset,
    watch,
    setValue,
  } = useForm<FormData>({
    defaultValues: {
      dataSourceId: "",
      destinationDatabaseId: "",
      syncEngine: "cdc",
      deleteMode: "hard",
      tableDestination: {
        tablePrefix: "",
        schema: "",
      },
      entityLayouts: [],
      backfillScheduleEnabled: false,
      backfillScheduleCron: "0 3 * * *",
      backfillScheduleTimezone: "UTC",
    },
  });

  const watchDataSourceId = watch("dataSourceId");
  const watchDestinationId = watch("destinationDatabaseId");
  const watchEntityLayouts = watch("entityLayouts") || [];
  const watchDeleteMode = watch("deleteMode");
  const watchBackfillScheduleEnabled = watch("backfillScheduleEnabled");
  const selectedConnector = connectors.find(ds => ds._id === watchDataSourceId);
  const selectedConnectorType = selectedConnector?.type;
  const selectedWebhookCapabilities = selectedConnectorType
    ? webhookCapabilitiesByType[selectedConnectorType]
    : undefined;
  const provisioning = selectedWebhookCapabilities?.provisioning;
  const canProvisionWebhook =
    !isNewMode && Boolean(currentFlowId) && Boolean(provisioning?.supported);
  const provisionProviderLabel = provisioning?.providerLabel ?? "Provider";
  const provisionActionHint = provisioning?.actionHint;
  const webhookSecretHelpText =
    selectedWebhookCapabilities?.secretHelpText ??
    "Enter the webhook signing secret from your provider";
  const webhookCapableConnectors = useMemo(
    () => connectors.filter(source => isWebhookCapableType(source.type)),
    // isWebhookCapableType is derived from webhookCapabilitiesByType
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectors, webhookCapabilitiesByType],
  );
  const webhookCapableConnectorNames = useMemo(
    () =>
      (connectorTypes || [])
        .filter(entry => entry.webhook?.supported)
        .map(entry => entry.name),
    [connectorTypes],
  );

  const selectedDestination = databases.find(
    db => db.id === watchDestinationId,
  );
  const destType = selectedDestination?.type;
  const isBigQueryDest = destType === "bigquery";
  const isCdcCapableDest =
    destType === "bigquery" ||
    destType === "postgresql" ||
    destType === "clickhouse" ||
    destType === "mongodb";
  const hasStagingDest = destType === "bigquery" || destType === "clickhouse";

  useEffect(() => {
    if (isBigQueryDest) {
      if (watchDeleteMode !== "soft") {
        setValue("deleteMode", "soft");
      }
    }
  }, [isBigQueryDest, setValue, watchDeleteMode]);

  // Fetch entity metadata from the connector API and build per-entity layout
  // defaults. Schema-driven: connectors expose entities + layout suggestions
  // via /connectors/:id/entities, so new connector entities appear here
  // automatically (see 15-connector-agnostic.mdc).
  useEffect(() => {
    if (hasStagingDest && watchDataSourceId && connectors.length > 0) {
      const source = connectors.find(c => c._id === watchDataSourceId);
      if (!source || !currentWorkspace?.id) return;

      let cancelled = false;
      (async () => {
        const list = await useAvailableEntitiesStore
          .getState()
          .fetch(currentWorkspace.id, watchDataSourceId);
        if (cancelled || list.length === 0) return;

        const entities = flattenConnectorEntities(list);
        setEntityMetadata(entities);

        // Read saved layouts from the flow object (store), not watch(),
        // because watch() may return stale state when effects race.
        const existingFlow =
          !isNewMode && currentFlowId
            ? flows.find(j => j._id === currentFlowId)
            : null;
        const savedLayouts: EntityLayoutConfig[] =
          existingFlow?.entityLayouts || watch("entityLayouts") || [];
        const savedByEntity = new Map(
          savedLayouts.map((l: EntityLayoutConfig) => [l.entity, l]),
        );
        setValue(
          "entityLayouts",
          entities.map(e => {
            const saved = savedByEntity.get(e.name);
            return saved
              ? {
                  ...saved,
                  label: e.label,
                  enabled: saved.enabled !== false,
                }
              : {
                  entity: e.name,
                  label: e.label,
                  partitionField: e.partitionField,
                  partitionGranularity: e.partitionGranularity,
                  clusterFields: e.clusterFields,
                  enabled: true,
                };
          }),
        );
      })();
      return () => {
        cancelled = true;
      };
    } else if (
      watchDataSourceId &&
      connectors.length > 0 &&
      watchDestinationId &&
      databases.length > 0
    ) {
      setEntityMetadata([]);
      setValue("entityLayouts", []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hasStagingDest,
    watchDataSourceId,
    watchDestinationId,
    connectors,
    databases,
    flows,
    isNewMode,
    currentFlowId,
  ]);

  // Fetch connectors
  const fetchDataSources = async (workspaceId: string) => {
    setIsLoadingConnectors(true);
    try {
      const sources = await fetchConnectors(workspaceId);
      setConnectors(sources || []);
    } catch (error) {
      console.error("Failed to fetch connectors:", error);
      setError("Failed to load connectors");
    } finally {
      setIsLoadingConnectors(false);
    }
  };

  // Load initial data
  useEffect(() => {
    if (currentWorkspace?.id) {
      fetchDataSources(currentWorkspace.id);
      ensureConnections(currentWorkspace.id);
      fetchCatalog(currentWorkspace.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id, ensureConnections, fetchCatalog]);

  // Load flow data if editing
  useEffect(() => {
    if (!isNewMode && currentFlowId && flows.length > 0) {
      const flow = flows.find(j => j._id === currentFlowId);
      if (flow && flow.type === "webhook") {
        const dataSourceId =
          typeof flow.dataSourceId === "string"
            ? flow.dataSourceId
            : flow.dataSourceId?._id;
        const destinationDatabaseId =
          typeof flow.destinationDatabaseId === "string"
            ? flow.destinationDatabaseId
            : flow.destinationDatabaseId?._id;

        const formData: FormData = {
          dataSourceId: dataSourceId || "",
          destinationDatabaseId: destinationDatabaseId || "",
          // Webhook flows are CDC-only (legacy engine decommissioned).
          syncEngine: "cdc",
          deleteMode: flow.deleteMode || "hard",
          backfillScheduleEnabled: flow.backfillSchedule?.enabled ?? false,
          backfillScheduleCron: flow.backfillSchedule?.cron || "0 3 * * *",
          backfillScheduleTimezone: flow.backfillSchedule?.timezone || "UTC",
        };

        if (flow.tableDestination) {
          formData.tableDestination = {
            tablePrefix: flow.tableDestination.tableName || "",
            schema: flow.tableDestination.schema || "",
          };
        }

        if (flow.entityLayouts && flow.entityLayouts.length > 0) {
          formData.entityLayouts = flow.entityLayouts.map((l: any) => ({
            ...l,
            enabled: l.enabled !== false,
          }));
        }

        if (flow.webhookConfig) {
          setWebhookUrl(flow.webhookConfig.endpoint || "");
          formData.webhookSecret = flow.webhookConfig.secret || "";
        }

        reset(formData);
      }
    }
  }, [isNewMode, currentFlowId, flows, reset]);

  // Clear store error when component unmounts
  useEffect(() => {
    return () => {
      if (currentWorkspace?.id) {
        clearError(currentWorkspace.id);
      }
    };
  }, [clearError, currentWorkspace?.id]);

  // Entities whose partition/granularity/cluster layout changed vs. the saved
  // flow. A changed layout only takes effect when the destination table is
  // recreated (BigQuery/ClickHouse partitioning + clustering are fixed at
  // CREATE), so these entities require a destination reset to apply.
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
      // A newly enabled entity has no existing table — it's created fresh with
      // the chosen layout, so no reset is required.
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
    // For an existing CDC flow, a partition/cluster change must recreate the
    // destination tables. Force the user to confirm the reset before saving.
    const changedEntities = getLayoutChangedEntities(data);
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
      console.error("No workspace selected");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // Find the selected source and destination names
      const selectedSource = connectors.find(
        ds => ds._id === data.dataSourceId,
      );
      const selectedDatabase = databases.find(
        db => db.id === data.destinationDatabaseId,
      );

      // Auto-generate name as "source → destination"
      const generatedName = `${selectedSource?.name || "Source"} → ${selectedDatabase?.name || "Destination"}`;

      const cdcCapableTypes = [
        "bigquery",
        "postgresql",
        "clickhouse",
        "mongodb",
      ];
      // Webhook flows are CDC-only — the destination MUST be CDC-capable.
      if (!cdcCapableTypes.includes(selectedDestination?.type || "")) {
        throw new Error(
          "Webhook flows require a CDC-capable destination (BigQuery, PostgreSQL, ClickHouse, or MongoDB).",
        );
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
        throw new Error(
          "A valid cron expression is required to enable the scheduled backfill.",
        );
      }

      const payload: any = {
        name: generatedName,
        type: "webhook",
        dataSourceId: data.dataSourceId,
        destinationDatabaseId: data.destinationDatabaseId,
        syncMode: "incremental",
        syncEngine: "cdc",
        enabled: true,
        webhookSecret: data.webhookSecret || "",
        deleteMode: isBigQueryDest ? "soft" : data.deleteMode || "hard",
        backfillSchedule,
      };

      if (isCdcCapableDest && data.tableDestination?.schema) {
        payload.tableDestination = {
          connectionId: data.destinationDatabaseId,
          schema: data.tableDestination.schema,
          tableName: data.tableDestination.tablePrefix || "",
          createIfNotExists: true,
        };
        payload.entityLayouts = data.entityLayouts;
        payload.entityFilter = (data.entityLayouts || [])
          .filter(l => l.enabled !== false)
          .map(l => l.entity);
      }

      const desiredSyncEngine = "cdc" as const;
      const currentSyncEngine =
        !isNewMode && currentFlowId
          ? (flows.find(flow => flow._id === currentFlowId)?.syncEngine ??
            "legacy")
          : "legacy";

      let newFlow;
      if (isNewMode) {
        // Webhook flows are created as CDC by the API (no engine switch needed).
        newFlow = await createFlow(currentWorkspace.id, payload);

        // Track flow creation
        trackEvent("flow_created", {
          flow_type: "webhook",
          connector_type: selectedSource?.type,
        });

        // Refresh the flows list
        await useFlowStore.getState().fetchFlows(currentWorkspace.id);

        // Switch to edit mode and update the flowId
        setIsNewMode(false);
        setCurrentFlowId(newFlow._id);

        // Notify parent that a new flow has been created
        onSaved?.(newFlow._id);

        // Reset form with the new flow data to mark it as pristine
        reset(data);

        // Notify parent if needed
        onSave?.();
      } else if (currentFlowId) {
        await updateFlow(currentWorkspace.id, currentFlowId, payload);
        const syncEngineOk =
          desiredSyncEngine === currentSyncEngine
            ? true
            : await setSyncEngine(
                currentWorkspace.id,
                currentFlowId,
                desiredSyncEngine,
              );
        // Refresh the flows list
        await useFlowStore.getState().fetchFlows(currentWorkspace.id);

        onSaved?.(currentFlowId);

        if (!syncEngineOk) {
          setError(SYNC_ENGINE_PERMISSION_ERROR);
          return;
        }

        // A partition/cluster layout change only takes effect on freshly
        // created tables, so recreate ONLY the changed entities' tables (drop +
        // subset re-backfill) immediately after persisting the new layout.
        if (opts.resetEntities && opts.resetEntities.length > 0) {
          await resyncCdcFlow(currentWorkspace.id, currentFlowId, {
            deleteDestination: true,
            entities: opts.resetEntities,
          });
        }

        // Reset form to mark it as pristine
        reset(data);

        // Notify parent if needed
        onSave?.();
      }
    } catch (error) {
      console.error("Failed to save flow:", error);
      setError(error instanceof Error ? error.message : "Failed to save flow");
    } finally {
      setIsSubmitting(false);
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
      ["destinationDatabaseId", "tableDestination"],
      [],
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

  const handleProvisionWebhook = async () => {
    if (!currentWorkspace?.id || !currentFlowId) {
      setError("Save the flow first before creating provider webhook");
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

      if (provisioned.endpoint) {
        setWebhookUrl(provisioned.endpoint);
      }
      if (provisioned.webhookSecret) {
        setValue("webhookSecret", provisioned.webhookSecret, {
          shouldDirty: true,
          shouldValidate: true,
        });
      }

      await useFlowStore.getState().fetchFlows(currentWorkspace.id);
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

  const renderStepHeader = (stepIndex: number) => (
    <AccordionSummary
      expandIcon={<ExpandMoreIcon />}
      sx={{
        "& .MuiAccordionSummary-content": {
          alignItems: "center",
          gap: 1,
        },
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

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Dialog
        open={pendingLayoutReset !== null}
        onClose={() => !isSubmitting && setPendingLayoutReset(null)}
      >
        <DialogTitle>Reset destination tables?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            You changed the partition or cluster layout for{" "}
            <strong>{pendingLayoutReset?.entities.join(", ")}</strong>. These
            settings are fixed when a destination table is created, so the
            existing table(s) must be dropped and rebuilt for the change to take
            effect.
            <Alert severity="warning" sx={{ mt: 2 }}>
              Saving will delete only those destination table(s) and re-sync
              (backfill) just those entities from scratch. Other entities are
              unaffected. This cannot be undone.
            </Alert>
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
            {isSubmitting ? "Resetting..." : "Save & reset tables"}
          </Button>
        </DialogActions>
      </Dialog>
      {/* Top bar with action buttons */}
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
                confirm("Are you sure you want to delete this webhook flow?")
              ) {
                if (currentWorkspace?.id) {
                  try {
                    await deleteFlow(currentWorkspace.id, currentFlowId);
                    onCancel?.();
                  } catch (error) {
                    console.error("Failed to delete webhook flow:", error);
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

      {/* Main form content */}
      <Box sx={{ flex: 1, overflow: "auto", p: { xs: 2, sm: 3 } }}>
        <Box sx={{ maxWidth: "800px", mx: "auto" }}>
          {(error || storeError) && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error || storeError}
            </Alert>
          )}

          {currentFlowId && (
            <Typography
              variant="body1"
              sx={{ mb: 2, display: "flex", alignItems: "center", gap: 1 }}
            >
              <strong>Flow ID:</strong> {currentFlowId}
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
                          {webhookCapableConnectors.map(source => (
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
                              </Box>
                            </MenuItem>
                          ))}
                        </Select>
                        {errors.dataSourceId && (
                          <FormHelperText>
                            {errors.dataSourceId.message}
                          </FormHelperText>
                        )}
                        {webhookCapableConnectors.length === 0 &&
                          !isLoadingConnectors && (
                            <FormHelperText>
                              {webhookCapableConnectorNames.length > 0
                                ? `Create a ${webhookCapableConnectorNames.join(", ")} data source to use webhook flows`
                                : "Create a webhook-capable data source to use webhook flows"}
                            </FormHelperText>
                          )}
                      </FormControl>
                    )}
                  />
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
                        rules={{
                          required: isCdcCapableDest
                            ? "Schema/dataset is required"
                            : false,
                        }}
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
                  <Alert
                    severity={isCdcCapableDest ? "info" : "warning"}
                    sx={{ "& .MuiAlert-message": { width: "100%" } }}
                  >
                    <Typography variant="body2">
                      <strong>Sync engine: CDC.</strong> Webhook flows stream
                      changes through the CDC pipeline (the legacy real-time
                      webhook engine has been removed).
                      {!isCdcCapableDest &&
                        " Select a CDC-capable destination (BigQuery, PostgreSQL, ClickHouse, or MongoDB) to continue."}
                    </Typography>
                  </Alert>

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
                          disabled={!isNewMode || isBigQueryDest}
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
                            ? "BigQuery flows always use soft delete (CDC tombstones)."
                            : "How webhook delete events are handled in the destination"}
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
                        <Box
                          sx={{ display: "flex", alignItems: "center", gap: 1 }}
                        >
                          <Checkbox
                            checked={Boolean(field.value)}
                            onChange={e => field.onChange(e.target.checked)}
                          />
                          <Box>
                            <Typography variant="subtitle2">
                              Scheduled full backfill
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                            >
                              Periodically re-runs a complete backfill to
                              reconcile drift. The live webhook stream stays
                              active between runs.
                            </Typography>
                          </Box>
                        </Box>
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
                              helperText="IANA timezone (e.g. UTC, Europe/Berlin)"
                            />
                          )}
                        />
                      </Stack>
                    )}
                  </Box>

                  <Box
                    sx={{ display: "flex", justifyContent: "flex-end", pt: 1 }}
                  >
                    <Button
                      variant="contained"
                      endIcon={<NextIcon />}
                      onClick={() => {
                        if (hasStagingDest) {
                          openNextStep(2);
                        } else {
                          setOpenSteps(prev => {
                            const next = new Set(prev);
                            next.delete(2);
                            next.add(4);
                            return next;
                          });
                        }
                      }}
                    >
                      {hasStagingDest
                        ? "Continue to Entity Configuration"
                        : "Continue to Webhook Setup"}
                    </Button>
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>

            {/* Step 4: Entity Configuration (staging-capable destinations) */}
            {hasStagingDest && (
              <Accordion
                expanded={openSteps.has(3)}
                onChange={() => toggleStep(3)}
                sx={{ mb: 1 }}
              >
                {renderStepHeader(3)}
                <AccordionDetails>
                  <Stack spacing={3}>
                    {watchEntityLayouts.length > 0 && (
                      <Box>
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>
                          Entities & Table Configuration
                        </Typography>
                        {!isNewMode && (
                          <Alert severity="warning" sx={{ mb: 1 }}>
                            Changing the partition field, granularity, or
                            cluster fields only affects how destination tables
                            are created. Existing tables keep their current
                            layout until you <strong>Reset sync</strong> with{" "}
                            <strong>Delete destination tables</strong> enabled,
                            which drops and rebuilds them with the new layout.
                          </Alert>
                        )}
                        <Box
                          sx={{
                            border: 1,
                            borderColor: "divider",
                            borderRadius: 1,
                            overflowX: "auto",
                          }}
                        >
                          <Box sx={{ minWidth: 640 }}>
                            <Box
                              sx={{
                                display: "grid",
                                gridTemplateColumns:
                                  "36px minmax(120px, 1.5fr) minmax(100px, 1fr) 80px minmax(100px, 1fr)",
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
                                  const layouts = watch("entityLayouts") || [];
                                  setValue(
                                    "entityLayouts",
                                    layouts.map(l => ({
                                      ...l,
                                      enabled: e.target.checked,
                                    })),
                                  );
                                }}
                              />
                              <Typography variant="caption" fontWeight="bold">
                                Entity Table
                              </Typography>
                              <Typography variant="caption" fontWeight="bold">
                                Partition Field
                              </Typography>
                              <Typography variant="caption" fontWeight="bold">
                                Granularity
                              </Typography>
                              <Typography variant="caption" fontWeight="bold">
                                Cluster Fields
                              </Typography>
                            </Box>
                            {watchEntityLayouts.map((layout, idx) => {
                              const schemaFields =
                                entityMetadata.find(
                                  e => e.name === layout.entity,
                                )?.fields ?? [];
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
                                      "36px minmax(120px, 1.5fr) minmax(100px, 1fr) 80px minmax(100px, 1fr)",
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
                                        watch("entityLayouts") || [];
                                      setValue(
                                        "entityLayouts",
                                        layouts.map((l, i) =>
                                          i === idx
                                            ? {
                                                ...l,
                                                enabled: e.target.checked,
                                              }
                                            : l,
                                        ),
                                      );
                                    }}
                                  />
                                  <Typography variant="body2">
                                    {(() => {
                                      const camelToSnake = (s: string) =>
                                        s
                                          .replace(
                                            /([a-z0-9])([A-Z])/g,
                                            "$1_$2",
                                          )
                                          .toLowerCase();
                                      const name = layout.entity.includes(":")
                                        ? `${camelToSnake(layout.entity.split(":")[1])}_${layout.entity.split(":")[0]}`
                                        : layout.entity;
                                      const prefix = watch(
                                        "tableDestination.tablePrefix",
                                      );
                                      return prefix
                                        ? `${prefix}_${name}`
                                        : name;
                                    })()}
                                  </Typography>
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
                                        <MenuItem value="hour">hour</MenuItem>
                                        <MenuItem value="day">day</MenuItem>
                                        <MenuItem value="month">month</MenuItem>
                                        <MenuItem value="year">year</MenuItem>
                                      </Select>
                                    )}
                                  />
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
                                            {(selected as string[]).map(val => (
                                              <Chip
                                                key={val}
                                                label={val}
                                                size="small"
                                              />
                                            ))}
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
                                </Box>
                              );
                            })}
                          </Box>
                        </Box>
                      </Box>
                    )}

                    {watchEntityLayouts.length === 0 && (
                      <Alert severity="info">
                        Select a data source and a staging-capable destination
                        to configure entities.
                      </Alert>
                    )}

                    <Box
                      sx={{
                        display: "flex",
                        justifyContent: "flex-end",
                        pt: 1,
                      }}
                    >
                      <Button
                        variant="contained"
                        endIcon={<NextIcon />}
                        onClick={() => {
                          setOpenSteps(prev => {
                            const next = new Set(prev);
                            next.delete(3);
                            next.add(4);
                            return next;
                          });
                        }}
                      >
                        Continue to Webhook Setup
                      </Button>
                    </Box>
                  </Stack>
                </AccordionDetails>
              </Accordion>
            )}

            {/* Step 5: Webhook Setup */}
            <Accordion
              expanded={openSteps.has(4)}
              onChange={() => toggleStep(4)}
              sx={{ mb: 1 }}
            >
              {renderStepHeader(4)}
              <AccordionDetails>
                <Stack spacing={3}>
                  <Alert severity="info" icon={<WebhookIcon />}>
                    <Typography variant="body2">
                      <strong>Webhook:</strong> Real-time sync triggered by
                      webhook events.
                      {isNewMode
                        ? " Save the flow to generate the webhook URL and secret."
                        : " Configure the webhook URL and signing secret below."}
                    </Typography>
                  </Alert>

                  {isNewMode && (
                    <Button
                      variant="contained"
                      startIcon={<AddIcon />}
                      onClick={handleFormSubmit}
                      disabled={isSubmitting}
                      fullWidth
                    >
                      {isSubmitting
                        ? "Creating..."
                        : "Create Flow & Generate Webhook URL"}
                    </Button>
                  )}

                  {!isNewMode && currentFlowId && webhookUrl && (
                    <Stack spacing={2}>
                      <Box>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{ mb: 0.5 }}
                        >
                          Webhook URL
                        </Typography>
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 1,
                          }}
                        >
                          <TextField
                            value={webhookUrl}
                            fullWidth
                            size="small"
                            InputProps={{
                              readOnly: true,
                              endAdornment: (
                                <Button
                                  size="small"
                                  onClick={() => {
                                    navigator.clipboard.writeText(webhookUrl);
                                    setCopySuccess(true);
                                    setTimeout(
                                      () => setCopySuccess(false),
                                      2000,
                                    );
                                  }}
                                >
                                  <CopyIcon fontSize="small" />
                                </Button>
                              ),
                            }}
                          />
                        </Box>
                        <Typography variant="caption" color="text.secondary">
                          Copy this URL to your{" "}
                          {provisionProviderLabel !== "Provider"
                            ? provisionProviderLabel
                            : "provider's"}{" "}
                          webhook settings
                        </Typography>
                        {canProvisionWebhook && (
                          <Box
                            sx={{
                              mt: 1,
                              display: "flex",
                              alignItems: "center",
                              gap: 1,
                              flexWrap: "wrap",
                            }}
                          >
                            <Button
                              size="small"
                              variant="outlined"
                              onClick={handleProvisionWebhook}
                              disabled={isSubmitting || isProvisioningWebhook}
                            >
                              {isProvisioningWebhook
                                ? `Creating in ${provisionProviderLabel}...`
                                : `Create in ${provisionProviderLabel}`}
                            </Button>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                            >
                              One click creates the {provisionProviderLabel}{" "}
                              webhook
                              {provisionActionHint
                                ? ` ${provisionActionHint}`
                                : ""}
                              .
                            </Typography>
                          </Box>
                        )}
                      </Box>

                      <Box>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{ mb: 0.5 }}
                        >
                          Webhook Secret
                        </Typography>
                        <Controller
                          name="webhookSecret"
                          control={control}
                          render={({ field }) => (
                            <TextField
                              {...field}
                              placeholder="Enter webhook secret"
                              fullWidth
                              size="small"
                              type="text"
                              InputProps={{
                                endAdornment: field.value && (
                                  <Button
                                    size="small"
                                    onClick={() => {
                                      navigator.clipboard.writeText(
                                        field.value ?? "",
                                      );
                                      setCopySuccess(true);
                                      setTimeout(
                                        () => setCopySuccess(false),
                                        2000,
                                      );
                                    }}
                                  >
                                    <CopyIcon fontSize="small" />
                                  </Button>
                                ),
                              }}
                            />
                          )}
                        />
                        <Typography variant="caption" color="text.secondary">
                          {webhookSecretHelpText}
                        </Typography>
                      </Box>
                    </Stack>
                  )}

                  {!isNewMode && currentFlowId && !webhookUrl && (
                    <Alert severity="warning">
                      <Typography variant="body2">
                        No webhook URL configured yet. The URL may still be
                        provisioning.
                      </Typography>
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
                </Stack>
              </AccordionDetails>
            </Accordion>
          </form>
        </Box>
      </Box>
    </Box>
  );
}
