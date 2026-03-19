import { useEffect, useState, useMemo } from "react";
import { useForm, Controller } from "react-hook-form";
import {
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
} from "@mui/material";
import {
  Save as SaveIcon,
  DataObject as DataIcon,
  Storage as DatabaseIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
  Webhook as WebhookIcon,
  ContentCopy as CopyIcon,
} from "@mui/icons-material";
import { useWorkspace } from "../contexts/workspace-context";
import { useFlowStore } from "../store/flowStore";
import { useSchemaStore } from "../store/schemaStore";
import { trackEvent } from "../lib/analytics";
import { apiClient } from "../lib/api-client";

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

interface ConnectorLayoutSuggestion {
  partitionField?: string;
  partitionGranularity?: "day" | "hour" | "month" | "year";
  clusterFields?: string[];
}

interface ConnectorEntityMetadata {
  name: string;
  label?: string;
  subEntities?: ConnectorEntityMetadata[];
  layoutSuggestion?: ConnectorLayoutSuggestion;
  fieldHints?: string[];
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

const DEFAULT_PARTITION_FIELD = "_syncedAt";

const uniq = (values: string[]): string[] => Array.from(new Set(values));

const expandEntityMetadata = (items: ConnectorEntityMetadata[]) => {
  const expanded: Array<{
    entity: string;
    label: string;
    partitionField: string;
    partitionGranularity: "day" | "hour" | "month" | "year";
    clusterFields: string[];
    fieldHints: string[];
  }> = [];

  for (const entity of items || []) {
    const baseLayout = entity.layoutSuggestion || {};
    const baseFieldHints = entity.fieldHints || [];
    if (Array.isArray(entity.subEntities) && entity.subEntities.length > 0) {
      for (const subEntity of entity.subEntities) {
        const layout = subEntity.layoutSuggestion || baseLayout;
        expanded.push({
          entity: `${entity.name}:${subEntity.name}`,
          label: subEntity.label || subEntity.name,
          partitionField: layout.partitionField || DEFAULT_PARTITION_FIELD,
          partitionGranularity: layout.partitionGranularity || "day",
          clusterFields: layout.clusterFields || [],
          fieldHints: subEntity.fieldHints || baseFieldHints,
        });
      }
      continue;
    }

    expanded.push({
      entity: entity.name,
      label: entity.label || entity.name,
      partitionField: baseLayout.partitionField || DEFAULT_PARTITION_FIELD,
      partitionGranularity: baseLayout.partitionGranularity || "day",
      clusterFields: baseLayout.clusterFields || [],
      fieldHints: baseFieldHints,
    });
  }

  const deduped = new Map<string, (typeof expanded)[number]>();
  for (const item of expanded) {
    if (!deduped.has(item.entity)) {
      deduped.set(item.entity, item);
    }
  }
  return Array.from(deduped.values());
};

interface FormData {
  dataSourceId: string;
  destinationDatabaseId: string;
  webhookSecret?: string;
  deleteMode?: "hard" | "soft";
  tableDestination?: {
    tablePrefix?: string;
    schema?: string;
  };
  entityLayouts?: EntityLayoutConfig[];
}

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
    clearError,
    deleteFlow,
    fetchConnectors,
  } = useFlowStore();

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
  const [error, setError] = useState<string | null>(null);
  const [_copySuccess, setCopySuccess] = useState(false);
  const [currentFlowId, setCurrentFlowId] = useState<string | undefined>(
    flowId,
  );
  const [isNewMode, setIsNewMode] = useState(isNew);
  const [entityFieldHintsByEntity, setEntityFieldHintsByEntity] = useState<
    Record<string, string[]>
  >({});

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
      deleteMode: "hard",
      tableDestination: {
        tablePrefix: "",
        schema: "",
      },
      entityLayouts: [],
    },
  });

  const watchDataSourceId = watch("dataSourceId");
  const watchDestinationId = watch("destinationDatabaseId");
  const watchEntityLayouts = watch("entityLayouts") || [];
  const watchDeleteMode = watch("deleteMode");

  useEffect(() => {
    setCurrentFlowId(flowId);
    setIsNewMode(isNew);
  }, [flowId, isNew]);

  const selectedDestination = databases.find(
    db => db.id === watchDestinationId,
  );
  const isBigQueryDest = selectedDestination?.type === "bigquery";

  useEffect(() => {
    if (isBigQueryDest && watchDeleteMode !== "soft") {
      setValue("deleteMode", "soft");
    }
  }, [isBigQueryDest, setValue, watchDeleteMode]);

  // Fetch entity metadata from selected connector and derive per-entity layout defaults
  useEffect(() => {
    let cancelled = false;

    const loadEntityLayouts = async () => {
      if (!currentWorkspace?.id || !watchDataSourceId) {
        if (!cancelled) {
          setEntityFieldHintsByEntity({});
        }
        return;
      }

      if (!isBigQueryDest) {
        if (!cancelled) {
          setEntityFieldHintsByEntity({});
          setValue("entityLayouts", []);
        }
        return;
      }

      const source = connectors.find(c => c._id === watchDataSourceId);
      if (!source) return;

      try {
        const response = await apiClient.get<
          ApiResponse<ConnectorEntityMetadata[]>
        >(
          `/workspaces/${currentWorkspace.id}/connectors/${watchDataSourceId}/entities`,
        );
        if (!response.success) {
          throw new Error(
            response.error || "Failed to fetch connector entities",
          );
        }

        const expanded = expandEntityMetadata(response.data || []);
        if (cancelled) return;

        setError(null);

        setEntityFieldHintsByEntity(
          expanded.reduce(
            (acc, entity) => {
              acc[entity.entity] = entity.fieldHints || [];
              return acc;
            },
            {} as Record<string, string[]>,
          ),
        );

        const existingFlow =
          !isNewMode && currentFlowId
            ? flows.find(j => j._id === currentFlowId)
            : null;
        const savedLayouts: EntityLayoutConfig[] =
          existingFlow?.entityLayouts || watch("entityLayouts") || [];
        const savedByEntity = new Map(
          savedLayouts.map((layout: EntityLayoutConfig) => [
            layout.entity,
            layout,
          ]),
        );

        setValue(
          "entityLayouts",
          expanded.map(entity => {
            const saved = savedByEntity.get(entity.entity);
            return saved
              ? {
                  ...saved,
                  label: entity.label,
                  enabled: saved.enabled !== false,
                }
              : {
                  entity: entity.entity,
                  label: entity.label,
                  partitionField: entity.partitionField,
                  partitionGranularity: entity.partitionGranularity,
                  clusterFields: entity.clusterFields || [],
                  enabled: true,
                };
          }),
        );
      } catch (fetchError) {
        if (!cancelled) {
          setEntityFieldHintsByEntity({});
          setValue("entityLayouts", []);
          setError(
            fetchError instanceof Error
              ? fetchError.message
              : "Failed to load connector entities",
          );
        }
      }
    };

    loadEntityLayouts();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentWorkspace?.id,
    isBigQueryDest,
    watchDataSourceId,
    connectors,
    flows,
    isNewMode,
    currentFlowId,
    setValue,
  ]);

  // Fetch connectors
  const fetchDataSources = async (workspaceId: string) => {
    setIsLoadingConnectors(true);
    try {
      const sources = await fetchConnectors(workspaceId);
      const cdcCompatible = (sources || []).filter(source =>
        Boolean(source.supportsCdc),
      );
      setConnectors(cdcCompatible);
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id, ensureConnections]);

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
          deleteMode: flow.deleteMode || "hard",
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

  const onSubmit = async (data: FormData) => {
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

      const isBq = selectedDestination?.type === "bigquery";

      const payload: any = {
        name: generatedName,
        type: "webhook",
        dataSourceId: data.dataSourceId,
        destinationDatabaseId: data.destinationDatabaseId,
        syncMode: "incremental",
        enabled: true,
        webhookSecret: data.webhookSecret || "",
        deleteMode: isBq ? "soft" : data.deleteMode || "hard",
      };

      if (isBq && data.tableDestination?.schema) {
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

      let newFlow;
      if (isNewMode) {
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
        // Refresh the flows list
        await useFlowStore.getState().fetchFlows(currentWorkspace.id);

        // Reset form to mark it as pristine
        reset(data);

        onSaved?.(currentFlowId);

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

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
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
        {/* Delete button on the left */}
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
                    // Close the editor after successful deletion
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

        {/* Spacer for left alignment */}
        <Box sx={{ flex: 1 }} />

        {/* Right-aligned save/cancel buttons */}
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
            onClick={handleSubmit(onSubmit)}
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

          <Typography
            variant="body1"
            sx={{ mb: 3, display: "flex", alignItems: "center", gap: 1 }}
          >
            {currentFlowId && (
              <>
                <strong>Flow ID:</strong> {currentFlowId}
              </>
            )}
          </Typography>

          <form onSubmit={handleSubmit(onSubmit)}>
            <Stack spacing={3}>
              {/* Source and Destination */}
              <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
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
                            </Box>
                          </MenuItem>
                        ))}
                      </Select>
                      {errors.dataSourceId && (
                        <FormHelperText>
                          {errors.dataSourceId.message}
                        </FormHelperText>
                      )}
                      {connectors.length === 0 && !isLoadingConnectors && (
                        <FormHelperText>
                          No CDC-compatible connectors found in this workspace
                        </FormHelperText>
                      )}
                    </FormControl>
                  )}
                />

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
              </Stack>

              {/* Delete Mode */}
              <Controller
                name="deleteMode"
                control={control}
                render={({ field }) => (
                  <FormControl fullWidth>
                    <InputLabel>Delete Mode</InputLabel>
                    <Select
                      {...field}
                      label="Delete Mode"
                      value={isBigQueryDest ? "soft" : field.value || "hard"}
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
                        ? "BigQuery webhook flows always use soft delete (CDC tombstones)."
                        : "How webhook delete events are handled in the destination"}
                    </FormHelperText>
                  </FormControl>
                )}
              />

              {/* BigQuery Destination Config */}
              {isBigQueryDest && (
                <Box
                  sx={{
                    p: 2,
                    bgcolor: "background.paper",
                    borderRadius: 1,
                    border: 1,
                    borderColor: "divider",
                  }}
                >
                  <Typography variant="subtitle2" sx={{ mb: 2 }}>
                    BigQuery Destination
                  </Typography>
                  <Stack spacing={3}>
                    <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                      <Controller
                        name="tableDestination.schema"
                        control={control}
                        rules={{
                          required: isBigQueryDest
                            ? "Dataset is required for BigQuery"
                            : false,
                        }}
                        render={({ field }) => (
                          <TextField
                            {...field}
                            label="Dataset"
                            placeholder="my_dataset"
                            fullWidth
                            size="small"
                            disabled={!isNewMode}
                            error={!!errors.tableDestination?.schema}
                            helperText={
                              errors.tableDestination?.schema?.message ||
                              "BigQuery dataset name"
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

                    {/* Per-entity table layout config */}
                    {watchEntityLayouts.length > 0 && (
                      <Box>
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>
                          Entities & Table Configuration
                        </Typography>
                        <Box
                          sx={{
                            border: 1,
                            borderColor: "divider",
                            borderRadius: 1,
                            overflowX: "auto",
                          }}
                        >
                          <Box sx={{ minWidth: 640 }}>
                            {/* Header */}
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
                            {/* Rows */}
                            {watchEntityLayouts.map((layout, idx) => {
                              const hintedFields =
                                entityFieldHintsByEntity[layout.entity] || [];
                              const entityFields = uniq(
                                [
                                  ...hintedFields,
                                  ...(layout.clusterFields || []),
                                  layout.partitionField,
                                  "_syncedAt",
                                  "_dataSourceId",
                                  "id",
                                  "date_created",
                                  "date_updated",
                                  "created_at",
                                  "updated_at",
                                ].filter((value): value is string =>
                                  Boolean(value),
                                ),
                              );
                              const timestampFields = uniq(
                                entityFields.filter(
                                  field =>
                                    field.includes("date") ||
                                    field.includes("created") ||
                                    field.includes("updated") ||
                                    field.endsWith("_at") ||
                                    field === "_syncedAt" ||
                                    field === layout.partitionField,
                                ),
                              );
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
                                        disabled={!isEnabled || !isNewMode}
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
                                        disabled={!isEnabled || !isNewMode}
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
                                        disabled={!isEnabled || !isNewMode}
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
                  </Stack>
                </Box>
              )}

              {/* Webhook Configuration */}
              {/* Webhook URL and Secret (only shown after creation) */}
              {!isNewMode && currentFlowId && webhookUrl && (
                <Box
                  sx={{
                    p: 2,
                    bgcolor: "background.paper",
                    borderRadius: 1,
                    border: 1,
                    borderColor: "divider",
                  }}
                >
                  <Typography variant="subtitle2" sx={{ mb: 2 }}>
                    Webhook Configuration
                  </Typography>

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
                                  setTimeout(() => setCopySuccess(false), 2000);
                                }}
                              >
                                <CopyIcon fontSize="small" />
                              </Button>
                            ),
                          }}
                        />
                      </Box>
                      <Typography variant="caption" color="text.secondary">
                        Copy this URL to your Stripe/Close webhook settings
                      </Typography>
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
                            placeholder="Enter webhook secret (e.g., whsec_...)"
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
                        {connectors.find(ds => ds._id === watchDataSourceId)
                          ?.type === "stripe"
                          ? "Get this from Stripe Dashboard > Webhooks > Your endpoint > Signing secret"
                          : "Enter the webhook signing secret from your provider"}
                      </Typography>
                    </Box>
                  </Stack>
                </Box>
              )}

              {/* Webhook Preview */}
              <Alert severity="info" icon={<WebhookIcon />}>
                <Typography variant="body2">
                  <strong>Webhook:</strong> Real-time sync triggered by webhook
                  events
                  {isNewMode && " (URL will be generated after creation)"}
                </Typography>
              </Alert>
            </Stack>
          </form>
        </Box>
      </Box>
    </Box>
  );
}
