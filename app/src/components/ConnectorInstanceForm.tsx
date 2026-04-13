import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  type ConnectorInstance,
  useConnectorBuilderStore,
} from "../store/connectorBuilderStore";
import { useSchemaStore } from "../store/schemaStore";

interface ConnectorInstanceFormProps {
  workspaceId: string;
  connectorId: string;
  instance?: ConnectorInstance | null;
  onSaved?: (instance: ConnectorInstance) => void;
  onDeleted?: () => void;
}

function parseJsonObject(
  value: string,
  label: string,
): { parsed: Record<string, unknown>; error: string | null } {
  if (!value.trim()) {
    return { parsed: {}, error: null };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        parsed: {},
        error: `${label} must be a JSON object`,
      };
    }

    return { parsed: parsed as Record<string, unknown>, error: null };
  } catch (error) {
    return {
      parsed: {},
      error: `${label} is not valid JSON: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    };
  }
}

export default function ConnectorInstanceForm({
  workspaceId,
  connectorId,
  instance,
  onSaved,
  onDeleted,
}: ConnectorInstanceFormProps) {
  const ensureConnections = useSchemaStore(state => state.ensureConnections);
  const connections = useSchemaStore(
    state => state.connections[workspaceId] || [],
  );
  const { createInstance, updateInstance, deleteInstance } =
    useConnectorBuilderStore();

  const [name, setName] = useState("");
  const [destinationDatabaseId, setDestinationDatabaseId] = useState("");
  const [destinationSchema, setDestinationSchema] = useState("public");
  const [destinationTablePrefix, setDestinationTablePrefix] = useState("");
  const [evolutionMode, setEvolutionMode] = useState<
    "strict" | "append" | "variant" | "relaxed"
  >("append");
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleCron, setScheduleCron] = useState("0 */6 * * *");
  const [scheduleTimezone, setScheduleTimezone] = useState("UTC");
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [manualEnabled, setManualEnabled] = useState(true);
  const [configJson, setConfigJson] = useState("{}");
  const [secretsJson, setSecretsJson] = useState("{}");
  const [stateJson, setStateJson] = useState("{}");
  const [status, setStatus] = useState<
    "idle" | "active" | "running" | "error" | "disabled"
  >("idle");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ensureConnections(workspaceId);
  }, [ensureConnections, workspaceId]);

  useEffect(() => {
    if (!instance) {
      setName("");
      setDestinationDatabaseId("");
      setDestinationSchema("public");
      setDestinationTablePrefix("");
      setEvolutionMode("append");
      setScheduleEnabled(false);
      setScheduleCron("0 */6 * * *");
      setScheduleTimezone("UTC");
      setWebhookEnabled(false);
      setManualEnabled(true);
      setConfigJson("{}");
      setSecretsJson("{}");
      setStateJson("{}");
      setStatus("idle");
      return;
    }

    setName(instance.name);
    setDestinationDatabaseId(instance.output.destinationDatabaseId || "");
    setDestinationSchema(instance.output.destinationSchema || "public");
    setDestinationTablePrefix(instance.output.destinationTablePrefix || "");
    setEvolutionMode(instance.output.evolutionMode || "append");
    setScheduleEnabled(
      instance.triggers.some(
        trigger => trigger.type === "schedule" && trigger.enabled,
      ),
    );
    setScheduleCron(
      instance.triggers.find(trigger => trigger.type === "schedule")?.cron ||
        "0 */6 * * *",
    );
    setScheduleTimezone(
      instance.triggers.find(trigger => trigger.type === "schedule")
        ?.timezone || "UTC",
    );
    setWebhookEnabled(
      instance.triggers.some(
        trigger => trigger.type === "webhook" && trigger.enabled,
      ),
    );
    setManualEnabled(
      instance.triggers.some(
        trigger => trigger.type === "manual" && trigger.enabled,
      ),
    );
    setConfigJson(JSON.stringify(instance.config || {}, null, 2));
    setSecretsJson(JSON.stringify(instance.secrets || {}, null, 2));
    setStateJson(JSON.stringify(instance.state || {}, null, 2));
    setStatus(instance.status);
  }, [instance]);

  const connectionOptions = useMemo(
    () =>
      connections.map(connection => ({
        id: connection.id,
        label: connection.displayName || connection.name,
      })),
    [connections],
  );

  const handleSave = async () => {
    setError(null);
    const parsedConfig = parseJsonObject(configJson, "Config");
    const parsedSecrets = parseJsonObject(secretsJson, "Secrets");
    const parsedState = parseJsonObject(stateJson, "State");
    const parseError =
      parsedConfig.error || parsedSecrets.error || parsedState.error;

    if (parseError) {
      setError(parseError);
      return;
    }

    const triggers = [
      { type: "manual" as const, enabled: manualEnabled },
      {
        type: "schedule" as const,
        enabled: scheduleEnabled,
        cron: scheduleCron,
        timezone: scheduleTimezone,
      },
      { type: "webhook" as const, enabled: webhookEnabled },
    ].filter(trigger => trigger.enabled);

    setSaving(true);
    try {
      const payload = {
        connectorId,
        name: name.trim() || "Untitled Instance",
        secrets: parsedSecrets.parsed,
        config: parsedConfig.parsed,
        state: parsedState.parsed,
        output: {
          destinationDatabaseId: destinationDatabaseId || undefined,
          destinationSchema: destinationSchema || undefined,
          destinationTablePrefix: destinationTablePrefix || undefined,
          evolutionMode,
        },
        triggers,
        status,
      };

      const saved = instance
        ? await updateInstance(workspaceId, instance._id, payload)
        : await createInstance(workspaceId, payload);

      onSaved?.(saved);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save instance",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!instance) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await deleteInstance(workspaceId, instance._id, connectorId);
      onDeleted?.();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete instance",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6">
          {instance ? "Edit instance" : "New instance"}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Configure reusable runtime settings for this connector.
        </Typography>
      </Box>

      {error ? <Alert severity="error">{error}</Alert> : null}

      <TextField
        label="Instance name"
        value={name}
        onChange={event => setName(event.target.value)}
        size="small"
        fullWidth
      />

      <Divider />

      <Typography variant="subtitle2">Destination</Typography>

      <FormControl size="small" fullWidth>
        <InputLabel id="connector-instance-db-label">
          Destination database
        </InputLabel>
        <Select
          labelId="connector-instance-db-label"
          value={destinationDatabaseId}
          label="Destination database"
          onChange={event => setDestinationDatabaseId(event.target.value)}
        >
          <MenuItem value="">
            <em>Dev-run only</em>
          </MenuItem>
          {connectionOptions.map(option => (
            <MenuItem key={option.id} value={option.id}>
              {option.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
        <TextField
          label="Schema"
          value={destinationSchema}
          onChange={event => setDestinationSchema(event.target.value)}
          size="small"
          fullWidth
        />
        <TextField
          label="Table prefix"
          value={destinationTablePrefix}
          onChange={event => setDestinationTablePrefix(event.target.value)}
          size="small"
          fullWidth
        />
      </Stack>

      <FormControl size="small" fullWidth>
        <InputLabel id="connector-instance-evolution-label">
          Evolution mode
        </InputLabel>
        <Select
          labelId="connector-instance-evolution-label"
          value={evolutionMode}
          label="Evolution mode"
          onChange={event =>
            setEvolutionMode(
              event.target.value as "strict" | "append" | "variant" | "relaxed",
            )
          }
        >
          <MenuItem value="append">Append</MenuItem>
          <MenuItem value="strict">Strict</MenuItem>
          <MenuItem value="variant">Variant</MenuItem>
          <MenuItem value="relaxed">Relaxed</MenuItem>
        </Select>
      </FormControl>

      <Divider />

      <Typography variant="subtitle2">Triggers</Typography>

      <FormControlLabel
        control={
          <Switch
            checked={manualEnabled}
            onChange={event => setManualEnabled(event.target.checked)}
          />
        }
        label="Manual runs enabled"
      />
      <FormControlLabel
        control={
          <Switch
            checked={scheduleEnabled}
            onChange={event => setScheduleEnabled(event.target.checked)}
          />
        }
        label="Schedule enabled"
      />
      {scheduleEnabled ? (
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
          <TextField
            label="Cron expression"
            value={scheduleCron}
            onChange={event => setScheduleCron(event.target.value)}
            size="small"
            fullWidth
          />
          <TextField
            label="Timezone"
            value={scheduleTimezone}
            onChange={event => setScheduleTimezone(event.target.value)}
            size="small"
            fullWidth
          />
        </Stack>
      ) : null}
      <FormControlLabel
        control={
          <Switch
            checked={webhookEnabled}
            onChange={event => setWebhookEnabled(event.target.checked)}
          />
        }
        label="Webhook enabled"
      />

      <Divider />

      <Typography variant="subtitle2">Runtime data</Typography>

      <TextField
        label="Config JSON"
        value={configJson}
        onChange={event => setConfigJson(event.target.value)}
        multiline
        minRows={5}
        fullWidth
        InputProps={{ sx: { fontFamily: "monospace" } }}
      />
      <TextField
        label="Secrets JSON"
        value={secretsJson}
        onChange={event => setSecretsJson(event.target.value)}
        multiline
        minRows={5}
        fullWidth
        InputProps={{ sx: { fontFamily: "monospace" } }}
      />
      <TextField
        label="Initial state JSON"
        value={stateJson}
        onChange={event => setStateJson(event.target.value)}
        multiline
        minRows={5}
        fullWidth
        InputProps={{ sx: { fontFamily: "monospace" } }}
      />

      <FormControl size="small" fullWidth>
        <InputLabel id="connector-instance-status-label">Status</InputLabel>
        <Select
          labelId="connector-instance-status-label"
          value={status}
          label="Status"
          onChange={event =>
            setStatus(
              event.target.value as
                | "idle"
                | "active"
                | "running"
                | "error"
                | "disabled",
            )
          }
        >
          <MenuItem value="idle">Idle</MenuItem>
          <MenuItem value="active">Active</MenuItem>
          <MenuItem value="running">Running</MenuItem>
          <MenuItem value="error">Error</MenuItem>
          <MenuItem value="disabled">Disabled</MenuItem>
        </Select>
      </FormControl>

      <Stack direction="row" spacing={1}>
        <Button
          variant="contained"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {instance ? "Save instance" : "Create instance"}
        </Button>
        {instance ? (
          <Button
            color="error"
            variant="outlined"
            onClick={() => void handleDelete()}
            disabled={saving}
          >
            Delete
          </Button>
        ) : null}
      </Stack>
    </Stack>
  );
}
