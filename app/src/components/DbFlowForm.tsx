import {
  useEffect,
  useState,
  useMemo,
  forwardRef,
  useImperativeHandle,
  useRef,
  useCallback,
} from "react";
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
  Stepper,
  Step,
  StepLabel,
} from "@mui/material";
import { useTheme as useMuiTheme } from "@mui/material/styles";
import {
  Save as SaveIcon,
  Schedule as ScheduleIcon,
  Storage as DatabaseIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
  PlayArrow as ValidateIcon,
  CheckCircle as CheckIcon,
  Warning as WarningIcon,
  NavigateNext as NextIcon,
  NavigateBefore as BackIcon,
  Science as AnalyzeIcon,
} from "@mui/icons-material";
import Editor, { Monaco, OnMount } from "@monaco-editor/react";
import { useWorkspace } from "../contexts/workspace-context";
import { useFlowStore } from "../store/flowStore";
import { useSchemaStore, TreeNode } from "../store/schemaStore";
import { trackEvent } from "../lib/analytics";
import { ConnectionSelector } from "./ConnectionSelector";
import { useSqlAutocomplete } from "../hooks/useSqlAutocomplete";
import { SchemaMappingTable, ColumnMapping } from "./SchemaMappingTable";

interface DbFlowFormProps {
  flowId?: string;
  isNew?: boolean;
  onSave?: () => void;
  onSaved?: (flowId: string) => void;
  onCancel?: () => void;
}

/**
 * Ref interface for DbFlowForm - methods exposed to parent components and AI agent
 */
export interface DbFlowFormRef {
  /** Get all current form values */
  getFormState(): Record<string, unknown>;
  /** Set a single form field */
  setField(name: string, value: unknown): void;
  /** Set multiple form fields at once */
  setMultipleFields(fields: Record<string, unknown>): void;
  /** Trigger query validation */
  validateQuery(): Promise<void>;
  /** Set column mappings for schema transformation */
  setColumnMappings(mappings: ColumnMapping[]): void;
  /** Get current column mappings */
  getColumnMappings(): ColumnMapping[];
  /** Navigate to a specific step */
  goToStep(step: number): void;
  /** Get current step */
  getCurrentStep(): number;
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
  keyColumns?: string | string[];
  conflictStrategy: "upsert" | "ignore" | "replace";
  batchSize: number;
  enabled: boolean;
  createTableIfNotExists: boolean;
  // Pagination config
  paginationMode: "offset" | "keyset";
  keysetColumn?: string;
  keysetDirection?: "asc" | "desc";
  // Schema mapping (Step 2)
  columnMappings: ColumnMapping[];
  schemaMappingConfirmed: boolean;
}

// Wizard steps
const STEPS = [
  { label: "Source", description: "Configure source database and query" },
  { label: "Schema Mapping", description: "Review and confirm column types" },
  { label: "Destination", description: "Configure destination and schedule" },
];

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

export const DbFlowForm = forwardRef<DbFlowFormRef, DbFlowFormProps>(
  function DbFlowForm(
    { flowId, isNew = false, onSave, onSaved, onCancel },
    ref,
  ) {
    const { currentWorkspace } = useWorkspace();
    const {
      flows: flowsMap,
      loading: _loadingMap,
      error: errorMap,
      createFlow,
      updateFlow,
      clearError,
      deleteFlow,
      validateDbQuery,
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

    // Wizard step state
    const [activeStep, setActiveStep] = useState(0);

    // Source and destination database lists
    const [sourceDatabases, setSourceDatabases] = useState<TreeNode[]>([]);
    const [destDatabases, setDestDatabases] = useState<TreeNode[]>([]);
    const [isLoadingSourceDbs, setIsLoadingSourceDbs] = useState(false);
    const [isLoadingDestDbs, setIsLoadingDestDbs] = useState(false);

    // Track previous connection IDs to detect user-initiated changes vs form reset
    const prevDestConnectionIdRef = useRef<string | null>(null);
    const isFormInitializedRef = useRef(false);

    // Query validation state
    const [isValidating, setIsValidating] = useState(false);
    const [validationResult, setValidationResult] = useState<{
      success: boolean;
      columns?: Array<{ name: string; type: string }>;
      sampleRow?: Record<string, unknown>;
      warnings?: string[];
      error?: string;
    } | null>(null);

    // Monaco editor refs - using Parameters<OnMount>[0] and Monaco types from @monaco-editor/react
    const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
    const monacoRef = useRef<Monaco | null>(null);
    const templateCompletionDisposable = useRef<{ dispose: () => void } | null>(
      null,
    );

    // Theme for Monaco
    const muiTheme = useMuiTheme();
    const effectiveMode = muiTheme.palette.mode;

    // Register template placeholder completions
    const registerTemplateCompletions = useCallback((monaco: Monaco) => {
      // Dispose any existing provider
      if (templateCompletionDisposable.current) {
        templateCompletionDisposable.current.dispose();
      }

      templateCompletionDisposable.current =
        monaco.languages.registerCompletionItemProvider("sql", {
          triggerCharacters: ["{"],
          provideCompletionItems: (model, position) => {
            const textBefore = model.getValueInRange({
              startLineNumber: position.lineNumber,
              startColumn: Math.max(1, position.column - 2),
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            });

            // Only suggest when user types "{{"
            if (textBefore !== "{{") {
              return { suggestions: [] };
            }

            const word = model.getWordUntilPosition(position);
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };

            return {
              suggestions: [
                {
                  label: "limit}}",
                  insertText: "limit}}",
                  kind: monaco.languages.CompletionItemKind.Snippet,
                  detail: "Batch size (e.g., 2000)",
                  documentation:
                    "Replaced with the batch size at runtime. Controls how many rows are fetched per iteration.",
                  range,
                },
                {
                  label: "offset}}",
                  insertText: "offset}}",
                  kind: monaco.languages.CompletionItemKind.Snippet,
                  detail: "Current offset for pagination",
                  documentation:
                    "Replaced with the current pagination offset. Increments by batch size each iteration (0, 2000, 4000, ...).",
                  range,
                },
                {
                  label: "last_sync_value}}",
                  insertText: "last_sync_value}}",
                  kind: monaco.languages.CompletionItemKind.Snippet,
                  detail: "Last value of tracking column",
                  documentation:
                    "Replaced with the last synced value of the tracking column. Used for incremental sync to only fetch new/changed data.",
                  range,
                },
                {
                  label: "keyset_value}}",
                  insertText: "keyset_value}}",
                  kind: monaco.languages.CompletionItemKind.Snippet,
                  detail: "Last keyset column value",
                  documentation:
                    "Replaced with the last value of the keyset column. Used for keyset pagination which is more efficient than offset for large tables.",
                  range,
                },
              ],
            };
          },
        });
    }, []);

    // Cleanup template completions on unmount
    useEffect(() => {
      return () => {
        if (templateCompletionDisposable.current) {
          templateCompletionDisposable.current.dispose();
        }
      };
    }, []);

    const {
      control,
      handleSubmit,
      formState: { errors },
      reset,
      watch,
      setValue,
      getValues,
      trigger,
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
        conflictStrategy: "upsert",
        batchSize: 2000,
        enabled: true,
        createTableIfNotExists: true,
        paginationMode: "offset",
        keysetColumn: "",
        keysetDirection: "asc",
        columnMappings: [],
        schemaMappingConfirmed: false,
      },
    });

    // Expose methods to parent via ref (for AI agent integration)
    useImperativeHandle(ref, () => ({
      getFormState: () => getValues() as unknown as Record<string, unknown>,
      setField: (name: string, value: unknown) => {
        setValue(name as keyof FormData, value as any, {
          shouldValidate: true,
        });
      },
      setMultipleFields: (fields: Record<string, unknown>) => {
        Object.entries(fields).forEach(([field, value]) => {
          setValue(field as keyof FormData, value as any, {
            shouldValidate: false,
          });
        });
        trigger(); // Validate all at once
      },
      validateQuery: async () => {
        await handleValidateQuery();
      },
      setColumnMappings: (mappings: ColumnMapping[]) => {
        setValue("columnMappings", mappings, { shouldValidate: true });
        // Auto-navigate to step 2 if we have mappings
        if (mappings.length > 0 && activeStep === 0) {
          setActiveStep(1);
        }
      },
      getColumnMappings: () => getValues("columnMappings") || [],
      goToStep: (step: number) => {
        if (step >= 0 && step < STEPS.length) {
          setActiveStep(step);
        }
      },
      getCurrentStep: () => activeStep,
    }));

    const watchSchedule = watch("schedule");
    const watchTimezone = watch("timezone");
    const watchSourceConnectionId = watch("sourceConnectionId");
    const watchSourceDatabase = watch("sourceDatabase");
    const watchQuery = watch("query");
    const watchDestConnectionId = watch("destinationConnectionId");
    const watchSyncMode = watch("syncMode");
    const watchPaginationMode = watch("paginationMode");
    const watchColumnMappings = watch("columnMappings");
    const watchSchemaMappingConfirmed = watch("schemaMappingConfirmed");

    // Step navigation helpers
    const handleNext = () => {
      setActiveStep(prev => Math.min(prev + 1, STEPS.length - 1));
    };

    const handleBack = () => {
      setActiveStep(prev => Math.max(prev - 1, 0));
    };

    const canProceedToStep2 = useMemo(() => {
      return (
        watchSourceConnectionId &&
        watchQuery?.trim() &&
        validationResult?.success
      );
    }, [watchSourceConnectionId, watchQuery, validationResult]);

    const canProceedToStep3 = useMemo(() => {
      return (
        watchColumnMappings?.length > 0 &&
        watchColumnMappings.every(m => m.destType) &&
        watchSchemaMappingConfirmed
      );
    }, [watchColumnMappings, watchSchemaMappingConfirmed]);

    // Get the selected source connection to check its type
    const selectedSourceConnection = useMemo(
      () => databases.find(db => db.id === watchSourceConnectionId),
      [databases, watchSourceConnectionId],
    );

    // Check if source is BigQuery (uses datasets instead of databases)
    const isBigQuerySource = selectedSourceConnection?.type === "bigquery";

    // Get the selected destination connection to check its type
    const selectedDestConnection = useMemo(
      () => databases.find(db => db.id === watchDestConnectionId),
      [databases, watchDestConnectionId],
    );

    // Check if destination is BigQuery (uses datasets instead of schemas)
    const isBigQueryDest = selectedDestConnection?.type === "bigquery";

    // Check if destination is PostgreSQL (uses schemas)
    const isPostgresDest = selectedDestConnection?.type === "postgresql";

    // Determine if we should show schema/dataset field
    const showSchemaField = isBigQueryDest || isPostgresDest;

    // Callbacks for SQL autocomplete (must be stable to avoid re-registrations)
    const getSourceConnectionId = useCallback(
      () => watchSourceConnectionId,
      [watchSourceConnectionId],
    );
    const getSourceConnectionType = useCallback(
      () => selectedSourceConnection?.type,
      [selectedSourceConnection],
    );

    // SQL autocomplete for schema-aware completions
    useSqlAutocomplete({
      monaco: monacoRef.current,
      getWorkspaceId: () => currentWorkspace?.id,
      getConnectionId: getSourceConnectionId,
      getConnectionType: getSourceConnectionType,
    });

    // Validate query handler
    const handleValidateQuery = async () => {
      if (
        !currentWorkspace?.id ||
        !watchSourceConnectionId ||
        !watchQuery?.trim()
      ) {
        setValidationResult({
          success: false,
          error: "Please select a source connection and enter a query",
        });
        return;
      }

      setIsValidating(true);
      setValidationResult(null);

      try {
        const result = await validateDbQuery(
          currentWorkspace.id,
          watchSourceConnectionId,
          watchQuery.trim(),
          watchSourceDatabase || undefined,
        );

        setValidationResult({
          success: result.success,
          columns: result.columns,
          sampleRow: result.sampleRow,
          warnings: result.safetyCheck?.warnings,
          error: result.error,
        });
      } catch (err) {
        setValidationResult({
          success: false,
          error: err instanceof Error ? err.message : "Validation failed",
        });
      } finally {
        setIsValidating(false);
      }
    };

    // Clear validation when query changes
    useEffect(() => {
      setValidationResult(null);
    }, [watchQuery, watchSourceConnectionId, watchSourceDatabase]);

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
          // Include both "database" (PostgreSQL, etc.) and "dataset" (BigQuery) nodes
          const dbNodes = nodes.filter(
            node => node.kind === "database" || node.kind === "dataset",
          );
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
    }, [
      watchSourceConnectionId,
      currentWorkspace?.id,
      ensureTreeRoot,
      setValue,
    ]);

    // Fetch destination databases when destination connection changes
    useEffect(() => {
      const loadDestDatabases = async () => {
        if (!watchDestConnectionId || !currentWorkspace?.id) {
          setDestDatabases([]);
          setValue("destinationDatabase", "");
          setValue("destinationSchema", ""); // Clear schema/dataset when connection changes
          return;
        }

        // Determine if this is a user-initiated change (not initial form load)
        const isUserChange =
          isFormInitializedRef.current &&
          prevDestConnectionIdRef.current !== null &&
          prevDestConnectionIdRef.current !== watchDestConnectionId;

        setIsLoadingDestDbs(true);
        try {
          const nodes = await ensureTreeRoot(
            currentWorkspace.id,
            watchDestConnectionId,
          );
          // Include both "database" (PostgreSQL, etc.) and "dataset" (BigQuery) nodes
          const dbNodes = nodes.filter(
            node => node.kind === "database" || node.kind === "dataset",
          );
          setDestDatabases(dbNodes);
          if (dbNodes.length === 0) {
            setValue("destinationDatabase", "");
          }
          // Only clear schema/dataset when user explicitly changes the connection
          // (not on initial form load when editing an existing flow)
          if (isUserChange) {
            setValue("destinationSchema", "");
          }
        } catch (err) {
          console.error("Failed to fetch destination databases:", err);
          setDestDatabases([]);
        } finally {
          setIsLoadingDestDbs(false);
          // Update previous connection ID ref after processing
          prevDestConnectionIdRef.current = watchDestConnectionId;
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
          // Convert typeCoercions to columnMappings
          const columnMappings: ColumnMapping[] = (
            flow.typeCoercions || []
          ).map((tc: any) => ({
            name: tc.column,
            sourceType: tc.sourceType || "UNKNOWN",
            destType: tc.targetType,
            nullable: true,
            transformer: tc.transformer,
          }));

          const formData: FormData = {
            sourceConnectionId:
              flow.databaseSource?.connectionId?.toString() || "",
            sourceDatabase: flow.databaseSource?.database || "",
            query: flow.databaseSource?.query || "",
            destinationConnectionId:
              flow.tableDestination?.connectionId?.toString() || "",
            destinationDatabase: flow.tableDestination?.database || "",
            destinationSchema: flow.tableDestination?.schema || "",
            destinationTable: flow.tableDestination?.tableName || "",
            schedule: flow.schedule?.cron || "0 * * * *",
            timezone: flow.schedule?.timezone || "UTC",
            syncMode: flow.syncMode as "full" | "incremental",
            trackingColumn: flow.incrementalConfig?.trackingColumn || "",
            trackingType: flow.incrementalConfig?.trackingType || "timestamp",
            keyColumns: flow.conflictConfig?.keyColumns?.join(", ") || "",
            conflictStrategy:
              (flow.conflictConfig?.strategy as any) || "upsert",
            batchSize: flow.batchSize || 2000,
            enabled: flow.enabled,
            createTableIfNotExists:
              flow.tableDestination?.createIfNotExists ?? true,
            paginationMode: flow.paginationConfig?.mode || "offset",
            keysetColumn: flow.paginationConfig?.keysetColumn || "",
            keysetDirection: flow.paginationConfig?.keysetDirection || "asc",
            columnMappings,
            schemaMappingConfirmed: columnMappings.length > 0,
          };

          // Set the previous connection ID ref before reset to prevent clearing schema
          prevDestConnectionIdRef.current =
            flow.tableDestination?.connectionId?.toString() || "";

          reset(formData);

          // Mark form as initialized after a short delay to allow effects to run
          // This ensures the destination databases effect doesn't clear the schema
          setTimeout(() => {
            isFormInitializedRef.current = true;
          }, 100);

          // Check if using a preset
          const isPreset = SCHEDULE_PRESETS.some(
            p => p.cron === (flow.schedule?.cron || "0 * * * *"),
          );
          setScheduleMode(isPreset ? "preset" : "custom");

          // For existing flows with schema mappings, start at step 3
          if (columnMappings.length > 0) {
            setActiveStep(2);
          }
        }
      } else if (isNewMode) {
        // For new flows, mark as initialized immediately
        isFormInitializedRef.current = true;
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

        // Parse key columns (handle both string and array from AI agent)
        const keyColumns = data.keyColumns
          ? Array.isArray(data.keyColumns)
            ? data.keyColumns.filter(Boolean)
            : data.keyColumns
                .split(",")
                .map(k => k.trim())
                .filter(Boolean)
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

        // Add pagination config if using keyset mode
        if (data.paginationMode === "keyset" && data.keysetColumn) {
          payload.paginationConfig = {
            mode: "keyset",
            keysetColumn: data.keysetColumn.trim(),
            keysetDirection: data.keysetDirection || "asc",
          };
        } else if (data.paginationMode === "offset") {
          payload.paginationConfig = {
            mode: "offset",
          };
        }

        // Add type coercions from column mappings
        if (data.columnMappings && data.columnMappings.length > 0) {
          payload.typeCoercions = data.columnMappings.map(col => ({
            column: col.name,
            sourceType: col.sourceType,
            targetType: col.destType,
            transformer: col.transformer || undefined,
          }));
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
        setError(
          error instanceof Error ? error.message : "Failed to save flow",
        );
      } finally {
        setIsSubmitting(false);
      }
    };

    const getCronDescription = (cron: string) => {
      const preset = SCHEDULE_PRESETS.find(p => p.cron === cron);
      if (preset) return preset.label;
      return `Custom: ${cron}`;
    };

    // Handle column mapping changes
    const handleColumnMappingsChange = (mappings: ColumnMapping[]) => {
      setValue("columnMappings", mappings, { shouldValidate: true });
    };

    // Populate initial column mappings from validation result
    const handlePopulateMappingsFromValidation = () => {
      if (validationResult?.columns && validationResult.columns.length > 0) {
        const mappings: ColumnMapping[] = validationResult.columns.map(col => ({
          name: col.name,
          sourceType: col.type,
          destType: suggestDestType(
            col.type,
            col.name,
            selectedDestConnection?.type,
          ),
          nullable: true,
        }));
        setValue("columnMappings", mappings, { shouldValidate: true });
      }
    };

    // Suggest destination type based on source type and column name
    const suggestDestType = (
      sourceType: string,
      columnName: string,
      destDbType?: string,
    ): string => {
      const upper = sourceType.toUpperCase();
      const lowerName = columnName.toLowerCase();
      const isBigQuery = destDbType === "bigquery";

      // Integer types
      if (upper.includes("INT") || upper === "INTEGER") {
        // Check if this might be a timestamp
        if (
          lowerName.endsWith("_at") ||
          lowerName.endsWith("_time") ||
          lowerName.includes("timestamp")
        ) {
          // Unix timestamp stored as integer - suggest STRING to preserve
          return isBigQuery ? "STRING" : "TEXT";
        }
        return isBigQuery ? "INT64" : "BIGINT";
      }

      // Float/Real types
      if (
        upper.includes("REAL") ||
        upper.includes("FLOAT") ||
        upper.includes("DOUBLE") ||
        upper.includes("NUMERIC") ||
        upper.includes("DECIMAL")
      ) {
        return isBigQuery ? "FLOAT64" : "DOUBLE PRECISION";
      }

      // Boolean
      if (upper.includes("BOOL")) {
        return isBigQuery ? "BOOL" : "BOOLEAN";
      }

      // Timestamp/DateTime
      if (upper.includes("TIMESTAMP") || upper.includes("DATETIME")) {
        return isBigQuery ? "TIMESTAMP" : "TIMESTAMPTZ";
      }

      // Date
      if (upper === "DATE") {
        return "DATE";
      }

      // JSON
      if (upper.includes("JSON")) {
        return isBigQuery ? "JSON" : "JSONB";
      }

      // Blob/Bytes
      if (upper.includes("BLOB") || upper.includes("BYTES")) {
        return isBigQuery ? "BYTES" : "BYTEA";
      }

      // Default: String/Text
      return isBigQuery ? "STRING" : "TEXT";
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
              disabled={isSubmitting || activeStep !== 2}
              onClick={handleSubmit(onSubmit)}
            >
              {isNewMode ? "Create" : "Save"}
            </Button>
          </Box>
        </Box>

        {/* Main form content with Stepper */}
        <Box sx={{ flex: 1, overflow: "auto", p: { xs: 2, sm: 3 } }}>
          <Box sx={{ maxWidth: "800px", mx: "auto" }}>
            {(error || storeError) && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error || storeError}
              </Alert>
            )}

            {/* Horizontal Stepper */}
            <Stepper activeStep={activeStep} sx={{ mb: 3 }}>
              {STEPS.map((step, index) => (
                <Step key={step.label}>
                  <StepLabel
                    optional={
                      <Typography variant="caption" color="text.secondary">
                        {step.description}
                      </Typography>
                    }
                    onClick={() => {
                      // Allow clicking on completed steps to go back
                      if (index < activeStep) {
                        setActiveStep(index);
                      }
                    }}
                    sx={{ cursor: index < activeStep ? "pointer" : "default" }}
                  >
                    {step.label}
                  </StepLabel>
                </Step>
              ))}
            </Stepper>

            <form onSubmit={handleSubmit(onSubmit)}>
              {/* Step 1: Source Configuration */}
              {activeStep === 0 && (
                <Stack spacing={3}>
                  <Box>
                    <Typography
                      variant="subtitle2"
                      sx={{
                        mb: 1,
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                      }}
                    >
                      <DatabaseIcon fontSize="small" />
                      Source Database
                    </Typography>
                    <Stack spacing={2}>
                      <Controller
                        name="sourceConnectionId"
                        control={control}
                        rules={{ required: "Source connection is required" }}
                        render={({ field }) => (
                          <ConnectionSelector
                            value={field.value}
                            onChange={field.onChange}
                            label="Source Connection"
                            error={!!errors.sourceConnectionId}
                            helperText={errors.sourceConnectionId?.message}
                            fullWidth
                          />
                        )}
                      />

                      {watchSourceConnectionId && (
                        <>
                          {isLoadingSourceDbs ? (
                            <Box
                              sx={{
                                display: "flex",
                                alignItems: "center",
                                gap: 2,
                              }}
                            >
                              <CircularProgress size={20} />
                              <Typography
                                variant="body2"
                                color="text.secondary"
                              >
                                Loading{" "}
                                {isBigQuerySource ? "datasets" : "databases"}
                                ...
                              </Typography>
                            </Box>
                          ) : sourceDatabases.length > 0 ? (
                            <Controller
                              name="sourceDatabase"
                              control={control}
                              render={({ field }) => (
                                <FormControl fullWidth>
                                  <InputLabel>
                                    {isBigQuerySource
                                      ? "Source Dataset"
                                      : "Source Database"}
                                  </InputLabel>
                                  <Select
                                    {...field}
                                    label={
                                      isBigQuerySource
                                        ? "Source Dataset"
                                        : "Source Database"
                                    }
                                  >
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
                                    {isBigQuerySource
                                      ? "Select the BigQuery dataset"
                                      : "Select the database within this connection"}
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
                          <Box>
                            <Typography
                              variant="body2"
                              sx={{
                                mb: 0.5,
                                color: errors.query
                                  ? "error.main"
                                  : "text.secondary",
                              }}
                            >
                              SQL Query *
                            </Typography>
                            <Box
                              sx={{
                                height: 200,
                                border: 1,
                                borderColor: errors.query
                                  ? "error.main"
                                  : "divider",
                                borderRadius: 1,
                                overflow: "hidden",
                              }}
                            >
                              <Editor
                                language="sql"
                                value={field.value}
                                theme={
                                  effectiveMode === "dark" ? "vs-dark" : "vs"
                                }
                                onChange={value => field.onChange(value || "")}
                                options={{
                                  minimap: { enabled: false },
                                  fontSize: 13,
                                  wordWrap: "on",
                                  lineNumbers: "on",
                                  scrollBeyondLastLine: false,
                                  automaticLayout: true,
                                  tabSize: 2,
                                  padding: { top: 8, bottom: 8 },
                                  scrollbar: {
                                    vertical: "auto",
                                    horizontal: "auto",
                                  },
                                }}
                                onMount={(editor, monaco) => {
                                  editorRef.current = editor;
                                  monacoRef.current = monaco;
                                  registerTemplateCompletions(monaco);
                                }}
                              />
                            </Box>
                            <FormHelperText error={!!errors.query}>
                              {errors.query?.message ||
                                "Use {{limit}}, {{offset}}, {{last_sync_value}}, {{keyset_value}} for dynamic values"}
                            </FormHelperText>
                          </Box>
                        )}
                      />

                      {/* Validate Query Button */}
                      <Box>
                        <Button
                          variant="outlined"
                          size="small"
                          startIcon={
                            isValidating ? (
                              <CircularProgress size={16} />
                            ) : (
                              <ValidateIcon />
                            )
                          }
                          onClick={handleValidateQuery}
                          disabled={
                            isValidating ||
                            !watchSourceConnectionId ||
                            !watchQuery?.trim()
                          }
                        >
                          {isValidating ? "Validating..." : "Validate Query"}
                        </Button>
                      </Box>

                      {/* Validation Results */}
                      {validationResult && (
                        <Box sx={{ mt: 1 }}>
                          {validationResult.success ? (
                            <Alert
                              severity="success"
                              icon={<CheckIcon />}
                              sx={{ mb: 1 }}
                            >
                              <Typography variant="body2" fontWeight="medium">
                                Query validated successfully
                              </Typography>
                              {validationResult.columns &&
                                validationResult.columns.length > 0 && (
                                  <Box sx={{ mt: 1 }}>
                                    <Typography
                                      variant="caption"
                                      color="text.secondary"
                                    >
                                      Columns ({validationResult.columns.length}
                                      ):
                                    </Typography>
                                    <Box
                                      sx={{
                                        display: "flex",
                                        flexWrap: "wrap",
                                        gap: 0.5,
                                        mt: 0.5,
                                      }}
                                    >
                                      {validationResult.columns.map(
                                        (col, idx) => (
                                          <Chip
                                            key={idx}
                                            label={`${col.name} (${col.type})`}
                                            size="small"
                                            variant="outlined"
                                            sx={{ fontSize: "0.75rem" }}
                                          />
                                        ),
                                      )}
                                    </Box>
                                  </Box>
                                )}
                            </Alert>
                          ) : (
                            <Alert severity="error" sx={{ mb: 1 }}>
                              <Typography variant="body2">
                                {validationResult.error ||
                                  "Query validation failed"}
                              </Typography>
                            </Alert>
                          )}

                          {/* Warnings */}
                          {validationResult.warnings &&
                            validationResult.warnings.length > 0 && (
                              <Alert
                                severity="warning"
                                icon={<WarningIcon />}
                                sx={{ mb: 1 }}
                              >
                                <Typography variant="body2" fontWeight="medium">
                                  Suggestions:
                                </Typography>
                                <ul
                                  style={{
                                    margin: "4px 0 0 0",
                                    paddingLeft: "20px",
                                  }}
                                >
                                  {validationResult.warnings.map(
                                    (warning, idx) => (
                                      <li key={idx}>
                                        <Typography variant="body2">
                                          {warning}
                                        </Typography>
                                      </li>
                                    ),
                                  )}
                                </ul>
                              </Alert>
                            )}

                          {/* Sample Row Preview */}
                          {validationResult.sampleRow && (
                            <Box
                              sx={{
                                mt: 1,
                                p: 1.5,
                                bgcolor: "action.hover",
                                borderRadius: 1,
                                overflow: "auto",
                              }}
                            >
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                gutterBottom
                              >
                                Sample row:
                              </Typography>
                              <Box
                                component="pre"
                                sx={{
                                  m: 0,
                                  mt: 0.5,
                                  fontSize: "0.75rem",
                                  fontFamily: "monospace",
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-all",
                                }}
                              >
                                {JSON.stringify(
                                  validationResult.sampleRow,
                                  null,
                                  2,
                                )}
                              </Box>
                            </Box>
                          )}
                        </Box>
                      )}
                    </Stack>
                  </Box>

                  {/* Step 1 Navigation */}
                  <Box
                    sx={{ display: "flex", justifyContent: "flex-end", pt: 2 }}
                  >
                    <Button
                      variant="contained"
                      endIcon={<NextIcon />}
                      onClick={() => {
                        // Auto-populate mappings from validation result
                        if (
                          validationResult?.success &&
                          validationResult.columns
                        ) {
                          handlePopulateMappingsFromValidation();
                        }
                        handleNext();
                      }}
                      disabled={!canProceedToStep2}
                    >
                      Next: Schema Mapping
                    </Button>
                  </Box>
                </Stack>
              )}

              {/* Step 2: Schema Mapping */}
              {activeStep === 1 && (
                <Stack spacing={3}>
                  <Box>
                    <Typography
                      variant="subtitle2"
                      sx={{
                        mb: 1,
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                      }}
                    >
                      <AnalyzeIcon fontSize="small" />
                      Schema Mapping
                    </Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ mb: 2 }}
                    >
                      Review and adjust the destination column types. The AI
                      agent can help analyze your data and suggest optimal
                      types. You can also manually adjust any column's
                      destination type using the dropdowns below.
                    </Typography>

                    {/* Schema Mapping Table */}
                    <SchemaMappingTable
                      columns={watchColumnMappings || []}
                      onChange={handleColumnMappingsChange}
                      destinationType={
                        selectedDestConnection?.type || "bigquery"
                      }
                    />

                    {watchColumnMappings?.length === 0 && (
                      <Alert severity="info" sx={{ mt: 2 }}>
                        <Typography variant="body2">
                          No columns detected yet. Go back to Step 1 and
                          validate your query, or ask the AI agent to analyze
                          the schema for you.
                        </Typography>
                      </Alert>
                    )}

                    {watchColumnMappings?.length > 0 && (
                      <Box sx={{ mt: 2 }}>
                        <FormControlLabel
                          control={
                            <Switch
                              checked={watchSchemaMappingConfirmed || false}
                              onChange={e =>
                                setValue(
                                  "schemaMappingConfirmed",
                                  e.target.checked,
                                )
                              }
                            />
                          }
                          label={
                            <Typography variant="body2">
                              I have reviewed and confirmed the column type
                              mappings
                            </Typography>
                          }
                        />
                      </Box>
                    )}
                  </Box>

                  {/* Step 2 Navigation */}
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      pt: 2,
                    }}
                  >
                    <Button startIcon={<BackIcon />} onClick={handleBack}>
                      Back
                    </Button>
                    <Button
                      variant="contained"
                      endIcon={<NextIcon />}
                      onClick={handleNext}
                      disabled={!canProceedToStep3}
                    >
                      Next: Destination
                    </Button>
                  </Box>
                </Stack>
              )}

              {/* Step 3: Destination and Schedule */}
              {activeStep === 2 && (
                <Stack spacing={3}>
                  {/* Destination Configuration */}
                  <Box>
                    <Typography
                      variant="subtitle2"
                      sx={{
                        mb: 1,
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                      }}
                    >
                      <DatabaseIcon fontSize="small" />
                      Destination Database
                    </Typography>
                    <Stack spacing={2}>
                      <Controller
                        name="destinationConnectionId"
                        control={control}
                        rules={{
                          required: "Destination connection is required",
                        }}
                        render={({ field }) => (
                          <ConnectionSelector
                            value={field.value}
                            onChange={field.onChange}
                            label="Destination Connection"
                            error={!!errors.destinationConnectionId}
                            helperText={errors.destinationConnectionId?.message}
                            fullWidth
                          />
                        )}
                      />

                      {/* Database selector - not shown for BigQuery (uses datasets in schema field instead) */}
                      {watchDestConnectionId && !isBigQueryDest && (
                        <>
                          {isLoadingDestDbs ? (
                            <Box
                              sx={{
                                display: "flex",
                                alignItems: "center",
                                gap: 2,
                              }}
                            >
                              <CircularProgress size={20} />
                              <Typography
                                variant="body2"
                                color="text.secondary"
                              >
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
                                  <Select
                                    {...field}
                                    label="Destination Database"
                                  >
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

                      <Stack
                        direction={{ xs: "column", md: "row" }}
                        spacing={2}
                      >
                        {showSchemaField &&
                          (isBigQueryDest ? (
                            // BigQuery: Show dataset dropdown
                            <Controller
                              name="destinationSchema"
                              control={control}
                              rules={{
                                required: "Dataset is required for BigQuery",
                              }}
                              render={({ field }) => (
                                <FormControl
                                  fullWidth
                                  sx={{ flex: 1 }}
                                  error={!!errors.destinationSchema}
                                >
                                  <InputLabel>Dataset</InputLabel>
                                  <Select {...field} label="Dataset">
                                    {isLoadingDestDbs ? (
                                      <MenuItem value="" disabled>
                                        Loading datasets...
                                      </MenuItem>
                                    ) : destDatabases.length === 0 ? (
                                      <MenuItem value="" disabled>
                                        No datasets found
                                      </MenuItem>
                                    ) : (
                                      destDatabases.map(ds => (
                                        <MenuItem key={ds.id} value={ds.id}>
                                          {ds.label || ds.id}
                                        </MenuItem>
                                      ))
                                    )}
                                  </Select>
                                  <FormHelperText>
                                    {errors.destinationSchema?.message ||
                                      "Select the BigQuery dataset"}
                                  </FormHelperText>
                                </FormControl>
                              )}
                            />
                          ) : (
                            // PostgreSQL: Show schema text field
                            <Controller
                              name="destinationSchema"
                              control={control}
                              render={({ field }) => (
                                <TextField
                                  {...field}
                                  label="Schema (optional)"
                                  placeholder="public"
                                  helperText="PostgreSQL schema name"
                                  sx={{ flex: 1 }}
                                />
                              )}
                            />
                          ))}
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
                                  <MenuItem
                                    key={preset.cron}
                                    value={preset.cron}
                                  >
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

                    <Box
                      sx={{ display: "flex", alignItems: "center", flex: 1 }}
                    >
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
                    <>
                      <Stack
                        direction={{ xs: "column", md: "row" }}
                        spacing={2}
                      >
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
                                <MenuItem value="numeric">
                                  Numeric (ID)
                                </MenuItem>
                              </Select>
                            </FormControl>
                          )}
                        />
                      </Stack>

                      {/* Sync State Display for existing flows */}
                      {!isNewMode &&
                        currentFlowId &&
                        (() => {
                          const currentFlow = flows.find(
                            f => f._id === currentFlowId,
                          );
                          const lastValue =
                            currentFlow?.incrementalConfig?.lastValue;
                          const trackingCol =
                            currentFlow?.incrementalConfig?.trackingColumn;

                          if (lastValue && trackingCol) {
                            return (
                              <Alert severity="info" sx={{ mt: 1 }}>
                                <Typography variant="body2">
                                  <strong>Last synced value:</strong>{" "}
                                  {lastValue}
                                </Typography>
                                <Typography
                                  variant="body2"
                                  color="text.secondary"
                                  sx={{ mt: 0.5 }}
                                >
                                  Next sync will fetch rows where{" "}
                                  <code
                                    style={{
                                      backgroundColor: "rgba(0,0,0,0.08)",
                                      padding: "2px 4px",
                                      borderRadius: 4,
                                    }}
                                  >
                                    {trackingCol} &gt; '{lastValue}'
                                  </code>
                                </Typography>
                              </Alert>
                            );
                          }

                          if (
                            !lastValue &&
                            currentFlow?.runCount &&
                            currentFlow.runCount > 0
                          ) {
                            return (
                              <Alert severity="warning" sx={{ mt: 1 }}>
                                <Typography variant="body2">
                                  Flow has run but no tracking value recorded.
                                  First run may have synced all rows.
                                </Typography>
                              </Alert>
                            );
                          }

                          return (
                            <Alert severity="info" sx={{ mt: 1 }}>
                              <Typography variant="body2">
                                First sync will fetch all rows. Subsequent syncs
                                will only fetch new/updated records.
                              </Typography>
                            </Alert>
                          );
                        })()}
                    </>
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
                            <MenuItem value="upsert">
                              Upsert (update or insert)
                            </MenuItem>
                            <MenuItem value="ignore">Skip duplicates</MenuItem>
                            <MenuItem value="replace">
                              Replace entire row
                            </MenuItem>
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

                  <Divider />

                  {/* Pagination Configuration */}
                  <Box>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>
                      Pagination
                    </Typography>
                    <Stack spacing={2}>
                      <Controller
                        name="paginationMode"
                        control={control}
                        render={({ field }) => (
                          <FormControl fullWidth>
                            <InputLabel>Pagination Mode</InputLabel>
                            <Select {...field} label="Pagination Mode">
                              <MenuItem value="offset">
                                Offset (LIMIT/OFFSET)
                              </MenuItem>
                              <MenuItem value="keyset">
                                Keyset (WHERE col &gt; last_value)
                              </MenuItem>
                            </Select>
                            <FormHelperText>
                              {field.value === "offset"
                                ? "Standard pagination. Works for any query but slower for large tables."
                                : "Faster for large tables (100k+ rows). Requires a unique, indexed column."}
                            </FormHelperText>
                          </FormControl>
                        )}
                      />

                      {watchPaginationMode === "keyset" && (
                        <Stack
                          direction={{ xs: "column", md: "row" }}
                          spacing={2}
                        >
                          <Controller
                            name="keysetColumn"
                            control={control}
                            rules={{
                              required:
                                watchPaginationMode === "keyset"
                                  ? "Keyset column is required for keyset pagination"
                                  : false,
                            }}
                            render={({ field }) => (
                              <TextField
                                {...field}
                                label="Keyset Column"
                                placeholder="id"
                                error={!!errors.keysetColumn}
                                helperText={
                                  errors.keysetColumn?.message ||
                                  "Column to use for keyset pagination (e.g., id, created_at)"
                                }
                                sx={{ flex: 1 }}
                              />
                            )}
                          />
                          <Controller
                            name="keysetDirection"
                            control={control}
                            render={({ field }) => (
                              <FormControl sx={{ flex: 1 }}>
                                <InputLabel>Sort Direction</InputLabel>
                                <Select {...field} label="Sort Direction">
                                  <MenuItem value="asc">
                                    Ascending (ASC)
                                  </MenuItem>
                                  <MenuItem value="desc">
                                    Descending (DESC)
                                  </MenuItem>
                                </Select>
                                <FormHelperText>
                                  Must match ORDER BY in your query
                                </FormHelperText>
                              </FormControl>
                            )}
                          />
                        </Stack>
                      )}
                    </Stack>
                  </Box>

                  {/* Schedule Preview */}
                  <Alert severity="info" icon={<ScheduleIcon />}>
                    <Typography variant="body2">
                      <strong>Schedule:</strong>{" "}
                      {getCronDescription(watchSchedule)}
                      {watchTimezone && ` in ${watchTimezone}`}
                    </Typography>
                  </Alert>

                  {/* Step 3 Navigation */}
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      pt: 2,
                    }}
                  >
                    <Button startIcon={<BackIcon />} onClick={handleBack}>
                      Back
                    </Button>
                    <Button
                      type="submit"
                      variant="contained"
                      startIcon={isNewMode ? <AddIcon /> : <SaveIcon />}
                      disabled={isSubmitting}
                      onClick={handleSubmit(onSubmit)}
                    >
                      {isSubmitting ? (
                        <>
                          <CircularProgress size={16} sx={{ mr: 1 }} />
                          {isNewMode ? "Creating..." : "Saving..."}
                        </>
                      ) : isNewMode ? (
                        "Create Flow"
                      ) : (
                        "Save Flow"
                      )}
                    </Button>
                  </Box>
                </Stack>
              )}
            </form>
          </Box>
        </Box>
      </Box>
    );
  },
);
