import {
  useEffect,
  useState,
  useMemo,
  useImperativeHandle,
  useRef,
  useCallback,
  type ForwardedRef,
} from "react";
import { useForm } from "react-hook-form";
import { useWorkspace } from "../../contexts/workspace-context";
import { useFlowStore } from "../../store/flowStore";
import { useSchemaStore, TreeNode } from "../../store/schemaStore";
import { trackEvent } from "../../lib/analytics";
import { TypeCoercion } from "../SchemaMappingTable";
import { useConfirm } from "../ConfirmDialog";
import { useDbQueryEditor } from "./useDbQueryEditor";
import {
  buildDbFlowPayload,
  dbFlowName,
  validateDbFlow,
} from "./db-flow-logic";
import {
  STEPS,
  DEFAULT_FORM_VALUES,
  type DbFlowFormProps,
  type DbFlowFormRef,
  type FormData,
} from "./db-flow-config";
import { SCHEDULE_PRESETS, describeCron } from "../flow-form/schedule-presets";

/** All form state, effects and save logic behind the database flow form. */
export function useDbFlowForm(
  { flowId, isNew = false, onSave, onSaved, onCancel }: DbFlowFormProps,
  ref: ForwardedRef<DbFlowFormRef>,
) {
  const { currentWorkspace } = useWorkspace();
  const confirm = useConfirm();
  const flowsMap = useFlowStore(s => s.flows);
  const errorMap = useFlowStore(s => s.error);
  const createFlow = useFlowStore(s => s.createFlow);
  const updateFlow = useFlowStore(s => s.updateFlow);
  const clearError = useFlowStore(s => s.clearError);
  const deleteFlow = useFlowStore(s => s.deleteFlow);
  const validateDbQuery = useFlowStore(s => s.validateDbQuery);
  const fetchFlowDetails = useFlowStore(s => s.fetchFlowDetails);

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

  const queryEditor = useDbQueryEditor({
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
  }, [watchSourceConnectionId, currentWorkspace?.id, ensureTreeRoot, setValue]);

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
  const tableExistsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

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
        const flow = await fetchFlowDetails(currentWorkspace.id, currentFlowId);

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
            connectionId: flow.tableDestination?.connectionId?.toString() || "",
            database: flow.tableDestination?.database || "",
            schema: flow.tableDestination?.schema || "",
            tableName: flow.tableDestination?.tableName || "",
            createIfNotExists: flow.tableDestination?.createIfNotExists ?? true,
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
  }, [isNewMode, currentFlowId, currentWorkspace?.id, fetchFlowDetails, reset]);

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

    const invalid = validateDbFlow(data);
    if (invalid) {
      setError(invalid);
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

      const payload = buildDbFlowPayload(
        data,
        dbFlowName(data, selectedSource, selectedDest),
      );

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
      setError(error instanceof Error ? error.message : "Failed to save flow");
    } finally {
      setIsSubmitting(false);
    }
  };

  const getCronDescription = describeCron;

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

  const handleDelete = async () => {
    if (!currentFlowId) return;
    if (
      !(await confirm({
        title: "Are you sure you want to delete this flow?",
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
      } catch (error) {
        console.error("Failed to delete flow:", error);
      }
    }
  };

  return {
    ...queryEditor,
    handleDelete,
    onCancel,
    currentWorkspace,
    confirm,
    flowsMap,
    errorMap,
    createFlow,
    updateFlow,
    clearError,
    deleteFlow,
    validateDbQuery,
    fetchFlowDetails,
    flows,
    isLoadingFlow,
    setIsLoadingFlow,
    storeError,
    connectionsMap,
    databases,
    ensureConnections,
    ensureTreeRoot,
    checkTableExists,
    scheduleMode,
    setScheduleMode,
    isSubmitting,
    setIsSubmitting,
    error,
    setError,
    currentFlowId,
    setCurrentFlowId,
    isNewMode,
    setIsNewMode,
    openSteps,
    setOpenSteps,
    sourceDatabases,
    setSourceDatabases,
    destDatabases,
    setDestDatabases,
    isLoadingSourceDbs,
    setIsLoadingSourceDbs,
    isLoadingDestDbs,
    setIsLoadingDestDbs,
    prevSourceConnectionIdRef,
    prevDestConnectionIdRef,
    isFormInitializedRef,
    isValidating,
    setIsValidating,
    validationResult,
    setValidationResult,
    _destTableExists,
    setDestTableExists,
    control,
    handleSubmit,
    errors,
    reset,
    watch,
    setValue,
    getValues,
    trigger,
    watchScheduleEnabled,
    watchScheduleCron,
    watchScheduleTimezone,
    watchSourceConnectionId,
    watchSourceDatabase,
    watchQuery,
    watchDestConnectionId,
    watchDestDatabase,
    watchDestSchema,
    watchDestTable,
    watchSyncMode,
    watchPaginationMode,
    watchTypeCoercions,
    watchSchemaMappingConfirmed,
    toggleStep,
    openNextStep,
    canSave,
    selectedSourceConnection,
    isBigQuerySource,
    selectedDestConnection,
    isBigQueryDest,
    isPostgresDest,
    showSchemaField,
    getSourceConnectionId,
    getSourceConnectionType,
    handleValidateQuery,
    tableExistsDebounceRef,
    onSubmit,
    getCronDescription,
    handleScheduleModeChange,
    handleTypeCoercionsChange,
    handleMergeColumnsFromValidation,
  };
}

export type DbFlowFormModel = ReturnType<typeof useDbFlowForm>;
