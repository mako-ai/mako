import { useEffect, useState, useMemo, useRef } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { useWorkspace } from "../../contexts/workspace-context";
import { useFlowStore } from "../../store/flowStore";
import { useSchemaStore, type TreeNode } from "../../store/schemaStore";
import { useConnectorCatalogStore } from "../../store/connectorCatalogStore";
import {
  useAvailableEntitiesStore,
  flattenConnectorEntities,
  type FlattenedConnectorEntity,
} from "../../store/availableEntitiesStore";
import { trackEvent } from "../../lib/analytics";
import { useConfirm } from "../ConfirmDialog";
import {
  SYNC_ENGINE_PERMISSION_ERROR,
  STEPS,
  type EntityLayoutConfig,
  type FormData,
  type SyncFlowFormProps,
} from "./sync-flow-config";
import { cronPresetValue as presetValueForCron } from "../flow-form/schedule-presets";
import { useSyncCapabilities } from "./useSyncCapabilities";
import {
  buildSyncPayload,
  flowToFormData,
  layoutChangedEntities,
  validateSyncSubmission,
  type SyncSaveContext,
} from "./sync-flow-logic";

/** All form state, effects and save logic behind the Sync builder. */
export function useSyncFlowForm({
  flowId,
  isNew = false,
  onSave,
  onSaved,
  onCancel,
  onSwitchToDbSync,
}: SyncFlowFormProps) {
  const { currentWorkspace } = useWorkspace();
  const confirm = useConfirm();
  const flowsMap = useFlowStore(s => s.flows);
  const errorMap = useFlowStore(s => s.error);
  const createFlow = useFlowStore(s => s.createFlow);
  const updateFlow = useFlowStore(s => s.updateFlow);
  const setSyncEngine = useFlowStore(s => s.setSyncEngine);
  const clearError = useFlowStore(s => s.clearError);
  const deleteFlow = useFlowStore(s => s.deleteFlow);
  const fetchConnectors = useFlowStore(s => s.fetchConnectors);
  const provisionFlowWebhook = useFlowStore(s => s.provisionFlowWebhook);
  const resyncCdcFlow = useFlowStore(s => s.resyncCdcFlow);
  const backfillFlow = useFlowStore(s => s.backfillFlow);
  const [backfillStarting, setBackfillStarting] = useState(false);
  const [backfillNotice, setBackfillNotice] = useState<string | null>(null);

  const connectorTypes = useConnectorCatalogStore(state => state.types);
  const fetchCatalog = useConnectorCatalogStore(state => state.fetchCatalog);
  const fetchSchema = useConnectorCatalogStore(state => state.fetchSchema);

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
  // A flow that already holds a signing secret is re-provisioned in place:
  // the API updates the provider's existing subscription instead of
  // creating a second one.
  const watchWebhookSecret = watch("webhookSecret");

  const {
    fields: queryFields,
    append: appendQuery,
    remove: removeQuery,
  } = useFieldArray({ control, name: "queries" });

  const {
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
  } = useSyncCapabilities({
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
  });

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

  // The periodic full reconcile is opt-in. When Incremental polls cannot see
  // updates for the selected entities (created-anchor or none), the form
  // RECOMMENDS it (warning + "Enable daily" button, see step 3) but never
  // switches it on by itself: a reconcile re-upserts every current record on
  // a cron, which is a cost and a load on the source the user must choose.

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

    const { formData, cronMode } = flowToFormData(
      flow,
      getValues("webhookSecret"),
    );
    if (flow.webhookConfig?.endpoint) {
      setWebhookUrl(flow.webhookConfig.endpoint);
    }

    setScheduleCronMode(cronMode);
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
    return layoutChangedEntities(
      flow?.entityLayouts || [],
      data.entityLayouts || [],
    );
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

    const saveContext: SyncSaveContext = {
      connectorSupportsWebhook,
      isCdcCapableDest,
      isBigQueryDest,
      requiresDestinationDatabaseName,
      hasTransferQueries,
      requiresQueries,
      layoutMode,
    };
    const invalid = validateSyncSubmission(data, saveContext);
    if (invalid) {
      setError(invalid.message);
      setOpenSteps(prev => new Set([...prev, invalid.step]));
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

      // Triggers, not a flow type: polling (schedule), webhooks
      // (webhookConfig.enabled) and the periodic resync (backfillSchedule)
      // are independent; webhooks on only add speed on top of polling.
      const flowType = data.webhookEnabled ? "webhook" : "scheduled"; // analytics label

      const payload = buildSyncPayload(data, {
        ...saveContext,
        name: generatedName,
        isNewMode,
        existingFlow: flows.find(flow => flow._id === currentFlowId),
      });

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

  const cronPresetValue = presetValueForCron(watchScheduleCron);

  const handleDelete = async () => {
    if (!currentFlowId) return;
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
  };

  return {
    handleDelete,
    onCancel,
    onSwitchToDbSync,
    currentWorkspace,
    confirm,
    flowsMap,
    errorMap,
    createFlow,
    updateFlow,
    setSyncEngine,
    clearError,
    deleteFlow,
    fetchConnectors,
    provisionFlowWebhook,
    resyncCdcFlow,
    backfillFlow,
    backfillStarting,
    setBackfillStarting,
    backfillNotice,
    setBackfillNotice,
    connectorTypes,
    fetchCatalog,
    fetchSchema,
    webhookCapabilitiesByType,
    incrementalCapabilitiesByType,
    flows,
    storeError,
    connectionsMap,
    ensureConnections,
    ensureTreeRoot,
    databases,
    connectors,
    setConnectors,
    isLoadingConnectors,
    setIsLoadingConnectors,
    availableDatabases,
    setAvailableDatabases,
    webhookUrl,
    setWebhookUrl,
    isSubmitting,
    setIsSubmitting,
    isProvisioningWebhook,
    setIsProvisioningWebhook,
    pinTriggersOpen,
    setPinTriggersOpen,
    webhookProvisionSucceeded,
    setWebhookProvisionSucceeded,
    error,
    setError,
    currentFlowId,
    setCurrentFlowId,
    isNewMode,
    setIsNewMode,
    entityMetadata,
    setEntityMetadata,
    openSteps,
    setOpenSteps,
    scheduleCronMode,
    setScheduleCronMode,
    pendingLayoutReset,
    setPendingLayoutReset,
    transferQueriesSchema,
    setTransferQueriesSchema,
    formTouchedRef,
    toggleStep,
    openNextStep,
    control,
    handleSubmit,
    errors,
    reset,
    watch,
    getValues,
    setValue,
    watchDataSourceId,
    watchDestinationId,
    watchScheduleEnabled,
    watchScheduleCron,
    watchWebhookEnabled,
    watchEntityLayouts,
    watchDeleteMode,
    watchBackfillScheduleEnabled,
    watchSyncMode,
    watchWriteMode,
    watchWebhookSecret,
    queryFields,
    appendQuery,
    removeQuery,
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
    getLayoutChangedEntities,
    onSubmit,
    executeSave,
    provisionWebhookForFlow,
    handleProvisionWebhook,
    stepHasError,
    handleFormSubmit,
    cronPresetValue,
  };
}

export type SyncFlowFormModel = ReturnType<typeof useSyncFlowForm>;
