import { useEffect, useState, useMemo, useCallback } from "react";
import { useForm, Controller, useFieldArray } from "react-hook-form";
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
  Checkbox,
  FormGroup,
  Divider,
  CircularProgress,
  Collapse,
  IconButton,
} from "@mui/material";
import {
  Save as SaveIcon,
  Schedule as ScheduleIcon,
  DataObject as DataIcon,
  Storage as DatabaseIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Code as CodeIcon,
} from "@mui/icons-material";
import { useWorkspace } from "../contexts/workspace-context";
import { useSyncJobStore } from "../store/syncJobStore";
import { useDatabaseStore } from "../store/databaseStore";
import {
  useDatabaseContentStore,
  TreeNode,
} from "../store/databaseContentStore";
import { apiClient } from "../lib/api-client";
import { useAvailableEntitiesStore } from "../store/availableEntitiesStore";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";

interface ScheduledJobFormProps {
  jobId?: string;
  isNew?: boolean;
  onSave?: () => void;
  onSaved?: (jobId: string) => void;
  onCancel?: () => void;
}

// Query interface for GraphQL/PostHog transfers
interface TransferQuery {
  name: string;
  query: string;
  data_path?: string;
  total_count_path?: string;
  has_next_page_path?: string;
  cursor_path?: string;
  batch_size?: number;
}

interface FormData {
  dataSourceId: string;
  destinationDatabaseId: string;
  destinationDatabaseName?: string;
  schedule: string;
  timezone: string;
  syncMode: "full" | "incremental";
  enabled: boolean;
  entityFilter: string[];
  queries: TransferQuery[];
}

// Entity metadata interface
interface EntityMetadata {
  name: string;
  label?: string;
  description?: string;
  subEntities?: EntityMetadata[];
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

export function ScheduledJobForm({
  jobId,
  isNew = false,
  onSave,
  onSaved,
  onCancel,
}: ScheduledJobFormProps) {
  const { currentWorkspace } = useWorkspace();
  const {
    jobs: jobsMap,
    loading: _loadingMap,
    error: errorMap,
    createJob,
    updateJob,
    clearError,
    deleteJob,
  } = useSyncJobStore();

  // Get workspace-specific data
  const jobs = useMemo(
    () => (currentWorkspace ? jobsMap[currentWorkspace.id] || [] : []),
    [currentWorkspace, jobsMap],
  );
  const storeError = currentWorkspace
    ? errorMap[currentWorkspace.id] || null
    : null;
  const databasesMap = useDatabaseStore(state => state.databases);
  const databases = useMemo(
    () => (currentWorkspace ? databasesMap[currentWorkspace.id] || [] : []),
    [currentWorkspace, databasesMap],
  );
  const fetchDatabases = useDatabaseStore(state => state.fetchDatabases);
  const fetchRoot = useDatabaseContentStore(state => state.fetchRoot);

  // Note: We no longer rely on static catalog metadata for entities. We fetch
  // dynamic entities from the backend per-connector endpoint instead.

  const [connectors, setConnectors] = useState<any[]>([]);
  const [isLoadingConnectors, setIsLoadingConnectors] = useState(false);
  const [availableDatabases, setAvailableDatabases] = useState<TreeNode[]>([]);
  const [isLoadingDatabases, setIsLoadingDatabases] = useState(false);
  const [scheduleMode, setScheduleMode] = useState<"preset" | "custom">(
    "preset",
  );
  const requiresDestinationDatabaseName = availableDatabases.length > 0;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local saved flag for future UX enhancements (snackbar/toast)
  // Currently unused; keeping logic minimal to avoid noisy lint.
  const [currentJobId, setCurrentJobId] = useState<string | undefined>(jobId);
  const [isNewMode, setIsNewMode] = useState(isNew);

  // Entity selection state
  const [availableEntities, setAvailableEntities] = useState<EntityMetadata[]>(
    [],
  );
  const [selectedEntities, setSelectedEntities] = useState<string[]>([]);
  const [selectAllEntities, setSelectAllEntities] = useState(true);
  const [expandedEntities, setExpandedEntities] = useState<string[]>([]);
  const [entitiesLoadState, setEntitiesLoadState] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");

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
      schedule: "0 * * * *", // Default hourly
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      syncMode: "full",
      enabled: true,
      entityFilter: [],
      queries: [],
    },
  });

  const watchSchedule = watch("schedule");
  const watchTimezone = watch("timezone");
  const watchDataSourceId = watch("dataSourceId");
  const watchDestinationDatabaseId = watch("destinationDatabaseId");

  // Field array for queries (schema-driven)
  const {
    fields: queryFields,
    append: appendQuery,
    remove: removeQuery,
  } = useFieldArray({
    control,
    name: "queries",
  });

  // Get selected data source
  const selectedDataSource = useMemo(() => {
    return connectors.find(ds => ds._id === watchDataSourceId);
  }, [connectors, watchDataSourceId]);

  // Fetch connector schema to check for transferQueries
  const { schemas, fetchSchema } = useConnectorCatalogStore();
  const [transferQueriesSchema, setTransferQueriesSchema] = useState<any>(null);

  useEffect(() => {
    if (!selectedDataSource?.type) {
      setTransferQueriesSchema(null);
      return;
    }

    const connectorType = selectedDataSource.type;
    const cachedSchema = schemas[connectorType];

    if (cachedSchema?.transferQueries) {
      setTransferQueriesSchema(cachedSchema.transferQueries);
    } else {
      // Fetch schema if not cached
      fetchSchema(connectorType).then(schema => {
        if (schema?.transferQueries) {
          setTransferQueriesSchema(schema.transferQueries);
        } else {
          setTransferQueriesSchema(null);
        }
      });
    }
  }, [selectedDataSource?.type, schemas, fetchSchema]);

  // Connector requires queries if schema has transferQueries property
  const requiresQueries = !!transferQueriesSchema;

  // Fetch available databases when destination changes
  useEffect(() => {
    const loadDatabases = async () => {
      if (!watchDestinationDatabaseId || !currentWorkspace?.id) {
        setAvailableDatabases([]);
        setValue("destinationDatabaseName", "");
        setIsLoadingDatabases(false);
        return;
      }

      setAvailableDatabases([]);
      setIsLoadingDatabases(true);
      try {
        const nodes = await fetchRoot(
          currentWorkspace.id,
          watchDestinationDatabaseId,
        );
        // Filter only for nodes that are actually databases (kind="database")
        // This indicates a server connection (multi-db) vs a direct database connection
        const dbNodes = nodes.filter(node => node.kind === "database");
        setAvailableDatabases(dbNodes);
        const currentValue = getValues("destinationDatabaseName") || "";
        if (dbNodes.length === 0) {
          setValue("destinationDatabaseName", "");
        } else {
          const hasCurrent = dbNodes.some(node => node.id === currentValue);
          if (!hasCurrent) {
            setValue("destinationDatabaseName", "");
          }
        }
      } catch (err) {
        console.error("Failed to fetch databases:", err);
        setAvailableDatabases([]);
        setValue("destinationDatabaseName", "");
      } finally {
        setIsLoadingDatabases(false);
      }
    };

    loadDatabases();
  }, [
    watchDestinationDatabaseId,
    currentWorkspace?.id,
    fetchRoot,
    getValues,
    setValue,
  ]);

  // Fetch connectors
  const fetchDataSources = async (workspaceId: string) => {
    setIsLoadingConnectors(true);
    try {
      const response = await apiClient.get<{
        success: boolean;
        data: any[];
      }>(`/workspaces/${workspaceId}/connectors`);

      if (response.success) {
        setConnectors(response.data || []);
      }
    } catch (error) {
      console.error("Failed to fetch connectors:", error);
      setError("Failed to load connectors");
    } finally {
      setIsLoadingConnectors(false);
    }
  };

  // Fetch entities via store for selected connector
  const updateAvailableEntities = useCallback(
    (dataSourceId: string) => {
      if (!dataSourceId) {
        setAvailableEntities([]);
        setEntitiesLoadState("idle");
        return;
      }

      // If we're still loading data sources, show loading state
      if (isLoadingConnectors || !connectors.length) {
        setEntitiesLoadState("loading");
        return;
      }

      const selectedDataSource = connectors.find(ds => ds._id === dataSourceId);
      if (!selectedDataSource) {
        setAvailableEntities([]);
        setEntitiesLoadState("error");
        return;
      }

      // Fetch via store (centralized data flow)
      setEntitiesLoadState("loading");
      (async () => {
        try {
          if (!currentWorkspace?.id) throw new Error("No workspace selected");
          const list = await useAvailableEntitiesStore
            .getState()
            .fetch(currentWorkspace.id, dataSourceId);

          // The API now returns EntityMetadata[], but the store might still return string[]
          // Convert if necessary
          let entityMetadata: EntityMetadata[] = [];
          if (Array.isArray(list) && list.length > 0) {
            if (typeof list[0] === "string") {
              // Handle string array
              entityMetadata = (list as unknown as string[]).map(
                (entity: string) => ({
                  name: entity,
                  label: entity.charAt(0).toUpperCase() + entity.slice(1),
                }),
              );
            } else {
              // Handle EntityMetadata array
              entityMetadata = list as unknown as EntityMetadata[];
            }
          }

          setAvailableEntities(entityMetadata);
          setEntitiesLoadState("loaded");

          // Auto-expand entities with sub-entities
          const entitiesToExpand = entityMetadata
            .filter(e => e.subEntities && e.subEntities.length > 0)
            .map(e => e.name);
          setExpandedEntities(entitiesToExpand);

          if (isNewMode || (!currentJobId && jobs.length === 0)) {
            setSelectedEntities([]);
            setSelectAllEntities(true);
            setValue("entityFilter", []);
          }
        } catch (_err) {
          setAvailableEntities([]);
          setEntitiesLoadState("error");
        }
      })();
    },
    [
      isLoadingConnectors,
      connectors,
      currentWorkspace?.id,
      isNewMode,
      currentJobId,
      jobs.length,
      setValue,
    ],
  );

  // Handle entity selection changes
  const handleEntityChange = (
    entity: string,
    checked: boolean,
    isSubEntity?: boolean,
    parentEntity?: string,
  ) => {
    let newSelectedEntities: string[];

    if (isSubEntity && parentEntity) {
      // Handle sub-entity selection
      const subEntityKey = `${parentEntity}:${entity}`;
      if (checked) {
        newSelectedEntities = [...selectedEntities, subEntityKey];
      } else {
        newSelectedEntities = selectedEntities.filter(e => e !== subEntityKey);
      }
    } else {
      // Handle parent entity selection
      if (checked) {
        newSelectedEntities = [...selectedEntities, entity];
      } else {
        // Remove parent entity and all its sub-entities
        newSelectedEntities = selectedEntities.filter(e => {
          return e !== entity && !e.startsWith(`${entity}:`);
        });
      }
    }

    setSelectedEntities(newSelectedEntities);

    // Calculate total selectable entities including sub-entities
    const totalSelectableEntities = availableEntities.reduce((count, e) => {
      return count + 1 + (e.subEntities?.length || 0);
    }, 0);

    setSelectAllEntities(
      newSelectedEntities.length === totalSelectableEntities,
    );

    // Update form value - empty array means sync all entities
    setValue(
      "entityFilter",
      newSelectedEntities.length === totalSelectableEntities
        ? []
        : newSelectedEntities,
      {
        shouldDirty: true,
      },
    );
  };

  // Toggle entity expansion
  const toggleEntityExpansion = (entityName: string) => {
    setExpandedEntities(prev =>
      prev.includes(entityName)
        ? prev.filter(e => e !== entityName)
        : [...prev, entityName],
    );
  };

  // Handle "All Entities" checkbox
  const handleSelectAllChange = (checked: boolean) => {
    setSelectAllEntities(checked);
    if (checked) {
      setSelectedEntities(availableEntities.map(e => e.name));
      setValue("entityFilter", [], { shouldDirty: true }); // Empty means all
    } else {
      setSelectedEntities([]);
      // When unchecking "All Entities", start with no specific entities selected
      // The user must then select specific entities, or re-check "All Entities"
      setValue("entityFilter", [], { shouldDirty: true });
    }
  };

  // Load initial data
  useEffect(() => {
    if (currentWorkspace?.id) {
      fetchDataSources(currentWorkspace.id);
      fetchDatabases();
    }
  }, [currentWorkspace?.id, fetchDatabases]);

  // Update entities when data source changes
  useEffect(() => {
    updateAvailableEntities(watchDataSourceId);
  }, [
    watchDataSourceId,
    connectors,
    isLoadingConnectors,
    currentWorkspace?.id,
    updateAvailableEntities,
  ]);

  // Load job data if editing
  useEffect(() => {
    if (!isNewMode && currentJobId && jobs.length > 0) {
      const job = jobs.find(j => j._id === currentJobId);
      if (job && job.type === "scheduled") {
        const formData: FormData = {
          dataSourceId: (job.dataSourceId as any)._id,
          destinationDatabaseId: (job.destinationDatabaseId as any)._id,
          destinationDatabaseName: job.destinationDatabaseName || "",
          schedule: job.schedule?.cron || "0 * * * *",
          timezone: job.schedule?.timezone || "UTC",
          syncMode: job.syncMode as "full" | "incremental",
          enabled: job.enabled,
          entityFilter: job.entityFilter || [],
          queries: (job as any).queries || [],
        };

        reset(formData);

        // Set entity selection state
        if (job.entityFilter && job.entityFilter.length > 0) {
          setSelectedEntities(job.entityFilter);
          setSelectAllEntities(false);
        } else {
          setSelectAllEntities(true);
          setSelectedEntities([]);
        }

        // Check if using a preset
        const isPreset = SCHEDULE_PRESETS.some(
          p => p.cron === (job.schedule?.cron || "0 * * * *"),
        );
        setScheduleMode(isPreset ? "preset" : "custom");
      }
    }
  }, [isNewMode, currentJobId, jobs, reset]);

  // Re-apply job entity selection after entities are loaded
  useEffect(() => {
    if (
      !isNewMode &&
      currentJobId &&
      jobs.length > 0 &&
      availableEntities.length > 0
    ) {
      const job = jobs.find(j => j._id === currentJobId);
      if (job && job.entityFilter && job.entityFilter.length > 0) {
        // Validate that the job's entities exist in available entities
        // Also check for sub-entities (e.g., "activities:Call")
        const availableEntityNames = availableEntities.flatMap(e => [
          e.name,
          ...(e.subEntities?.map(sub => `${e.name}:${sub.name}`) || []),
        ]);
        const validEntities = job.entityFilter.filter(entity =>
          availableEntityNames.includes(entity),
        );
        if (validEntities.length > 0) {
          setSelectedEntities(validEntities);
          setSelectAllEntities(false);
        }
      }
    }
  }, [isNewMode, currentJobId, jobs, availableEntities]);

  // Sync form entityFilter with selection state
  useEffect(() => {
    if (selectAllEntities) {
      setValue("entityFilter", [], { shouldDirty: true });
    } else {
      setValue("entityFilter", selectedEntities, { shouldDirty: true });
    }
  }, [selectAllEntities, selectedEntities, setValue]);

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

    // Validate entity selection (skip for connectors that use queries instead)
    if (
      !requiresQueries &&
      !selectAllEntities &&
      selectedEntities.length === 0
    ) {
      setError(
        "Please select at least one entity to sync, or choose 'All Entities'",
      );
      return;
    }

    // Validate queries for connectors with transferQueries schema
    if (requiresQueries && (!data.queries || data.queries.length === 0)) {
      setError("Please add at least one query to define what data to sync");
      return;
    }
    if (
      availableDatabases.length > 0 &&
      !data.destinationDatabaseName?.trim()
    ) {
      setError(
        "Please select a destination database within the selected server.",
      );
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

      // Create payload compatible with the API
      const payload: any = {
        name: generatedName,
        type: "scheduled",
        dataSourceId: data.dataSourceId,
        destinationDatabaseId: data.destinationDatabaseId,
        destinationDatabaseName: data.destinationDatabaseName?.trim() || null,
        syncMode: data.syncMode,
        enabled: data.enabled,
        entityFilter: data.entityFilter,
        queries: data.queries, // GraphQL/PostHog queries
        schedule: {
          cron: data.schedule,
          timezone: data.timezone,
        },
      };

      // Intentionally reduced noisy console logging in production

      let newJob;
      if (isNewMode) {
        newJob = await createJob(currentWorkspace.id, payload);
        // Refresh the jobs list
        await useSyncJobStore.getState().fetchJobs(currentWorkspace.id);

        // Switch to edit mode and update the jobId
        setIsNewMode(false);
        setCurrentJobId(newJob._id);

        // Notify parent that a new job has been created
        onSaved?.(newJob._id);

        // Reset form with the new job data to mark it as pristine
        reset(data);

        // Notify parent if needed
        onSave?.();
      } else if (currentJobId) {
        await updateJob(currentWorkspace.id, currentJobId, payload);
        // Refresh the jobs list
        await useSyncJobStore.getState().fetchJobs(currentWorkspace.id);

        // Reset form to mark it as pristine
        reset(data);

        onSaved?.(currentJobId);

        // Notify parent if needed
        onSave?.();
      }
    } catch (error) {
      console.error("Failed to save sync job:", error);
      setError(
        error instanceof Error ? error.message : "Failed to save sync job",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const getCronDescription = (cron: string) => {
    const preset = SCHEDULE_PRESETS.find(p => p.cron === cron);
    if (preset) return preset.label;

    // Basic cron parsing for common patterns
    const parts = cron.split(" ");
    if (parts.length !== 5) return "Invalid cron expression";

    const [minute, hour, dayMonth, month, dayWeek] = parts;

    if (
      minute === "0" &&
      hour === "*" &&
      dayMonth === "*" &&
      month === "*" &&
      dayWeek === "*"
    ) {
      return "Every hour";
    }
    if (
      minute === "*" &&
      hour === "*" &&
      dayMonth === "*" &&
      month === "*" &&
      dayWeek === "*"
    ) {
      return "Every minute";
    }

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
        {!isNewMode && currentJobId && (
          <Button
            color="error"
            size="small"
            startIcon={<DeleteIcon />}
            onClick={async () => {
              if (confirm("Are you sure you want to delete this sync job?")) {
                if (currentWorkspace?.id) {
                  try {
                    await deleteJob(currentWorkspace.id, currentJobId);
                    // Close the editor after successful deletion
                    onCancel?.();
                  } catch (error) {
                    console.error("Failed to delete sync job:", error);
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
            {currentJobId && (
              <>
                <strong>Job ID:</strong> {currentJobId}
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
                        disabled={isLoadingConnectors}
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

              {watchDestinationDatabaseId && (
                <Box>
                  {isLoadingDatabases ? (
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 2,
                        py: 1,
                        px: 0.5,
                      }}
                    >
                      <CircularProgress size={20} />
                      <Typography variant="body2" color="text.secondary">
                        Loading databases for this destination...
                      </Typography>
                    </Box>
                  ) : requiresDestinationDatabaseName ? (
                    <Stack spacing={1}>
                      <Controller
                        name="destinationDatabaseName"
                        control={control}
                        rules={{
                          validate: value =>
                            !requiresDestinationDatabaseName ||
                            (value && value.trim().length > 0) ||
                            "Destination database is required for this server",
                        }}
                        render={({ field }) => (
                          <FormControl
                            fullWidth
                            error={!!errors.destinationDatabaseName}
                          >
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
                              {errors.destinationDatabaseName?.message ||
                                "Select which database inside this server should receive synced data"}
                            </FormHelperText>
                          </FormControl>
                        )}
                      />
                      <Alert severity="info" sx={{ mb: 1 }}>
                        <Typography variant="body2">
                          This destination is a server/cluster with multiple
                          databases. Choose the specific database that should
                          receive the synced records.
                        </Typography>
                      </Alert>
                    </Stack>
                  ) : null}
                </Box>
              )}

              {/* Entity Selection - only show for connectors without transferQueries */}
              {watchDataSourceId && !requiresQueries && (
                <>
                  <Divider />
                  <Box>
                    {entitiesLoadState === "loading" ? (
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          gap: 2,
                          p: 2,
                        }}
                      >
                        <CircularProgress size={20} />
                        <Typography variant="body2" color="text.secondary">
                          Loading available entities...
                        </Typography>
                      </Box>
                    ) : entitiesLoadState === "loaded" &&
                      availableEntities.length > 0 ? (
                      <Box>
                        {/* Select All Option */}
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={selectAllEntities}
                              indeterminate={
                                selectedEntities.length > 0 &&
                                selectedEntities.length <
                                  availableEntities.length
                              }
                              onChange={e =>
                                handleSelectAllChange(e.target.checked)
                              }
                            />
                          }
                          label={
                            <Box
                              sx={{
                                display: "flex",
                                alignItems: "center",
                                gap: 1,
                              }}
                            >
                              <Typography variant="body2" fontWeight="bold">
                                Entities
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                ({availableEntities.length} total)
                              </Typography>
                            </Box>
                          }
                        />

                        {/* Individual Entity Options */}
                        <FormGroup sx={{ ml: 2 }}>
                          {availableEntities.map(entity => (
                            <Box key={entity.name}>
                              <Box
                                sx={{ display: "flex", alignItems: "center" }}
                              >
                                {entity.subEntities &&
                                  entity.subEntities.length > 0 && (
                                    <IconButton
                                      size="small"
                                      onClick={() =>
                                        toggleEntityExpansion(entity.name)
                                      }
                                      sx={{ p: 0.5 }}
                                    >
                                      {expandedEntities.includes(
                                        entity.name,
                                      ) ? (
                                        <ExpandLessIcon />
                                      ) : (
                                        <ExpandMoreIcon />
                                      )}
                                    </IconButton>
                                  )}
                                <FormControlLabel
                                  control={
                                    <Checkbox
                                      checked={
                                        selectAllEntities ||
                                        selectedEntities.includes(
                                          entity.name,
                                        ) ||
                                        entity.subEntities?.some(sub =>
                                          selectedEntities.includes(
                                            `${entity.name}:${sub.name}`,
                                          ),
                                        ) ||
                                        false
                                      }
                                      onChange={e =>
                                        handleEntityChange(
                                          entity.name,
                                          e.target.checked,
                                        )
                                      }
                                      disabled={selectAllEntities}
                                      indeterminate={
                                        !selectAllEntities &&
                                        !selectedEntities.includes(
                                          entity.name,
                                        ) &&
                                        entity.subEntities?.some(sub =>
                                          selectedEntities.includes(
                                            `${entity.name}:${sub.name}`,
                                          ),
                                        ) &&
                                        !entity.subEntities?.every(sub =>
                                          selectedEntities.includes(
                                            `${entity.name}:${sub.name}`,
                                          ),
                                        )
                                      }
                                    />
                                  }
                                  label={
                                    <Typography variant="body2">
                                      {entity.label || entity.name}
                                      {entity.description && (
                                        <Typography
                                          variant="caption"
                                          color="text.secondary"
                                          display="block"
                                        >
                                          {entity.description}
                                        </Typography>
                                      )}
                                    </Typography>
                                  }
                                />
                              </Box>
                              {/* Sub-entities */}
                              {entity.subEntities &&
                                entity.subEntities.length > 0 && (
                                  <Collapse
                                    in={expandedEntities.includes(entity.name)}
                                  >
                                    <FormGroup sx={{ ml: 4 }}>
                                      {entity.subEntities.map(subEntity => (
                                        <FormControlLabel
                                          key={`${entity.name}:${subEntity.name}`}
                                          control={
                                            <Checkbox
                                              checked={
                                                selectAllEntities ||
                                                selectedEntities.includes(
                                                  entity.name,
                                                ) ||
                                                selectedEntities.includes(
                                                  `${entity.name}:${subEntity.name}`,
                                                )
                                              }
                                              onChange={e =>
                                                handleEntityChange(
                                                  subEntity.name,
                                                  e.target.checked,
                                                  true,
                                                  entity.name,
                                                )
                                              }
                                              disabled={
                                                selectAllEntities ||
                                                selectedEntities.includes(
                                                  entity.name,
                                                )
                                              }
                                            />
                                          }
                                          label={
                                            <Typography variant="body2">
                                              {subEntity.label ||
                                                subEntity.name}
                                              {subEntity.description && (
                                                <Typography
                                                  variant="caption"
                                                  color="text.secondary"
                                                  display="block"
                                                >
                                                  {subEntity.description}
                                                </Typography>
                                              )}
                                            </Typography>
                                          }
                                        />
                                      ))}
                                    </FormGroup>
                                  </Collapse>
                                )}
                            </Box>
                          ))}
                        </FormGroup>

                        <Alert
                          severity={
                            selectAllEntities || selectedEntities.length > 0
                              ? "info"
                              : "warning"
                          }
                          sx={{ mt: 2 }}
                        >
                          <Typography variant="body2">
                            {selectAllEntities
                              ? "All entities will be synced from this connector."
                              : selectedEntities.length > 0
                                ? `${selectedEntities.length} entities/sub-entities selected for sync.`
                                : "No entities selected. Please select at least one entity or choose 'All Entities' to proceed."}
                          </Typography>
                        </Alert>
                      </Box>
                    ) : entitiesLoadState === "loaded" ? (
                      <Alert severity="warning">
                        No entities available for this connector.
                      </Alert>
                    ) : null}
                  </Box>
                </>
              )}

              {/* Queries Configuration (schema-driven) */}
              {requiresQueries && transferQueriesSchema && (
                <>
                  <Divider />
                  <Box>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        mb: 2,
                      }}
                    >
                      <Typography
                        variant="subtitle2"
                        sx={{ display: "flex", alignItems: "center", gap: 1 }}
                      >
                        <CodeIcon fontSize="small" />
                        {transferQueriesSchema.label || "Queries"}
                      </Typography>
                      <Button
                        size="small"
                        startIcon={<AddIcon />}
                        onClick={() => {
                          // Create default values from schema
                          const defaultQuery: Record<string, any> = {};
                          transferQueriesSchema.fields?.forEach((f: any) => {
                            if (f.default !== undefined) {
                              defaultQuery[f.name] = f.default;
                            } else if (f.type === "number") {
                              defaultQuery[f.name] = undefined;
                            } else {
                              defaultQuery[f.name] = "";
                            }
                          });
                          appendQuery(defaultQuery);
                        }}
                      >
                        Add Query
                      </Button>
                    </Box>

                    {queryFields.length === 0 ? (
                      <Alert severity="info">
                        <Typography variant="body2">
                          No queries configured. Add at least one query to
                          define what data to sync from this connector.
                        </Typography>
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
                            {/* Render fields from schema */}
                            {transferQueriesSchema.fields?.map(
                              (schemaField: any) => (
                                <Controller
                                  key={schemaField.name}
                                  name={`queries.${index}.${schemaField.name}`}
                                  control={control}
                                  rules={{
                                    required: schemaField.required
                                      ? `${schemaField.label} is required`
                                      : false,
                                  }}
                                  render={({
                                    field: formField,
                                    fieldState,
                                  }) => {
                                    if (schemaField.type === "textarea") {
                                      return (
                                        <TextField
                                          {...formField}
                                          label={schemaField.label}
                                          placeholder={schemaField.placeholder}
                                          error={!!fieldState.error}
                                          helperText={
                                            fieldState.error?.message ||
                                            schemaField.helperText
                                          }
                                          multiline
                                          rows={schemaField.rows || 6}
                                          fullWidth
                                          sx={{
                                            "& .MuiInputBase-input": {
                                              fontFamily: "monospace",
                                              fontSize: "0.875rem",
                                            },
                                          }}
                                        />
                                      );
                                    }

                                    if (schemaField.type === "number") {
                                      return (
                                        <TextField
                                          {...formField}
                                          label={schemaField.label}
                                          type="number"
                                          placeholder={schemaField.placeholder}
                                          error={!!fieldState.error}
                                          helperText={
                                            fieldState.error?.message ||
                                            schemaField.helperText
                                          }
                                          size="small"
                                          sx={{ width: 150 }}
                                          onChange={e =>
                                            formField.onChange(
                                              e.target.value
                                                ? parseInt(e.target.value)
                                                : undefined,
                                            )
                                          }
                                        />
                                      );
                                    }

                                    // Default: string field
                                    return (
                                      <TextField
                                        {...formField}
                                        label={schemaField.label}
                                        placeholder={schemaField.placeholder}
                                        error={!!fieldState.error}
                                        helperText={
                                          fieldState.error?.message ||
                                          schemaField.helperText
                                        }
                                        size="small"
                                        fullWidth
                                      />
                                    );
                                  }}
                                />
                              ),
                            )}
                          </Stack>
                        </Box>
                      ))
                    )}
                  </Box>
                </>
              )}

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
                    rules={{
                      required: "Schedule is required",
                    }}
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

              {/* Sync Mode and Enabled */}
              <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                <Controller
                  name="syncMode"
                  control={control}
                  render={({ field }) => (
                    <FormControl fullWidth>
                      <InputLabel>Sync Mode</InputLabel>
                      <Select {...field} label="Sync Mode">
                        <MenuItem value="full">Full Sync</MenuItem>
                        <MenuItem value="incremental">
                          Incremental Sync
                        </MenuItem>
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
                        label="Enable Job"
                      />
                    )}
                  />
                </Box>
              </Stack>

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
