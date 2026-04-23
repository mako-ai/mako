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
  Accordion,
  AccordionSummary,
  AccordionDetails,
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
  ExpandMore as ExpandMoreIcon,
} from "@mui/icons-material";
import Editor, { Monaco, OnMount } from "@monaco-editor/react";
import { useWorkspace } from "../contexts/workspace-context";
import { useFlowStore } from "../store/flowStore";
import { useSchemaStore, TreeNode } from "../store/schemaStore";
import { trackEvent } from "../lib/analytics";
import { ConnectionSelector } from "./ConnectionSelector";
import { useSqlAutocomplete } from "../hooks/useSqlAutocomplete";
import { SchemaMappingTable, TypeCoercion } from "./SchemaMappingTable";

interface DbFlowFormProps {
  flowId?: string;
  isNew?: boolean;
  onSave?: () => void;
  onSaved?: (flowId: string) => void;
  onCancel?: () => void;
}

/**
 * Ref interface for DbFlowForm - methods exposed to parent components and AI agent
 * Uses nested field paths matching the API structure (e.g., "schedule.cron", "databaseSource.query")
 */
export interface DbFlowFormRef {
  /** Get all current form values */
  getFormState(): Record<string, unknown>;
  /** Set a single form field using nested path (e.g., "schedule.cron", "databaseSource.query") */
  setField(path: string, value: unknown): void;
  /** Set multiple form fields at once using nested paths */
  setMultipleFields(fields: Record<string, unknown>): void;
  /** Trigger query validation */
  validateQuery(): Promise<void>;
  /** Set type coercions (column mappings) for schema transformation */
  setTypeCoercions(coercions: TypeCoercion[]): void;
  /** Get current type coercions */
  getTypeCoercions(): TypeCoercion[];
  /** Navigate to a specific step */
  goToStep(step: number): void;
  /** Get current step */
  getCurrentStep(): number;
}

/**
 * Form data structure - MATCHES the API/database structure exactly
 * Uses nested objects, no more flat fields!
 */
interface FormData {
  databaseSource: {
    connectionId: string;
    database?: string;
    query: string;
  };
  tableDestination: {
    connectionId: string;
    database?: string;
    schema?: string;
    tableName: string;
    createIfNotExists: boolean;
  };
  schedule: {
    enabled: boolean;
    cron?: string;
    timezone: string;
  };
  syncMode: "full" | "incremental";
  batchSize: number;
  incrementalConfig?: {
    trackingColumn: string;
    trackingType: "timestamp" | "numeric";
  };
  conflictConfig?: {
    keyColumns: string[];
    strategy: "update" | "ignore" | "replace" | "upsert";
  };
  paginationConfig?: {
    mode: "offset" | "keyset";
    keysetColumn?: string;
    keysetDirection?: "asc" | "desc";
  };
  // Type coercions - same shape as database/API, no conversion needed
  typeCoercions: TypeCoercion[];
  schemaMappingConfirmed: boolean;
}

// Wizard steps
const STEPS = [
  { label: "Source", description: "Configure source database and query" },
  {
    label: "Destination",
    description: "Configure destination database and table",
  },
  { label: "Schema Mapping", description: "Review and confirm column types" },
  {
    label: "Sync Mode",
    description: "Configure sync behavior and conflict handling",
  },
  {
    label: "Schedule",
    description: "Set up automatic sync schedule (optional)",
  },
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

/**
 * Default form values
 */
const DEFAULT_FORM_VALUES: FormData = {
  databaseSource: {
    connectionId: "",
    database: "",
    query: "",
  },
  tableDestination: {
    connectionId: "",
    database: "",
    schema: "",
    tableName: "",
    createIfNotExists: true,
  },
  schedule: {
    enabled: false,
    cron: "0 * * * *",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  },
  syncMode: "full",
  batchSize: 2000,
  incrementalConfig: undefined,
  conflictConfig: undefined,
  paginationConfig: {
    mode: "offset",
    keysetColumn: "",
    keysetDirection: "asc",
  },
  typeCoercions: [],
  schemaMappingConfirmed: false,
};

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
      fetchFlowDetails,
    } = useFlowStore();

    // Get workspace-specific data
    const flows = useMemo(
      () => (currentWorkspace ? flowsMap[currentWorkspace.id] || [] : []),
      [currentWorkspace, flowsMap],
    );

    // Loading state for fetching flow details
    const [isLoadingFlow, setIsLoadingFlow] = useState(false);
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
    const checkTableExists = useSchemaStore(state => state.checkTableExists);

    const [scheduleMode, setScheduleMode] = useState<"preset" | "custom">(
      "preset",
    );
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [currentFlowId, setCurrentFlowId] = useState<string | undefined>(
      flowId,
    );
    const [isNewMode, setIsNewMode] = useState(isNew);

    // Wizard step state - allow multiple steps open
    const [openSteps, setOpenSteps] = useState<Set<number>>(new Set([0]));

    // Source and destination database lists
    const [sourceDatabases, setSourceDatabases] = useState<TreeNode[]>([]);
    const [destDatabases, setDestDatabases] = useState<TreeNode[]>([]);
    const [isLoadingSourceDbs, setIsLoadingSourceDbs] = useState(false);
    const [isLoadingDestDbs, setIsLoadingDestDbs] = useState(false);

    // Track previous connection IDs to detect user-initiated changes vs form reset
    const prevSourceConnectionIdRef = useRef<string | null>(null);
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

    // Destination table existence state (value used for future UI enhancement)
    const [_destTableExists, setDestTableExists] = useState<{
      exists: boolean;
      columns: Array<{ name: string; type: string; nullable?: boolean }>;
      isChecking: boolean;
    }>({ exists: false, columns: [], isChecking: false });

    // Monaco editor refs
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
      defaultValues: DEFAULT_FORM_VALUES,
    });

    // Expose methods to parent via ref (for AI agent integration)
    // Now uses nested paths like "schedule.cron", "databaseSource.query"
    useImperativeHandle(ref, () => ({
      getFormState: () => getValues() as unknown as Record<string, unknown>,
      setField: (path: string, value: unknown) => {
        // React Hook Form natively supports nested paths with dot notation
        setValue(path as any, value as any, {
          shouldValidate: true,
        });
      },
      setMultipleFields: (fields: Record<string, unknown>) => {
        Object.entries(fields).forEach(([path, value]) => {
          setValue(path as any, value as any, {
            shouldValidate: false,
          });
        });
        trigger();
      },
      validateQuery: async () => {
        await handleValidateQuery();
      },
      setTypeCoercions: (coercions: TypeCoercion[]) => {
        setValue("typeCoercions", coercions, { shouldValidate: true });
        if (coercions.length > 0 && !openSteps.has(2)) {
          setOpenSteps(prev => new Set([...prev, 2]));
        }
      },
      getTypeCoercions: () => getValues("typeCoercions") || [],
      goToStep: (step: number) => {
        if (step >= 0 && step < STEPS.length) {
          setOpenSteps(prev => new Set([...prev, step]));
        }
      },
      getCurrentStep: () => Math.max(...Array.from(openSteps), 0),
    }));

    // Watch nested fields
    const watchScheduleEnabled = watch("schedule.enabled");
    const watchScheduleCron = watch("schedule.cron");
    const watchScheduleTimezone = watch("schedule.timezone");
    const watchSourceConnectionId = watch("databaseSource.connectionId");
    const watchSourceDatabase = watch("databaseSource.database");
    const watchQuery = watch("databaseSource.query");
    const watchDestConnectionId = watch("tableDestination.connectionId");
    const watchDestDatabase = watch("tableDestination.database");
    const watchDestSchema = watch("tableDestination.schema");
    const watchDestTable = watch("tableDestination.tableName");
    const watchSyncMode = watch("syncMode");
    const watchPaginationMode = watch("paginationConfig.mode");
    const watchTypeCoercions = watch("typeCoercions");
    const watchSchemaMappingConfirmed = watch("schemaMappingConfirmed");

    // Step navigation helpers
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

    const openNextStep = (currentStep: number) => {
      setOpenSteps(prev => {
        const next = new Set(prev);
        const nextStep = currentStep + 1;
        if (nextStep < STEPS.length) {
          next.add(nextStep);
        }
        return next;
      });
    };

    // Simplified save check
    const canSave =
      watchSourceConnectionId &&
      watchQuery?.trim() &&
      watchDestConnectionId &&
      watchDestTable?.trim();

    // Get the selected source connection to check its type
    const selectedSourceConnection = useMemo(
      () => databases.find(db => db.id === watchSourceConnectionId),
      [databases, watchSourceConnectionId],
    );

    const isBigQuerySource = selectedSourceConnection?.type === "bigquery";

    // Get the selected destination connection to check its type
    const selectedDestConnection = useMemo(
      () => databases.find(db => db.id === watchDestConnectionId),
      [databases, watchDestConnectionId],
    );

    const isBigQueryDest = selectedDestConnection?.type === "bigquery";
    const isPostgresDest = selectedDestConnection?.type === "postgresql";
    const showSchemaField = isBigQueryDest || isPostgresDest;

    // Callbacks for SQL autocomplete
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
          setValue("databaseSource.database", "");
          return;
        }

        const isUserChange =
          isFormInitializedRef.current &&
          prevSourceConnectionIdRef.current !== null &&
          prevSourceConnectionIdRef.current !== watchSourceConnectionId;

        setIsLoadingSourceDbs(true);
        try {
          const nodes = await ensureTreeRoot(
            currentWorkspace.id,
            watchSourceConnectionId,
          );
          const dbNodes = nodes.filter(
            node => node.kind === "database" || node.kind === "dataset",
          );
          setSourceDatabases(dbNodes);
          if (dbNodes.length === 0 || isUserChange) {
            if (dbNodes.length === 0) {
              setValue("databaseSource.database", "");
            }
          }
        } catch (err) {
          console.error("Failed to fetch source databases:", err);
          setSourceDatabases([]);
        } finally {
          setIsLoadingSourceDbs(false);
          prevSourceConnectionIdRef.current = watchSourceConnectionId;
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
          setValue("tableDestination.database", "");
          setValue("tableDestination.schema", "");
          return;
        }

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
          const dbNodes = nodes.filter(
            node => node.kind === "database" || node.kind === "dataset",
          );
          setDestDatabases(dbNodes);
          if (dbNodes.length === 0) {
            setValue("tableDestination.database", "");
          }
          if (isUserChange) {
            setValue("tableDestination.schema", "");
          }
        } catch (err) {
          console.error("Failed to fetch destination databases:", err);
          setDestDatabases([]);
        } finally {
          setIsLoadingDestDbs(false);
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

    // Ref for debounce timeout
    const tableExistsDebounceRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
      return () => {
        if (tableExistsDebounceRef.current) {
          clearTimeout(tableExistsDebounceRef.current);
        }
      };
    }, []);

    // Check destination table existence when destination parameters change
    useEffect(() => {
      if (tableExistsDebounceRef.current) {
        clearTimeout(tableExistsDebounceRef.current);
      }

      if (!watchDestConnectionId || !watchDestTable?.trim()) {
        setDestTableExists({ exists: false, columns: [], isChecking: false });
        return;
      }

      tableExistsDebounceRef.current = setTimeout(async () => {
        if (!currentWorkspace?.id) {
          setDestTableExists({ exists: false, columns: [], isChecking: false });
          return;
        }

        setDestTableExists(prev => ({ ...prev, isChecking: true }));
        try {
          const result = await checkTableExists(
            currentWorkspace.id,
            watchDestConnectionId,
            watchDestTable.trim(),
            {
              schema: watchDestSchema || undefined,
              database: watchDestDatabase || undefined,
            },
          );
          setDestTableExists({
            exists: result.exists,
            columns: result.columns,
            isChecking: false,
          });
        } catch (err) {
          console.error("Failed to check table existence:", err);
          setDestTableExists({ exists: false, columns: [], isChecking: false });
        }
      }, 500);
    }, [
      watchDestConnectionId,
      watchDestTable,
      watchDestSchema,
      watchDestDatabase,
      currentWorkspace?.id,
      checkTableExists,
    ]);

    // Load flow data if editing - uses nested structure directly
    useEffect(() => {
      if (isNewMode) {
        isFormInitializedRef.current = true;
        return;
      }

      if (!currentFlowId || !currentWorkspace?.id) {
        return;
      }

      const loadFlowData = async () => {
        setIsLoadingFlow(true);
        try {
          const flow = await fetchFlowDetails(
            currentWorkspace.id,
            currentFlowId,
          );

          if (!flow || flow.sourceType !== "database") {
            return;
          }

          // typeCoercions from API go straight into the form - same shape!
          const typeCoercions: TypeCoercion[] = (flow.typeCoercions || []).map(
            (tc: any) => ({
              column: tc.column,
              sourceType: tc.sourceType,
              targetType: tc.targetType,
              nullable: tc.nullable ?? true,
              transformer: tc.transformer,
              format: tc.format,
              nullValue: tc.nullValue,
            }),
          );

          // Form data matches API structure directly (nested)
          const formData: FormData = {
            databaseSource: {
              connectionId: flow.databaseSource?.connectionId?.toString() || "",
              database: flow.databaseSource?.database || "",
              query: flow.databaseSource?.query || "",
            },
            tableDestination: {
              connectionId:
                flow.tableDestination?.connectionId?.toString() || "",
              database: flow.tableDestination?.database || "",
              schema: flow.tableDestination?.schema || "",
              tableName: flow.tableDestination?.tableName || "",
              createIfNotExists:
                flow.tableDestination?.createIfNotExists ?? true,
            },
            schedule: {
              enabled: flow.schedule?.enabled ?? !!flow.schedule?.cron,
              cron: flow.schedule?.cron || "0 * * * *",
              timezone: flow.schedule?.timezone || "UTC",
            },
            syncMode: flow.syncMode as "full" | "incremental",
            batchSize: flow.batchSize || 2000,
            incrementalConfig: flow.incrementalConfig
              ? {
                  trackingColumn: flow.incrementalConfig.trackingColumn || "",
                  trackingType:
                    flow.incrementalConfig.trackingType || "timestamp",
                }
              : undefined,
            conflictConfig: flow.conflictConfig
              ? {
                  keyColumns: flow.conflictConfig.keyColumns || [],
                  // Normalize legacy "upsert" strategy to "update"
                  strategy:
                    flow.conflictConfig.strategy === "upsert"
                      ? "update"
                      : flow.conflictConfig.strategy || "update",
                }
              : undefined,
            paginationConfig: {
              mode: flow.paginationConfig?.mode || "offset",
              keysetColumn: flow.paginationConfig?.keysetColumn || "",
              keysetDirection: flow.paginationConfig?.keysetDirection || "asc",
            },
            typeCoercions,
            schemaMappingConfirmed: typeCoercions.length > 0,
          };

          prevSourceConnectionIdRef.current =
            flow.databaseSource?.connectionId?.toString() || "";
          prevDestConnectionIdRef.current =
            flow.tableDestination?.connectionId?.toString() || "";

          reset(formData);

          setTimeout(() => {
            isFormInitializedRef.current = true;
          }, 100);

          const isPreset = SCHEDULE_PRESETS.some(
            p => p.cron === (flow.schedule?.cron || "0 * * * *"),
          );
          setScheduleMode(isPreset ? "preset" : "custom");

          if (typeCoercions.length > 0) {
            setOpenSteps(prev => new Set([...prev, 2]));
          }
        } catch (err) {
          console.error("Failed to load flow details:", err);
          setError("Failed to load flow data");
        } finally {
          setIsLoadingFlow(false);
        }
      };

      loadFlowData();
    }, [
      isNewMode,
      currentFlowId,
      currentWorkspace?.id,
      fetchFlowDetails,
      reset,
    ]);

    // Clear store error when component unmounts
    useEffect(() => {
      return () => {
        if (currentWorkspace?.id) {
          clearError(currentWorkspace.id);
        }
      };
    }, [clearError, currentWorkspace?.id]);

    // Form submission - data is already in the right nested structure!
    const onSubmit = async (data: FormData) => {
      if (!currentWorkspace?.id) {
        setError("No workspace selected");
        return;
      }

      if (!data.databaseSource.query.trim()) {
        setError("SQL query is required");
        return;
      }

      if (!data.tableDestination.tableName.trim()) {
        setError("Destination table name is required");
        return;
      }

      if (
        data.syncMode === "incremental" &&
        !data.incrementalConfig?.trackingColumn?.trim()
      ) {
        setError("Tracking column is required for incremental sync");
        return;
      }

      setIsSubmitting(true);
      setError(null);

      try {
        const selectedSource = databases.find(
          db => db.id === data.databaseSource.connectionId,
        );
        const selectedDest = databases.find(
          db => db.id === data.tableDestination.connectionId,
        );

        const sourceName = data.databaseSource.database
          ? `${selectedSource?.name}/${data.databaseSource.database}`
          : selectedSource?.name || "Source";
        const destName = data.tableDestination.database
          ? `${selectedDest?.name}/${data.tableDestination.database}`
          : selectedDest?.name || "Destination";
        const generatedName = `${sourceName} → ${destName}:${data.tableDestination.tableName}`;

        // Build payload - structure matches API directly!
        const payload: any = {
          name: generatedName,
          type: "scheduled",
          sourceType: "database",
          databaseSource: {
            connectionId: data.databaseSource.connectionId,
            database: data.databaseSource.database || undefined,
            query: data.databaseSource.query.trim(),
          },
          tableDestination: {
            connectionId: data.tableDestination.connectionId,
            database: data.tableDestination.database || undefined,
            schema: data.tableDestination.schema || undefined,
            tableName: data.tableDestination.tableName.trim(),
            createIfNotExists: data.tableDestination.createIfNotExists,
          },
          schedule: {
            enabled: data.schedule.enabled,
            cron: data.schedule.enabled ? data.schedule.cron : undefined,
            timezone: data.schedule.enabled
              ? data.schedule.timezone
              : undefined,
          },
          syncMode: data.syncMode,
          batchSize: data.batchSize,
        };

        // Add incremental config if applicable
        if (
          data.syncMode === "incremental" &&
          data.incrementalConfig?.trackingColumn
        ) {
          payload.incrementalConfig = {
            trackingColumn: data.incrementalConfig.trackingColumn.trim(),
            trackingType: data.incrementalConfig.trackingType || "timestamp",
          };
        }

        // Add conflict config if key columns specified
        if (data.conflictConfig && data.conflictConfig.keyColumns.length > 0) {
          payload.conflictConfig = {
            keyColumns: data.conflictConfig.keyColumns,
            strategy: data.conflictConfig.strategy,
          };
        }

        // Add pagination config
        if (data.paginationConfig) {
          if (
            data.paginationConfig.mode === "keyset" &&
            data.paginationConfig.keysetColumn
          ) {
            payload.paginationConfig = {
              mode: "keyset",
              keysetColumn: data.paginationConfig.keysetColumn.trim(),
              keysetDirection: data.paginationConfig.keysetDirection || "asc",
            };
          } else {
            payload.paginationConfig = {
              mode: "offset",
            };
          }
        }

        // typeCoercions go straight to API - same shape!
        if (data.typeCoercions && data.typeCoercions.length > 0) {
          payload.typeCoercions = data.typeCoercions;
        }

        let newFlow;
        if (isNewMode) {
          newFlow = await createFlow(currentWorkspace.id, payload);

          trackEvent("flow_created", {
            flow_type: "db-scheduled",
            source_type: selectedSource?.type,
            dest_type: selectedDest?.type,
          });

          await useFlowStore.getState().fetchFlows(currentWorkspace.id);

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

    const getCronDescription = (cron: string | undefined) => {
      if (!cron) return "No schedule selected";
      const preset = SCHEDULE_PRESETS.find(p => p.cron === cron);
      if (preset) return preset.label;
      return `Custom: ${cron}`;
    };

    const handleScheduleModeChange = useCallback(
      (_: unknown, value: "preset" | "custom" | null) => {
        if (!value) return;
        setScheduleMode(value);
        if (value === "preset") {
          const currentCron = getValues("schedule.cron");
          const isPreset = SCHEDULE_PRESETS.some(p => p.cron === currentCron);
          if (!isPreset) {
            setValue("schedule.cron", SCHEDULE_PRESETS[0].cron, {
              shouldDirty: true,
            });
          }
        }
      },
      [getValues, setValue],
    );

    // Handle type coercion changes
    const handleTypeCoercionsChange = (coercions: TypeCoercion[]) => {
      setValue("typeCoercions", coercions, { shouldValidate: true });
    };

    // Smart merge: only add new columns from validation
    const handleMergeColumnsFromValidation = () => {
      if (validationResult?.columns && validationResult.columns.length > 0) {
        const existingCoercions = getValues("typeCoercions") || [];
        const existingColumns = new Set(existingCoercions.map(c => c.column));

        const newCoercions: TypeCoercion[] = validationResult.columns
          .filter(col => !existingColumns.has(col.name))
          .map(col => ({
            column: col.name,
            sourceType: "",
            targetType: "",
            nullable: true,
          }));

        if (newCoercions.length > 0) {
          setValue("typeCoercions", [...existingCoercions, ...newCoercions], {
            shouldValidate: true,
          });
        }
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
              disabled={isSubmitting || !canSave}
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

            {isLoadingFlow && (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  py: 8,
                }}
              >
                <CircularProgress size={32} sx={{ mr: 2 }} />
                <Typography color="text.secondary">
                  Loading flow configuration...
                </Typography>
              </Box>
            )}

            {!isLoadingFlow && (
              <>
                <form onSubmit={handleSubmit(onSubmit)}>
                  {/* Step 1: Source Configuration */}
                  <Accordion
                    expanded={openSteps.has(0)}
                    onChange={() => toggleStep(0)}
                    sx={{ mb: 1 }}
                  >
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
                        }}
                      >
                        1
                      </Typography>
                      <Box>
                        <Typography variant="subtitle2">
                          {STEPS[0].label}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {STEPS[0].description}
                        </Typography>
                      </Box>
                    </AccordionSummary>
                    <AccordionDetails>
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
                              name="databaseSource.connectionId"
                              control={control}
                              rules={{
                                required: "Source connection is required",
                              }}
                              render={({ field }) => (
                                <ConnectionSelector
                                  value={field.value}
                                  onChange={field.onChange}
                                  label="Source Connection"
                                  error={!!errors.databaseSource?.connectionId}
                                  helperText={
                                    errors.databaseSource?.connectionId?.message
                                  }
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
                                      {isBigQuerySource
                                        ? "datasets"
                                        : "databases"}
                                      ...
                                    </Typography>
                                  </Box>
                                ) : sourceDatabases.length > 0 ? (
                                  <Controller
                                    name="databaseSource.database"
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
                              name="databaseSource.query"
                              control={control}
                              rules={{ required: "SQL query is required" }}
                              render={({ field }) => (
                                <Box>
                                  <Typography
                                    variant="body2"
                                    sx={{
                                      mb: 0.5,
                                      color: errors.databaseSource?.query
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
                                      borderColor: errors.databaseSource?.query
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
                                        effectiveMode === "dark"
                                          ? "vs-dark"
                                          : "vs"
                                      }
                                      onChange={value =>
                                        field.onChange(value || "")
                                      }
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
                                  <FormHelperText
                                    error={!!errors.databaseSource?.query}
                                  >
                                    {errors.databaseSource?.query?.message ||
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
                                {isValidating
                                  ? "Validating..."
                                  : "Validate Query"}
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
                                    <Typography
                                      variant="body2"
                                      fontWeight="medium"
                                    >
                                      Query validated successfully
                                    </Typography>
                                    {validationResult.columns &&
                                      validationResult.columns.length > 0 && (
                                        <Box sx={{ mt: 1 }}>
                                          <Typography
                                            variant="caption"
                                            color="text.secondary"
                                          >
                                            Columns (
                                            {validationResult.columns.length}
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

                                {validationResult.warnings &&
                                  validationResult.warnings.length > 0 && (
                                    <Alert
                                      severity="warning"
                                      icon={<WarningIcon />}
                                      sx={{ mb: 1 }}
                                    >
                                      <Typography
                                        variant="body2"
                                        fontWeight="medium"
                                      >
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

                        <Box
                          sx={{
                            display: "flex",
                            justifyContent: "flex-end",
                            pt: 2,
                          }}
                        >
                          <Button
                            variant="contained"
                            endIcon={<NextIcon />}
                            onClick={() => {
                              if (
                                validationResult?.success &&
                                validationResult.columns
                              ) {
                                handleMergeColumnsFromValidation();
                              }
                              openNextStep(0);
                            }}
                          >
                            Continue to Destination
                          </Button>
                        </Box>
                      </Stack>
                    </AccordionDetails>
                  </Accordion>

                  {/* Step 2: Destination Configuration */}
                  <Accordion
                    expanded={openSteps.has(1)}
                    onChange={() => toggleStep(1)}
                    sx={{ mb: 1 }}
                  >
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
                        }}
                      >
                        2
                      </Typography>
                      <Box>
                        <Typography variant="subtitle2">
                          {STEPS[1].label}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {STEPS[1].description}
                        </Typography>
                      </Box>
                    </AccordionSummary>
                    <AccordionDetails>
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
                            Destination Database
                          </Typography>
                          <Stack spacing={2}>
                            <Controller
                              name="tableDestination.connectionId"
                              control={control}
                              rules={{
                                required: "Destination connection is required",
                              }}
                              render={({ field }) => (
                                <ConnectionSelector
                                  value={field.value}
                                  onChange={field.onChange}
                                  label="Destination Connection"
                                  error={
                                    !!errors.tableDestination?.connectionId
                                  }
                                  helperText={
                                    errors.tableDestination?.connectionId
                                      ?.message
                                  }
                                  fullWidth
                                />
                              )}
                            />

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
                                    name="tableDestination.database"
                                    control={control}
                                    render={({ field }) => (
                                      <FormControl fullWidth>
                                        <InputLabel>
                                          Destination Database
                                        </InputLabel>
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
                                  <Controller
                                    name="tableDestination.schema"
                                    control={control}
                                    rules={{
                                      required:
                                        "Dataset is required for BigQuery",
                                    }}
                                    render={({ field }) => (
                                      <FormControl
                                        fullWidth
                                        sx={{ flex: 1 }}
                                        error={
                                          !!errors.tableDestination?.schema
                                        }
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
                                              <MenuItem
                                                key={ds.id}
                                                value={ds.id}
                                              >
                                                {ds.label || ds.id}
                                              </MenuItem>
                                            ))
                                          )}
                                        </Select>
                                        <FormHelperText>
                                          {errors.tableDestination?.schema
                                            ?.message ||
                                            "Select the BigQuery dataset"}
                                        </FormHelperText>
                                      </FormControl>
                                    )}
                                  />
                                ) : (
                                  <Controller
                                    name="tableDestination.schema"
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
                                name="tableDestination.tableName"
                                control={control}
                                rules={{ required: "Table name is required" }}
                                render={({ field }) => (
                                  <TextField
                                    {...field}
                                    label="Table Name"
                                    placeholder="synced_users"
                                    error={!!errors.tableDestination?.tableName}
                                    helperText={
                                      errors.tableDestination?.tableName
                                        ?.message
                                    }
                                    sx={{ flex: 1 }}
                                  />
                                )}
                              />
                            </Stack>

                            <Controller
                              name="tableDestination.createIfNotExists"
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

                        <Box
                          sx={{
                            display: "flex",
                            justifyContent: "flex-end",
                            pt: 2,
                          }}
                        >
                          <Button
                            variant="contained"
                            endIcon={<NextIcon />}
                            onClick={() => openNextStep(1)}
                          >
                            Continue to Schema Mapping
                          </Button>
                        </Box>
                      </Stack>
                    </AccordionDetails>
                  </Accordion>

                  {/* Step 3: Schema Mapping */}
                  <Accordion
                    expanded={openSteps.has(2)}
                    onChange={() => toggleStep(2)}
                    sx={{ mb: 1 }}
                  >
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
                        }}
                      >
                        3
                      </Typography>
                      <Box>
                        <Typography variant="subtitle2">
                          {STEPS[2].label}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {STEPS[2].description}
                        </Typography>
                      </Box>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Stack spacing={3}>
                        <Box>
                          <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ mb: 2 }}
                          >
                            Review and adjust the destination column types. The
                            AI agent can help inspect your source table and
                            suggest optimal types. You can also manually adjust
                            any column&apos;s destination type using the
                            dropdowns below.
                          </Typography>

                          <SchemaMappingTable
                            columns={watchTypeCoercions || []}
                            onChange={handleTypeCoercionsChange}
                            destinationType={
                              selectedDestConnection?.type || "bigquery"
                            }
                          />

                          {watchTypeCoercions?.length === 0 && (
                            <Alert severity="info" sx={{ mt: 2 }}>
                              <Typography variant="body2">
                                No columns detected yet. Go back to Step 1 and
                                validate your query, or ask the AI agent to help
                                configure the schema mapping.
                              </Typography>
                            </Alert>
                          )}

                          {watchTypeCoercions?.length > 0 && (
                            <Box sx={{ mt: 2 }}>
                              <FormControlLabel
                                control={
                                  <Switch
                                    checked={
                                      watchSchemaMappingConfirmed || false
                                    }
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
                                    I have reviewed and confirmed the column
                                    type mappings
                                  </Typography>
                                }
                              />
                            </Box>
                          )}
                        </Box>

                        <Box
                          sx={{
                            display: "flex",
                            justifyContent: "flex-end",
                            pt: 2,
                          }}
                        >
                          <Button
                            variant="contained"
                            endIcon={<NextIcon />}
                            onClick={() => openNextStep(2)}
                          >
                            Continue to Sync Mode
                          </Button>
                        </Box>
                      </Stack>
                    </AccordionDetails>
                  </Accordion>

                  {/* Step 4: Sync Mode */}
                  <Accordion
                    expanded={openSteps.has(3)}
                    onChange={() => toggleStep(3)}
                    sx={{ mb: 1 }}
                  >
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
                        }}
                      >
                        4
                      </Typography>
                      <Box>
                        <Typography variant="subtitle2">
                          {STEPS[3].label}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {STEPS[3].description}
                        </Typography>
                      </Box>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Stack spacing={3}>
                        {/* Sync Mode Selection */}
                        <Stack
                          direction={{ xs: "column", md: "row" }}
                          spacing={2}
                        >
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
                        </Stack>

                        {/* Incremental Config */}
                        {watchSyncMode === "incremental" && (
                          <>
                            <Stack
                              direction={{ xs: "column", md: "row" }}
                              spacing={2}
                            >
                              <Controller
                                name="incrementalConfig.trackingColumn"
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
                                    value={field.value || ""}
                                    label="Tracking Column"
                                    placeholder="updated_at"
                                    error={
                                      !!errors.incrementalConfig?.trackingColumn
                                    }
                                    helperText={
                                      errors.incrementalConfig?.trackingColumn
                                        ?.message ||
                                      "Column to track for incremental updates"
                                    }
                                    sx={{ flex: 1 }}
                                  />
                                )}
                              />
                              <Controller
                                name="incrementalConfig.trackingType"
                                control={control}
                                render={({ field }) => (
                                  <FormControl sx={{ flex: 1 }}>
                                    <InputLabel>Tracking Type</InputLabel>
                                    <Select
                                      {...field}
                                      value={field.value || "timestamp"}
                                      label="Tracking Type"
                                    >
                                      <MenuItem value="timestamp">
                                        Timestamp
                                      </MenuItem>
                                      <MenuItem value="numeric">
                                        Numeric (ID)
                                      </MenuItem>
                                    </Select>
                                  </FormControl>
                                )}
                              />
                            </Stack>

                            {!isNewMode &&
                              currentFlowId &&
                              (() => {
                                const currentFlow = flows.find(
                                  f => f._id === currentFlowId,
                                );
                                const lastValue =
                                  currentFlow?.incrementalConfig?.lastValue;
                                const trackingCol =
                                  currentFlow?.incrementalConfig
                                    ?.trackingColumn;

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
                                          {trackingCol} &gt; &apos;{lastValue}
                                          &apos;
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
                                        Flow has run but no tracking value
                                        recorded. First run may have synced all
                                        rows.
                                      </Typography>
                                    </Alert>
                                  );
                                }

                                return (
                                  <Alert severity="info" sx={{ mt: 1 }}>
                                    <Typography variant="body2">
                                      First sync will fetch all rows. Subsequent
                                      syncs will only fetch new/updated records.
                                    </Typography>
                                  </Alert>
                                );
                              })()}
                          </>
                        )}

                        <Divider />

                        {/* Conflict Resolution */}
                        <Stack
                          direction={{ xs: "column", md: "row" }}
                          spacing={2}
                        >
                          <Controller
                            name="conflictConfig.keyColumns"
                            control={control}
                            render={({ field }) => (
                              <TextField
                                value={
                                  Array.isArray(field.value)
                                    ? field.value.join(", ")
                                    : ""
                                }
                                onChange={e => {
                                  const value = e.target.value;
                                  const columns = value
                                    ? value
                                        .split(",")
                                        .map(k => k.trim())
                                        .filter(Boolean)
                                    : [];
                                  field.onChange(columns);
                                }}
                                label="Key Columns (optional)"
                                placeholder="id, email"
                                helperText="Comma-separated list of columns for upsert"
                                sx={{ flex: 1 }}
                              />
                            )}
                          />
                          <Controller
                            name="conflictConfig.strategy"
                            control={control}
                            render={({ field }) => (
                              <FormControl sx={{ flex: 1 }}>
                                <InputLabel>Conflict Strategy</InputLabel>
                                <Select
                                  {...field}
                                  value={field.value || "update"}
                                  label="Conflict Strategy"
                                >
                                  <MenuItem value="update">
                                    Update (update or insert)
                                  </MenuItem>
                                  <MenuItem value="ignore">
                                    Skip duplicates
                                  </MenuItem>
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
                              name="paginationConfig.mode"
                              control={control}
                              render={({ field }) => (
                                <FormControl fullWidth>
                                  <InputLabel>Pagination Mode</InputLabel>
                                  <Select
                                    {...field}
                                    value={field.value || "offset"}
                                    label="Pagination Mode"
                                  >
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
                                  name="paginationConfig.keysetColumn"
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
                                      value={field.value || ""}
                                      label="Keyset Column"
                                      placeholder="id"
                                      error={
                                        !!errors.paginationConfig?.keysetColumn
                                      }
                                      helperText={
                                        errors.paginationConfig?.keysetColumn
                                          ?.message ||
                                        "Column to use for keyset pagination (e.g., id, created_at)"
                                      }
                                      sx={{ flex: 1 }}
                                    />
                                  )}
                                />
                                <Controller
                                  name="paginationConfig.keysetDirection"
                                  control={control}
                                  render={({ field }) => (
                                    <FormControl sx={{ flex: 1 }}>
                                      <InputLabel>Sort Direction</InputLabel>
                                      <Select
                                        {...field}
                                        value={field.value || "asc"}
                                        label="Sort Direction"
                                      >
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

                        <Box
                          sx={{
                            display: "flex",
                            justifyContent: "flex-end",
                            pt: 2,
                          }}
                        >
                          <Button
                            variant="contained"
                            endIcon={<NextIcon />}
                            onClick={() => openNextStep(3)}
                          >
                            Continue to Schedule
                          </Button>
                        </Box>
                      </Stack>
                    </AccordionDetails>
                  </Accordion>

                  {/* Step 5: Schedule */}
                  <Accordion
                    expanded={openSteps.has(4)}
                    onChange={() => toggleStep(4)}
                    sx={{ mb: 1 }}
                  >
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
                        }}
                      >
                        5
                      </Typography>
                      <Box>
                        <Typography variant="subtitle2">
                          {STEPS[4].label}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {STEPS[4].description}
                        </Typography>
                      </Box>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Stack spacing={3}>
                        {/* Schedule Enable Toggle */}
                        <Box>
                          <Controller
                            name="schedule.enabled"
                            control={control}
                            render={({ field }) => (
                              <FormControlLabel
                                control={
                                  <Switch
                                    checked={field.value}
                                    onChange={field.onChange}
                                  />
                                }
                                label={
                                  <Box>
                                    <Typography variant="body1">
                                      Enable automatic scheduling
                                    </Typography>
                                    <Typography
                                      variant="body2"
                                      color="text.secondary"
                                    >
                                      {field.value
                                        ? "Flow will run automatically on the configured schedule"
                                        : "Flow can only be run manually (no automatic schedule)"}
                                    </Typography>
                                  </Box>
                                }
                              />
                            )}
                          />
                        </Box>

                        {/* Schedule Configuration - only shown when enabled */}
                        {watchScheduleEnabled && (
                          <>
                            <Box>
                              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                                Schedule
                              </Typography>
                              <ToggleButtonGroup
                                value={scheduleMode}
                                exclusive
                                onChange={handleScheduleModeChange}
                                size="small"
                                fullWidth
                                sx={{
                                  mb: 2,
                                  width: "100%",
                                  p: 0.125,
                                  bgcolor: "action.hover",
                                  borderRadius: 1,
                                  "& .MuiToggleButton-root": {
                                    flex: 1,
                                    textTransform: "none",
                                    border: "none",
                                    borderRadius: 0.75,
                                    fontWeight: 600,
                                    fontSize: "0.875rem",
                                    lineHeight: 1.2,
                                    minHeight: 36,
                                    py: 0.5,
                                  },
                                  "& .MuiToggleButton-root.Mui-selected": {
                                    bgcolor: "background.paper",
                                    boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
                                  },
                                }}
                              >
                                <ToggleButton value="preset">
                                  Preset
                                </ToggleButton>
                                <ToggleButton value="custom">
                                  Custom
                                </ToggleButton>
                              </ToggleButtonGroup>
                            </Box>

                            <Stack
                              direction={{ xs: "column", md: "row" }}
                              spacing={2}
                            >
                              <Box
                                sx={{
                                  flex: scheduleMode === "preset" ? 2 : 1.5,
                                }}
                              >
                                <Controller
                                  name="schedule.cron"
                                  control={control}
                                  render={({ field }) => {
                                    return scheduleMode === "preset" ? (
                                      <FormControl fullWidth>
                                        <InputLabel>Schedule Preset</InputLabel>
                                        <Select
                                          {...field}
                                          value={field.value || ""}
                                          label="Schedule Preset"
                                        >
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
                                        value={field.value || ""}
                                        fullWidth
                                        label="Cron Expression"
                                        error={!!errors.schedule?.cron}
                                        helperText={
                                          errors.schedule?.cron?.message ||
                                          "Format: minute hour day month weekday"
                                        }
                                        placeholder="0 * * * *"
                                      />
                                    );
                                  }}
                                />
                              </Box>

                              <Box sx={{ flex: 1 }}>
                                <Controller
                                  name="schedule.timezone"
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

                            {/* Schedule Preview */}
                            <Alert severity="info" icon={<ScheduleIcon />}>
                              <Typography variant="body2">
                                <strong>Schedule:</strong>{" "}
                                {getCronDescription(watchScheduleCron)}
                                {watchScheduleTimezone &&
                                  ` in ${watchScheduleTimezone}`}
                              </Typography>
                            </Alert>
                          </>
                        )}

                        {!watchScheduleEnabled && (
                          <Alert severity="info">
                            <Typography variant="body2">
                              This flow will only run when triggered manually.
                              You can enable automatic scheduling at any time.
                            </Typography>
                          </Alert>
                        )}

                        {/* Save Button */}
                        <Box
                          sx={{
                            display: "flex",
                            justifyContent: "flex-end",
                            pt: 2,
                          }}
                        >
                          <Button
                            type="submit"
                            variant="contained"
                            startIcon={isNewMode ? <AddIcon /> : <SaveIcon />}
                            disabled={isSubmitting || !canSave}
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
                    </AccordionDetails>
                  </Accordion>
                </form>
              </>
            )}
          </Box>
        </Box>
      </Box>
    );
  },
);
