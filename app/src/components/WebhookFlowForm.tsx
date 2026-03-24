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
import { trackEvent } from "../lib/analytics";

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

const CLOSE_ENTITY_FIELDS: Record<string, string[]> = {
  leads: [
    "id",
    "display_name",
    "status_id",
    "status_label",
    "date_created",
    "date_updated",
    "organization_id",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  opportunities: [
    "id",
    "lead_id",
    "status_id",
    "status_label",
    "status_type",
    "value",
    "date_created",
    "date_updated",
    "date_won",
    "user_id",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  "activities:Call": [
    "id",
    "lead_id",
    "user_id",
    "direction",
    "duration",
    "phone",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  "activities:Email": [
    "id",
    "lead_id",
    "user_id",
    "subject",
    "sender",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  "activities:EmailThread": [
    "id",
    "lead_id",
    "user_id",
    "subject",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  "activities:SMS": [
    "id",
    "lead_id",
    "user_id",
    "text",
    "direction",
    "phone",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  "activities:Meeting": [
    "id",
    "lead_id",
    "user_id",
    "title",
    "starts_at",
    "ends_at",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  "activities:Note": [
    "id",
    "lead_id",
    "user_id",
    "note",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  "activities:LeadStatusChange": [
    "id",
    "lead_id",
    "user_id",
    "old_status_label",
    "new_status_label",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  "activities:OpportunityStatusChange": [
    "id",
    "lead_id",
    "user_id",
    "old_status_label",
    "new_status_label",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  "activities:TaskCompleted": [
    "id",
    "lead_id",
    "user_id",
    "text",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  contacts: [
    "id",
    "lead_id",
    "first_name",
    "last_name",
    "display_name",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  users: [
    "id",
    "email",
    "first_name",
    "last_name",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  custom_fields: [
    "id",
    "name",
    "custom_field_type",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  "activities:CustomActivity": [
    "id",
    "lead_id",
    "user_id",
    "_type",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  custom_activity_types: [
    "id",
    "name",
    "description",
    "api_create_only",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  custom_object_types: [
    "id",
    "name",
    "description",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  custom_objects: [
    "id",
    "custom_object_type",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  lead_statuses: [
    "id",
    "label",
    "organization_id",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
  opportunity_statuses: [
    "id",
    "label",
    "type",
    "organization_id",
    "date_created",
    "date_updated",
    "_dataSourceId",
    "_dataSourceName",
    "_syncedAt",
  ],
};

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
}

const STEPS = [
  { label: "Source", description: "Select the data source connector" },
  { label: "Destination", description: "Configure destination database" },
  {
    label: "Sync Configuration",
    description: "Choose sync engine and delete behavior",
  },
  {
    label: "Entity Configuration",
    description: "Configure per-entity table layouts (BigQuery)",
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
  const [isProvisioningWebhook, setIsProvisioningWebhook] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [_copySuccess, setCopySuccess] = useState(false);
  const [currentFlowId, setCurrentFlowId] = useState<string | undefined>(
    flowId,
  );
  const [isNewMode, setIsNewMode] = useState(isNew);
  const [_entityMetadata, setEntityMetadata] = useState<any[]>([]);
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
      syncEngine: "legacy",
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
  const watchSyncEngine = watch("syncEngine") || "legacy";
  const watchEntityLayouts = watch("entityLayouts") || [];
  const watchDeleteMode = watch("deleteMode");
  const selectedConnector = connectors.find(ds => ds._id === watchDataSourceId);
  const selectedConnectorType = selectedConnector?.type;
  const canProvisionWebhook =
    !isNewMode && Boolean(currentFlowId) && selectedConnectorType === "close";

  const selectedDestination = databases.find(
    db => db.id === watchDestinationId,
  );
  const isBigQueryDest = selectedDestination?.type === "bigquery";

  useEffect(() => {
    if (isBigQueryDest && watchDeleteMode !== "soft") {
      setValue("deleteMode", "soft");
    }
  }, [isBigQueryDest, setValue, watchDeleteMode]);

  // Fetch entity metadata from connector and build per-entity layout defaults
  useEffect(() => {
    if (isBigQueryDest && watchDataSourceId && connectors.length > 0) {
      const source = connectors.find(c => c._id === watchDataSourceId);
      if (!source) return;

      const connectorType = source.type;
      if (connectorType === "close") {
        const entities = [
          {
            name: "leads",
            label: "Leads",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "opportunities",
            label: "Opportunities",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "contacts",
            label: "Contacts",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "activities:Call",
            label: "Calls",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "activities:Email",
            label: "Emails",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "activities:EmailThread",
            label: "Email Threads",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "activities:SMS",
            label: "SMS",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "activities:Meeting",
            label: "Meetings",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "activities:Note",
            label: "Notes",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "activities:LeadStatusChange",
            label: "Lead Status Changes",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "activities:OpportunityStatusChange",
            label: "Opportunity Status Changes",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "activities:TaskCompleted",
            label: "Completed Tasks",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "users",
            label: "Users",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "custom_fields",
            label: "Custom Fields",
            partitionField: "_syncedAt",
            clusterFields: [] as string[],
          },
          {
            name: "activities:CustomActivity",
            label: "Custom Activities",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "custom_activity_types",
            label: "Custom Activity Types",
            partitionField: "_syncedAt",
            clusterFields: [] as string[],
          },
          {
            name: "custom_object_types",
            label: "Custom Object Types",
            partitionField: "_syncedAt",
            clusterFields: [] as string[],
          },
          {
            name: "custom_objects",
            label: "Custom Objects",
            partitionField: "date_created",
            clusterFields: [] as string[],
          },
          {
            name: "lead_statuses",
            label: "Lead Statuses",
            partitionField: "_syncedAt",
            clusterFields: [] as string[],
          },
          {
            name: "opportunity_statuses",
            label: "Opportunity Statuses",
            partitionField: "_syncedAt",
            clusterFields: [] as string[],
          },
        ];
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
          savedLayouts.map((l: any) => [l.entity, l]),
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
                  partitionGranularity: "day" as const,
                  clusterFields: e.clusterFields || [],
                  enabled: true,
                };
          }),
        );
      } else if (connectorType === "stripe") {
        const entities = [
          {
            name: "customers",
            label: "Customers",
            partitionField: "_syncedAt",
            clusterFields: [] as string[],
          },
          {
            name: "subscriptions",
            label: "Subscriptions",
            partitionField: "_syncedAt",
            clusterFields: [] as string[],
          },
          {
            name: "charges",
            label: "Charges",
            partitionField: "_syncedAt",
            clusterFields: [] as string[],
          },
          {
            name: "invoices",
            label: "Invoices",
            partitionField: "_syncedAt",
            clusterFields: [] as string[],
          },
          {
            name: "products",
            label: "Products",
            partitionField: "_syncedAt",
            clusterFields: [] as string[],
          },
          {
            name: "plans",
            label: "Plans",
            partitionField: "_syncedAt",
            clusterFields: [] as string[],
          },
        ];
        setEntityMetadata(entities);
        const existingFlowStripe =
          !isNewMode && currentFlowId
            ? flows.find(j => j._id === currentFlowId)
            : null;
        const savedLayoutsStripe: EntityLayoutConfig[] =
          existingFlowStripe?.entityLayouts || watch("entityLayouts") || [];
        const savedByEntity = new Map(
          savedLayoutsStripe.map((l: any) => [l.entity, l]),
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
                  partitionField: e.partitionField || "_syncedAt",
                  partitionGranularity: "day" as const,
                  clusterFields: e.clusterFields || [],
                  enabled: true,
                };
          }),
        );
      }
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
    isBigQueryDest,
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
      const webhookCapable = (sources || []).filter(
        source => source.type === "stripe" || source.type === "close",
      );
      setConnectors(webhookCapable);
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
          syncEngine: flow.syncEngine || "legacy",
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
      if (data.syncEngine === "cdc" && !isBq) {
        throw new Error(
          "CDC engine is currently available only for BigQuery destinations.",
        );
      }

      const payload: any = {
        name: generatedName,
        type: "webhook",
        dataSourceId: data.dataSourceId,
        destinationDatabaseId: data.destinationDatabaseId,
        syncMode: "incremental",
        syncEngine: data.syncEngine || "legacy",
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

      const desiredSyncEngine = data.syncEngine || "legacy";
      const currentSyncEngine =
        !isNewMode && currentFlowId
          ? (flows.find(flow => flow._id === currentFlowId)?.syncEngine ??
            "legacy")
          : "legacy";

      let newFlow;
      if (isNewMode) {
        newFlow = await createFlow(currentWorkspace.id, payload);
        if (desiredSyncEngine !== "legacy") {
          await setSyncEngine(
            currentWorkspace.id,
            newFlow._id,
            desiredSyncEngine,
          );
        }

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
        if (desiredSyncEngine !== currentSyncEngine) {
          await setSyncEngine(
            currentWorkspace.id,
            currentFlowId,
            desiredSyncEngine,
          );
        }
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
        err instanceof Error ? err.message : "Failed to create in Close",
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
                            Only Stripe and Close connectors support webhooks
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

                  {isBigQueryDest && (
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
                  <Controller
                    name="syncEngine"
                    control={control}
                    render={({ field }) => (
                      <FormControl fullWidth>
                        <InputLabel>Sync engine</InputLabel>
                        <Select {...field} label="Sync engine">
                          <MenuItem value="legacy">legacy</MenuItem>
                          <MenuItem value="cdc" disabled={!isBigQueryDest}>
                            cdc
                          </MenuItem>
                        </Select>
                        <FormHelperText>
                          {watchSyncEngine === "cdc"
                            ? "CDC mode enabled for this flow."
                            : isBigQueryDest
                              ? "CDC is opt-in per flow; legacy remains default."
                              : "CDC currently requires a BigQuery destination."}
                        </FormHelperText>
                      </FormControl>
                    )}
                  />

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
                            ? "BigQuery webhook flows always use soft delete (CDC tombstones)."
                            : "How webhook delete events are handled in the destination"}
                        </FormHelperText>
                      </FormControl>
                    )}
                  />

                  <Box
                    sx={{ display: "flex", justifyContent: "flex-end", pt: 1 }}
                  >
                    <Button
                      variant="contained"
                      endIcon={<NextIcon />}
                      onClick={() => {
                        if (isBigQueryDest) {
                          openNextStep(2);
                        } else {
                          setOpenSteps(prev => new Set([...prev, 4]));
                        }
                      }}
                    >
                      {isBigQueryDest
                        ? "Continue to Entity Configuration"
                        : "Continue to Webhook Setup"}
                    </Button>
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>

            {/* Step 4: Entity Configuration (BigQuery only) */}
            {isBigQueryDest && (
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
                              const entityFields = CLOSE_ENTITY_FIELDS[
                                layout.entity
                              ] || ["_syncedAt", "_dataSourceId", "id"];
                              const timestampFields = entityFields.filter(
                                f =>
                                  f.includes("date") ||
                                  f.includes("created") ||
                                  f.includes("updated") ||
                                  f === "_syncedAt",
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

                    {watchEntityLayouts.length === 0 && (
                      <Alert severity="info">
                        Select a data source and BigQuery destination to
                        configure entities.
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
                          setOpenSteps(prev => new Set([...prev, 4]));
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
                  {isNewMode && (
                    <Alert severity="info" icon={<WebhookIcon />}>
                      <Typography variant="body2">
                        <strong>Webhook:</strong> Real-time sync triggered by
                        webhook events. The webhook URL will be generated after
                        creation.
                      </Typography>
                    </Alert>
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
                          Copy this URL to your Stripe/Close webhook settings
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
                                ? "Creating in Close..."
                                : "Create in Close"}
                            </Button>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                            >
                              One click creates the Close webhook and stores its
                              signing secret.
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
                          {selectedConnectorType === "stripe"
                            ? "Get this from Stripe Dashboard > Webhooks > Your endpoint > Signing secret"
                            : "Enter the webhook signing secret from your provider"}
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
                </Stack>
              </AccordionDetails>
            </Accordion>
          </form>
        </Box>
      </Box>
    </Box>
  );
}
