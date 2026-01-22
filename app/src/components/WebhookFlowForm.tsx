import { useEffect, useState } from "react";
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

interface WebhookFlowFormProps {
  flowId?: string;
  isNew?: boolean;
  onSave?: () => void;
  onSaved?: (flowId: string) => void;
  onCancel?: () => void;
}

interface FormData {
  dataSourceId: string;
  destinationDatabaseId: string;
  webhookSecret?: string;
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
  const flows = currentWorkspace ? flowsMap[currentWorkspace.id] || [] : [];
  const flowsLoading = currentWorkspace
    ? !!loadingMap[currentWorkspace.id]
    : false;
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
  const [success, setSuccess] = useState(false);
  const [currentFlowId, setCurrentFlowId] = useState<string | undefined>(
    flowId,
  );
  const [isNewMode, setIsNewMode] = useState(isNew);

  const {
    control,
    handleSubmit,
    formState: { errors, isDirty },
    reset,
    watch,
    setValue,
  } = useForm<FormData>({
    defaultValues: {
      dataSourceId: "",
      destinationDatabaseId: "",
    },
  });

  const watchDataSourceId = watch("dataSourceId");

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
        };

        // Set webhook-specific data if available
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

      // Create payload compatible with the API
      const payload: any = {
        name: generatedName,
        type: "webhook",
        dataSourceId: data.dataSourceId,
        destinationDatabaseId: data.destinationDatabaseId,
        syncMode: "incremental", // Webhooks are always incremental
        enabled: true, // Webhooks are always enabled
        webhookSecret: data.webhookSecret || "",
      };

      let newFlow;
      if (isNewMode) {
        newFlow = await createFlow(currentWorkspace.id, payload);

        // Track flow creation
        trackEvent("flow_created", {
          flow_type: "webhook",
          connector_type: selectedSource?.type,
        });

        setSuccess(true);
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
        setSuccess(true);
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
                      {connectors.length === 0 && !isLoadingConnectors && (
                        <FormHelperText>
                          Only Stripe and Close connectors support webhooks
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
                                  setSuccess(true);
                                  setTimeout(() => setSuccess(false), 2000);
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
                                    setSuccess(true);
                                    setTimeout(() => setSuccess(false), 2000);
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
