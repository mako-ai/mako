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
  ToggleButtonGroup,
  ToggleButton,
  Alert,
  Chip,
  FormControlLabel,
  Switch,
  Stack,
  Divider,
  CircularProgress,
} from "@mui/material";
import {
  Save as SaveIcon,
  Schedule as ScheduleIcon,
  Storage as DatabaseIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
} from "@mui/icons-material";
import { useWorkspace } from "../contexts/workspace-context";
import { useFlowStore } from "../store/flowStore";
import { useSchemaStore, TreeNode } from "../store/schemaStore";
import { trackEvent } from "../lib/analytics";

interface DbFlowFormProps {
  flowId?: string;
  isNew?: boolean;
  onSave?: () => void;
  onSaved?: (flowId: string) => void;
  onCancel?: () => void;
}

interface FormData {
  sourceConnectionId: string;
  sourceDatabase?: string;
  query: string;
  destinationConnectionId: string;
  destinationDatabase?: string;
  destinationSchema?: string;
  destinationTable: string;
  schedule: string;
  timezone: string;
  syncMode: "full" | "incremental";
  trackingColumn?: string;
  trackingType?: "timestamp" | "numeric";
  keyColumns?: string;
  conflictStrategy: "update" | "ignore" | "replace";
  batchSize: number;
  enabled: boolean;
  createTableIfNotExists: boolean;
}

// Common schedule presets
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

export function DbFlowForm({
  flowId,
  isNew = false,
  onSave,
  onSaved,
  onCancel,
}: DbFlowFormProps) {
  const { currentWorkspace } = useWorkspace();
  const {
    flows: flowsMap,
    loading: _loadingMap,
    error: errorMap,
    createFlow,
    updateFlow,
    clearError,
    deleteFlow,
  } = useFlowStore();

  // Get workspace-specific data
  const flows = useMemo(
    () => (currentWorkspace ? flowsMap[currentWorkspace.id] || [] : []),
    [currentWorkspace, flowsMap],
  );
  const storeError = currentWorkspace
    ? errorMap[currentWorkspace.id] || null
    : null;
  const connectionsMap = useSchemaStore(state => state.connections);
  const databases = useMemo(
    () => (currentWorkspace ? connectionsMap[currentWorkspace.id] || [] : []),
    [currentWorkspace, connectionsMap],
  );
  const ensureConnections = useSchemaStore(state => state.ensureConnections);
  const ensureTreeRoot = useSchemaStore(state => state.ensureTreeRoot);

  const [scheduleMode, setScheduleMode] = useState<"preset" | "custom">(
    "preset",
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentFlowId, setCurrentFlowId] = useState<string | undefined>(
    flowId,
  );
  const [isNewMode, setIsNewMode] = useState(isNew);

  // Source and destination database lists
  const [sourceDatabases, setSourceDatabases] = useState<TreeNode[]>([]);
  const [destDatabases, setDestDatabases] = useState<TreeNode[]>([]);
  const [isLoadingSourceDbs, setIsLoadingSourceDbs] = useState(false);
  const [isLoadingDestDbs, setIsLoadingDestDbs] = useState(false);

  const {
    control,
    handleSubmit,
    formState: { errors },
    reset,
    watch,
    setValue,
  } = useForm<FormData>({
    defaultValues: {
      sourceConnectionId: "",
      sourceDatabase: "",
      query: "",
      destinationConnectionId: "",
      destinationDatabase: "",
      destinationSchema: "",
      destinationTable: "",
      schedule: "0 * * * *", // Default hourly
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      syncMode: "full",
      trackingColumn: "",
      trackingType: "timestamp",
      keyColumns: "",
      conflictStrategy: "update",
      batchSize: 2000,
      enabled: true,
      createTableIfNotExists: true,
    },
  });

  const watchSchedule = watch("schedule");
  const watchTimezone = watch("timezone");
  const watchSourceConnectionId = watch("sourceConnectionId");
  const watchDestConnectionId = watch("destinationConnectionId");
  const watchSyncMode = watch("syncMode");

  // Fetch source databases when source connection changes
  useEffect(() => {
    const loadSourceDatabases = async () => {
      if (!watchSourceConnectionId || !currentWorkspace?.id) {
        setSourceDatabases([]);
        setValue("sourceDatabase", "");
        return;
      }

      setIsLoadingSourceDbs(true);
      try {
        const nodes = await ensureTreeRoot(
          currentWorkspace.id,
          watchSourceConnectionId,
        );
        const dbNodes = nodes.filter(node => node.kind === "database");
        setSourceDatabases(dbNodes);
        if (dbNodes.length === 0) {
          setValue("sourceDatabase", "");
        }
      } catch (err) {
        console.error("Failed to fetch source databases:", err);
        setSourceDatabases([]);
      } finally {
        setIsLoadingSourceDbs(false);
      }
    };

    loadSourceDatabases();
  }, [watchSourceConnectionId, currentWorkspace?.id, ensureTreeRoot, setValue]);

  // Fetch destination databases when destination connection changes
  useEffect(() => {
    const loadDestDatabases = async () => {
      if (!watchDestConnectionId || !currentWorkspace?.id) {
        setDestDatabases([]);
        setValue("destinationDatabase", "");
        return;
      }

      setIsLoadingDestDbs(true);
      try {
        const nodes = await ensureTreeRoot(
          currentWorkspace.id,
          watchDestConnectionId,
        );
        const dbNodes = nodes.filter(node => node.kind === "database");
        setDestDatabases(dbNodes);
        if (dbNodes.length === 0) {
          setValue("destinationDatabase", "");
        }
      } catch (err) {
        console.error("Failed to fetch destination databases:", err);
        setDestDatabases([]);
      } finally {
        setIsLoadingDestDbs(false);
      }
    };

    loadDestDatabases();
  }, [watchDestConnectionId, currentWorkspace?.id, ensureTreeRoot, setValue]);

  // Load initial data
  useEffect(() => {
    if (currentWorkspace?.id) {
      ensureConnections(currentWorkspace.id);
    }
  }, [currentWorkspace?.id, ensureConnections]);

  // Load flow data if editing
  useEffect(() => {
    if (!isNewMode && currentFlowId && flows.length > 0) {
      const flow = flows.find(j => j._id === currentFlowId);
      if (flow && flow.sourceType === "database") {
        const formData: FormData = {
          sourceConnectionId: flow.databaseSource?.connectionId?.toString() || "",
          sourceDatabase: flow.databaseSource?.database || "",
          query: flow.databaseSource?.query || "",
          destinationConnectionId: flow.tableDestination?.connectionId?.toString() || "",
          destinationDatabase: flow.tableDestination?.database || "",
          destinationSchema: flow.tableDestination?.schema || "",
          destinationTable: flow.tableDestination?.tableName || "",
          schedule: flow.schedule?.cron || "0 * * * *",
          timezone: flow.schedule?.timezone || "UTC",
          syncMode: flow.syncMode as "full" | "incremental",
          trackingColumn: flow.incrementalConfig?.trackingColumn || "",
          trackingType: flow.incrementalConfig?.trackingType || "timestamp",
          keyColumns: flow.conflictConfig?.keyColumns?.join(", ") || "",
          conflictStrategy: (flow.conflictConfig?.strategy as any) || "update",
          batchSize: flow.batchSize || 2000,
          enabled: flow.enabled,
          createTableIfNotExists: flow.tableDestination?.createIfNotExists ?? true,
        };

        reset(formData);

        // Check if using a preset
        const isPreset = SCHEDULE_PRESETS.some(
          p => p.cron === (flow.schedule?.cron || "0 * * * *"),
        );
        setScheduleMode(isPreset ? "preset" : "custom");
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
      return;
    }

    // Validate query
    if (!data.query.trim()) {
      setError("SQL query is required");
      return;
    }

    // Validate destination table
    if (!data.destinationTable.trim()) {
      setError("Destination table name is required");
      return;
    }

    // Validate incremental config
    if (data.syncMode === "incremental" && !data.trackingColumn?.trim()) {
      setError("Tracking column is required for incremental sync");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // Find the selected source and destination names
      const selectedSource = databases.find(
        db => db.id === data.sourceConnectionId,
      );
      const selectedDest = databases.find(
        db => db.id === data.destinationConnectionId,
      );

      // Auto-generate name
      const sourceName = data.sourceDatabase
        ? `${selectedSource?.name}/${data.sourceDatabase}`
        : selectedSource?.name || "Source";
      const destName = data.destinationDatabase
        ? `${selectedDest?.name}/${data.destinationDatabase}`
        : selectedDest?.name || "Destination";
      const generatedName = `${sourceName} → ${destName}:${data.destinationTable}`;

      // Parse key columns
      const keyColumns = data.keyColumns
        ? data.keyColumns.split(",").map(k => k.trim()).filter(Boolean)
        : [];

      // Create payload
      const payload: any = {
        name: generatedName,
        type: "scheduled",
        sourceType: "database",
        databaseSource: {
          connectionId: data.sourceConnectionId,
          database: data.sourceDatabase || undefined,
          query: data.query.trim(),
        },
        tableDestination: {
          connectionId: data.destinationConnectionId,
          database: data.destinationDatabase || undefined,
          schema: data.destinationSchema || undefined,
          tableName: data.destinationTable.trim(),
          createIfNotExists: data.createTableIfNotExists,
        },
        syncMode: data.syncMode,
        enabled: data.enabled,
        batchSize: data.batchSize,
        schedule: {
          cron: data.schedule,
          timezone: data.timezone,
        },
      };

      // Add incremental config if applicable
      if (data.syncMode === "incremental" && data.trackingColumn) {
        payload.incrementalConfig = {
          trackingColumn: data.trackingColumn.trim(),
          trackingType: data.trackingType || "timestamp",
        };
      }

      // Add conflict config if key columns specified
      if (keyColumns.length > 0) {
        payload.conflictConfig = {
          keyColumns,
          strategy: data.conflictStrategy,
        };
      }

      let newFlow;
      if (isNewMode) {
        newFlow = await createFlow(currentWorkspace.id, payload);

        // Track flow creation
        trackEvent("flow_created", {
          flow_type: "db-scheduled",
          source_type: selectedSource?.type,
          dest_type: selectedDest?.type,
        });

        // Refresh the flows list
        await useFlowStore.getState().fetchFlows(currentWorkspace.id);

        // Switch to edit mode
        setIsNewMode(false);
        setCurrentFlowId(newFlow._id);

        onSaved?.(newFlow._id);
        reset(data);
        onSave?.();
      } else if (currentFlowId) {
        await updateFlow(currentWorkspace.id, currentFlowId, payload);
        await useFlowStore.getState().fetchFlows(currentWorkspace.id);
        reset(data);
        onSaved?.(currentFlowId);
        onSave?.();
      }
    } catch (error) {
      console.error("Failed to save flow:", error);
      setError(error instanceof Error ? error.message : "Failed to save flow");
    } finally {
      setIsSubmitting(false);
    }
  };

  const getCronDescription = (cron: string) => {
    const preset = SCHEDULE_PRESETS.find(p => p.cron === cron);
    if (preset) return preset.label;
    return `Custom: ${cron}`;
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
              if (confirm("Are you sure you want to delete this flow?")) {
                if (currentWorkspace?.id) {
                  try {
                    await deleteFlow(currentWorkspace.id, currentFlowId);
                    onCancel?.();
                  } catch (error) {
                    console.error("Failed to delete flow:", error);
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

          <form onSubmit={handleSubmit(onSubmit)}>
            <Stack spacing={3}>
              {/* Source Configuration */}
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1, display: "flex", alignItems: "center", gap: 1 }}>
                  <DatabaseIcon fontSize="small" />
                  Source Database
                </Typography>
                <Stack spacing={2}>
                  <Controller
                    name="sourceConnectionId"
                    control={control}
                    rules={{ required: "Source connection is required" }}
                    render={({ field }) => (
                      <FormControl fullWidth error={!!errors.sourceConnectionId}>
                        <InputLabel>Source Connection</InputLabel>
                        <Select {...field} label="Source Connection">
                          {databases.map(db => (
                            <MenuItem key={db.id} value={db.id}>
                              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                                {db.name}
                                <Chip label={db.type} size="small" />
                              </Box>
                            </MenuItem>
                          ))}
                        </Select>
                        {errors.sourceConnectionId && (
                          <FormHelperText>{errors.sourceConnectionId.message}</FormHelperText>
                        )}
                      </FormControl>
                    )}
                  />

                  {watchSourceConnectionId && (
                    <>
                      {isLoadingSourceDbs ? (
                        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                          <CircularProgress size={20} />
                          <Typography variant="body2" color="text.secondary">
                            Loading databases...
                          </Typography>
                        </Box>
                      ) : sourceDatabases.length > 0 ? (
                        <Controller
                          name="sourceDatabase"
                          control={control}
                          render={({ field }) => (
                            <FormControl fullWidth>
                              <InputLabel>Source Database</InputLabel>
                              <Select {...field} label="Source Database">
                                <MenuItem value="">
                                  <em>Default</em>
                                </MenuItem>
                                {sourceDatabases.map(db => (
                                  <MenuItem key={db.id} value={db.id}>
                                    {db.label || db.id}
                                  </MenuItem>
                                ))}
                              </Select>
                              <FormHelperText>
                                Select the database within this connection
                              </FormHelperText>
                            </FormControl>
                          )}
                        />
                      ) : null}
                    </>
                  )}

                  <Controller
                    name="query"
                    control={control}
                    rules={{ required: "SQL query is required" }}
                    render={({ field }) => (
                      <TextField
                        {...field}
                        label="SQL Query"
                        placeholder="SELECT * FROM users WHERE updated_at > :last_sync_time"
                        multiline
                        rows={6}
                        error={!!errors.query}
                        helperText={
                          errors.query?.message ||
                          "Enter a SELECT query to fetch data from the source"
                        }
                        sx={{
                          "& .MuiInputBase-input": {
                            fontFamily: "monospace",
                            fontSize: "0.875rem",
                          },
                        }}
                      />
                    )}
                  />
                </Stack>
              </Box>

              <Divider />

              {/* Destination Configuration */}
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1, display: "flex", alignItems: "center", gap: 1 }}>
                  <DatabaseIcon fontSize="small" />
                  Destination Database
                </Typography>
                <Stack spacing={2}>
                  <Controller
                    name="destinationConnectionId"
                    control={control}
                    rules={{ required: "Destination connection is required" }}
                    render={({ field }) => (
                      <FormControl fullWidth error={!!errors.destinationConnectionId}>
                        <InputLabel>Destination Connection</InputLabel>
                        <Select {...field} label="Destination Connection">
                          {databases.map(db => (
                            <MenuItem key={db.id} value={db.id}>
                              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                                {db.name}
                                <Chip label={db.type} size="small" />
                              </Box>
                            </MenuItem>
                          ))}
                        </Select>
                        {errors.destinationConnectionId && (
                          <FormHelperText>{errors.destinationConnectionId.message}</FormHelperText>
                        )}
                      </FormControl>
                    )}
                  />

                  {watchDestConnectionId && (
                    <>
                      {isLoadingDestDbs ? (
                        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                          <CircularProgress size={20} />
                          <Typography variant="body2" color="text.secondary">
                            Loading databases...
                          </Typography>
                        </Box>
                      ) : destDatabases.length > 0 ? (
                        <Controller
                          name="destinationDatabase"
                          control={control}
                          render={({ field }) => (
                            <FormControl fullWidth>
                              <InputLabel>Destination Database</InputLabel>
                              <Select {...field} label="Destination Database">
                                <MenuItem value="">
                                  <em>Default</em>
                                </MenuItem>
                                {destDatabases.map(db => (
                                  <MenuItem key={db.id} value={db.id}>
                                    {db.label || db.id}
                                  </MenuItem>
                                ))}
                              </Select>
                            </FormControl>
                          )}
                        />
                      ) : null}
                    </>
                  )}

                  <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                    <Controller
                      name="destinationSchema"
                      control={control}
                      render={({ field }) => (
                        <TextField
                          {...field}
                          label="Schema (optional)"
                          placeholder="public"
                          helperText="For PostgreSQL/BigQuery"
                          sx={{ flex: 1 }}
                        />
                      )}
                    />
                    <Controller
                      name="destinationTable"
                      control={control}
                      rules={{ required: "Table name is required" }}
                      render={({ field }) => (
                        <TextField
                          {...field}
                          label="Table Name"
                          placeholder="synced_users"
                          error={!!errors.destinationTable}
                          helperText={errors.destinationTable?.message}
                          sx={{ flex: 1 }}
                        />
                      )}
                    />
                  </Stack>

                  <Controller
                    name="createTableIfNotExists"
                    control={control}
                    render={({ field }) => (
                      <FormControlLabel
                        control={
                          <Switch
                            checked={field.value}
                            onChange={field.onChange}
                          />
                        }
                        label="Create table if not exists"
                      />
                    )}
                  />
                </Stack>
              </Box>

              <Divider />

              {/* Schedule Configuration */}
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Schedule
                </Typography>
                <ToggleButtonGroup
                  value={scheduleMode}
                  exclusive
                  onChange={(_, value) => value && setScheduleMode(value)}
                  size="small"
                  sx={{ mb: 2 }}
                >
                  <ToggleButton value="preset">Preset</ToggleButton>
                  <ToggleButton value="custom">Custom</ToggleButton>
                </ToggleButtonGroup>
              </Box>

              <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                <Box sx={{ flex: scheduleMode === "preset" ? 2 : 1.5 }}>
                  <Controller
                    name="schedule"
                    control={control}
                    rules={{ required: "Schedule is required" }}
                    render={({ field }) =>
                      scheduleMode === "preset" ? (
                        <FormControl fullWidth>
                          <InputLabel>Schedule Preset</InputLabel>
                          <Select {...field} label="Schedule Preset">
                            {SCHEDULE_PRESETS.map(preset => (
                              <MenuItem key={preset.cron} value={preset.cron}>
                                {preset.label}
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                      ) : (
                        <TextField
                          {...field}
                          fullWidth
                          label="Cron Expression"
                          error={!!errors.schedule}
                          helperText={
                            errors.schedule?.message ||
                            "Format: minute hour day month weekday"
                          }
                          placeholder="0 * * * *"
                        />
                      )
                    }
                  />
                </Box>

                <Box sx={{ flex: 1 }}>
                  <Controller
                    name="timezone"
                    control={control}
                    render={({ field }) => (
                      <TextField
                        {...field}
                        fullWidth
                        label="Timezone"
                        helperText="e.g., America/New_York"
                      />
                    )}
                  />
                </Box>
              </Stack>

              <Divider />

              {/* Sync Mode and Options */}
              <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                <Controller
                  name="syncMode"
                  control={control}
                  render={({ field }) => (
                    <FormControl sx={{ flex: 1 }}>
                      <InputLabel>Sync Mode</InputLabel>
                      <Select {...field} label="Sync Mode">
                        <MenuItem value="full">Full Sync</MenuItem>
                        <MenuItem value="incremental">Incremental Sync</MenuItem>
                      </Select>
                      <FormHelperText>
                        {field.value === "full"
                          ? "Replace all data on each sync"
                          : "Only sync new or updated records"}
                      </FormHelperText>
                    </FormControl>
                  )}
                />

                <Box sx={{ display: "flex", alignItems: "center", flex: 1 }}>
                  <Controller
                    name="enabled"
                    control={control}
                    render={({ field }) => (
                      <FormControlLabel
                        control={
                          <Switch
                            checked={field.value}
                            onChange={field.onChange}
                          />
                        }
                        label="Enable Flow"
                      />
                    )}
                  />
                </Box>
              </Stack>

              {/* Incremental Config */}
              {watchSyncMode === "incremental" && (
                <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                  <Controller
                    name="trackingColumn"
                    control={control}
                    rules={{
                      required:
                        watchSyncMode === "incremental"
                          ? "Tracking column is required for incremental sync"
                          : false,
                    }}
                    render={({ field }) => (
                      <TextField
                        {...field}
                        label="Tracking Column"
                        placeholder="updated_at"
                        error={!!errors.trackingColumn}
                        helperText={
                          errors.trackingColumn?.message ||
                          "Column to track for incremental updates"
                        }
                        sx={{ flex: 1 }}
                      />
                    )}
                  />
                  <Controller
                    name="trackingType"
                    control={control}
                    render={({ field }) => (
                      <FormControl sx={{ flex: 1 }}>
                        <InputLabel>Tracking Type</InputLabel>
                        <Select {...field} label="Tracking Type">
                          <MenuItem value="timestamp">Timestamp</MenuItem>
                          <MenuItem value="numeric">Numeric (ID)</MenuItem>
                        </Select>
                      </FormControl>
                    )}
                  />
                </Stack>
              )}

              {/* Conflict Resolution */}
              <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                <Controller
                  name="keyColumns"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Key Columns (optional)"
                      placeholder="id, email"
                      helperText="Comma-separated list of columns for upsert"
                      sx={{ flex: 1 }}
                    />
                  )}
                />
                <Controller
                  name="conflictStrategy"
                  control={control}
                  render={({ field }) => (
                    <FormControl sx={{ flex: 1 }}>
                      <InputLabel>Conflict Strategy</InputLabel>
                      <Select {...field} label="Conflict Strategy">
                        <MenuItem value="update">Update existing</MenuItem>
                        <MenuItem value="ignore">Skip duplicates</MenuItem>
                        <MenuItem value="replace">Replace entire row</MenuItem>
                      </Select>
                    </FormControl>
                  )}
                />
              </Stack>

              {/* Batch Size */}
              <Controller
                name="batchSize"
                control={control}
                render={({ field }) => (
                  <TextField
                    {...field}
                    type="number"
                    label="Batch Size"
                    helperText="Number of rows to process per batch (100-50000)"
                    onChange={e =>
                      field.onChange(parseInt(e.target.value) || 2000)
                    }
                    sx={{ maxWidth: 200 }}
                    inputProps={{ min: 100, max: 50000 }}
                  />
                )}
              />

              {/* Schedule Preview */}
              <Alert severity="info" icon={<ScheduleIcon />}>
                <Typography variant="body2">
                  <strong>Schedule:</strong> {getCronDescription(watchSchedule)}
                  {watchTimezone && ` in ${watchTimezone}`}
                </Typography>
              </Alert>
            </Stack>
          </form>
        </Box>
      </Box>
    </Box>
  );
}
