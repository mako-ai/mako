import { useState, useEffect } from "react";
import {
  Box,
  TextField,
  Button,
  Typography,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Chip,
  IconButton,
  Switch,
  FormControlLabel,
  Alert,
  Divider,
  Paper,
} from "@mui/material";
import {
  Plus as AddIcon,
  Trash2 as DeleteIcon,
  Save as SaveIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useConnectorBuilderStore,
  type ConnectorInstance,
} from "../store/connectorBuilderStore";
import { apiClient } from "../lib/api-client";

interface ConnectorInstanceFormProps {
  connectorId: string;
  instanceId?: string;
  onSaved?: () => void;
}

interface DatabaseOption {
  _id: string;
  name: string;
  type: string;
}

export function ConnectorInstanceForm({
  connectorId,
  instanceId,
  onSaved,
}: ConnectorInstanceFormProps) {
  const { currentWorkspace } = useWorkspace();
  const { createInstance, updateInstance, fetchInstances, instances } =
    useConnectorBuilderStore();

  const [name, setName] = useState("");
  const [destinationConnectionId, setDestinationConnectionId] = useState("");
  const [destinationDatabase, setDestinationDatabase] = useState("");
  const [schemaName, setSchemaName] = useState("public");
  const [tablePrefix, setTablePrefix] = useState("");
  const [evolutionMode, setEvolutionMode] = useState("additive");
  const [cronExpression, setCronExpression] = useState("0 */6 * * *");
  const [hasCronTrigger, setHasCronTrigger] = useState(false);
  const [hasWebhookTrigger, setHasWebhookTrigger] = useState(false);
  const [databases, setDatabases] = useState<DatabaseOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Secrets as key-value pairs
  const [secretEntries, setSecretEntries] = useState<
    Array<{ key: string; value: string }>
  >([]);

  // Config as key-value pairs
  const [configEntries, setConfigEntries] = useState<
    Array<{ key: string; value: string }>
  >([]);

  // Load databases for destination picker
  useEffect(() => {
    if (!currentWorkspace?.id) return;
    apiClient
      .get<{ success: boolean; data: DatabaseOption[] }>(
        `/workspaces/${currentWorkspace.id}/databases`,
      )
      .then(res => {
        if (res.success) setDatabases(res.data || []);
      })
      .catch(() => {});
  }, [currentWorkspace?.id]);

  // Load existing instance if editing
  useEffect(() => {
    if (!instanceId || !currentWorkspace?.id) return;
    const allInstances = instances[connectorId] || [];
    const existing = allInstances.find(i => i._id === instanceId);
    if (existing) {
      populateForm(existing);
    }
  }, [instanceId, connectorId, instances, currentWorkspace?.id]);

  const populateForm = (inst: ConnectorInstance) => {
    setName(inst.name);
    setDestinationConnectionId(inst.output?.destinationConnectionId || "");
    setDestinationDatabase(inst.output?.destinationDatabase || "");
    setSchemaName(inst.output?.schema || "public");
    setTablePrefix(inst.output?.tablePrefix || "");
    setEvolutionMode(inst.output?.schemaEvolutionMode || "additive");

    const cronTrigger = inst.triggers.find(t => t.type === "cron");
    const webhookTrigger = inst.triggers.find(t => t.type === "webhook");
    setHasCronTrigger(!!cronTrigger);
    setHasWebhookTrigger(!!webhookTrigger);
    if (cronTrigger?.cron) setCronExpression(cronTrigger.cron);

    setConfigEntries(
      Object.entries(inst.config || {}).map(([key, value]) => ({
        key,
        value: String(value),
      })),
    );
  };

  const handleSave = async () => {
    if (!currentWorkspace?.id) return;
    setSaving(true);
    setError(null);

    try {
      const triggers: Array<Record<string, unknown>> = [];
      if (hasCronTrigger) {
        triggers.push({
          type: "cron",
          cron: cronExpression,
          timezone: "UTC",
          syncMode: "incremental",
        });
      }
      if (hasWebhookTrigger) {
        triggers.push({
          type: "webhook",
          webhookPath: `${currentWorkspace.id}/uc/`,
        });
      }

      const secrets: Record<string, string> = {};
      for (const entry of secretEntries) {
        if (entry.key.trim()) secrets[entry.key.trim()] = entry.value;
      }

      const config: Record<string, string> = {};
      for (const entry of configEntries) {
        if (entry.key.trim()) config[entry.key.trim()] = entry.value;
      }

      const data = {
        connectorId,
        name: name || "Default Instance",
        secrets,
        config,
        output: {
          destinationConnectionId: destinationConnectionId || undefined,
          destinationDatabase: destinationDatabase || undefined,
          schema: schemaName || undefined,
          tablePrefix: tablePrefix || undefined,
          schemaEvolutionMode: evolutionMode,
        },
        triggers,
      };

      if (instanceId) {
        await updateInstance(currentWorkspace.id, instanceId, data);
      } else {
        await createInstance(currentWorkspace.id, data);
      }

      await fetchInstances(currentWorkspace.id, connectorId);
      onSaved?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save instance");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box
      sx={{
        p: 2,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        overflow: "auto",
        height: "100%",
      }}
    >
      <Typography variant="subtitle2" fontWeight={600}>
        {instanceId ? "Edit Instance" : "New Instance"}
      </Typography>

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <TextField
        label="Instance Name"
        value={name}
        onChange={e => setName(e.target.value)}
        size="small"
        fullWidth
      />

      <Divider />
      <Typography variant="caption" fontWeight={600} color="text.secondary">
        DESTINATION
      </Typography>

      <FormControl size="small" fullWidth>
        <InputLabel>Destination Database</InputLabel>
        <Select
          value={destinationConnectionId}
          onChange={e => setDestinationConnectionId(e.target.value)}
          label="Destination Database"
        >
          <MenuItem value="">
            <em>None (dev-run only)</em>
          </MenuItem>
          {databases.map(db => (
            <MenuItem key={db._id} value={db._id}>
              {db.name} ({db.type})
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <TextField
        label="Database Name"
        value={destinationDatabase}
        onChange={e => setDestinationDatabase(e.target.value)}
        size="small"
        fullWidth
        placeholder="e.g., analytics"
      />

      <TextField
        label="Schema"
        value={schemaName}
        onChange={e => setSchemaName(e.target.value)}
        size="small"
        fullWidth
        placeholder="public"
      />

      <TextField
        label="Table Prefix"
        value={tablePrefix}
        onChange={e => setTablePrefix(e.target.value)}
        size="small"
        fullWidth
        placeholder="e.g., stripe_"
      />

      <FormControl size="small" fullWidth>
        <InputLabel>Schema Evolution Mode</InputLabel>
        <Select
          value={evolutionMode}
          onChange={e => setEvolutionMode(e.target.value)}
          label="Schema Evolution Mode"
        >
          <MenuItem value="additive">
            Additive (new columns added automatically)
          </MenuItem>
          <MenuItem value="strict">Strict (exact match required)</MenuItem>
          <MenuItem value="permissive">
            Permissive (variant columns for type changes)
          </MenuItem>
          <MenuItem value="locked">
            Locked (no schema changes, new columns dropped)
          </MenuItem>
        </Select>
      </FormControl>

      <Divider />
      <Typography variant="caption" fontWeight={600} color="text.secondary">
        TRIGGERS
      </Typography>

      <FormControlLabel
        control={
          <Switch
            checked={hasCronTrigger}
            onChange={e => setHasCronTrigger(e.target.checked)}
            size="small"
          />
        }
        label="Schedule (Cron)"
      />

      {hasCronTrigger && (
        <TextField
          label="Cron Expression"
          value={cronExpression}
          onChange={e => setCronExpression(e.target.value)}
          size="small"
          fullWidth
          placeholder="0 */6 * * *"
          helperText="e.g., '0 */6 * * *' for every 6 hours"
        />
      )}

      <FormControlLabel
        control={
          <Switch
            checked={hasWebhookTrigger}
            onChange={e => setHasWebhookTrigger(e.target.checked)}
            size="small"
          />
        }
        label="Webhook"
      />

      {hasWebhookTrigger && (
        <Alert severity="info" sx={{ fontSize: "0.75rem" }}>
          Webhook URL will be generated after saving. It will be:{" "}
          <code>
            /api/webhooks/{currentWorkspace?.id}/uc/{"<instanceId>"}
          </code>
        </Alert>
      )}

      <Divider />
      <Typography variant="caption" fontWeight={600} color="text.secondary">
        SECRETS
      </Typography>

      {secretEntries.map((entry, idx) => (
        <Box key={idx} sx={{ display: "flex", gap: 1 }}>
          <TextField
            label="Key"
            value={entry.key}
            onChange={e => {
              const updated = [...secretEntries];
              updated[idx].key = e.target.value;
              setSecretEntries(updated);
            }}
            size="small"
            sx={{ flex: 1 }}
          />
          <TextField
            label="Value"
            value={entry.value}
            onChange={e => {
              const updated = [...secretEntries];
              updated[idx].value = e.target.value;
              setSecretEntries(updated);
            }}
            size="small"
            type="password"
            sx={{ flex: 1 }}
          />
          <IconButton
            size="small"
            onClick={() => {
              setSecretEntries(secretEntries.filter((_, i) => i !== idx));
            }}
          >
            <DeleteIcon size={14} />
          </IconButton>
        </Box>
      ))}

      <Button
        size="small"
        startIcon={<AddIcon size={14} />}
        onClick={() =>
          setSecretEntries([...secretEntries, { key: "", value: "" }])
        }
        sx={{ alignSelf: "flex-start", textTransform: "none" }}
      >
        Add Secret
      </Button>

      <Divider />
      <Typography variant="caption" fontWeight={600} color="text.secondary">
        CONFIG
      </Typography>

      {configEntries.map((entry, idx) => (
        <Box key={idx} sx={{ display: "flex", gap: 1 }}>
          <TextField
            label="Key"
            value={entry.key}
            onChange={e => {
              const updated = [...configEntries];
              updated[idx].key = e.target.value;
              setConfigEntries(updated);
            }}
            size="small"
            sx={{ flex: 1 }}
          />
          <TextField
            label="Value"
            value={entry.value}
            onChange={e => {
              const updated = [...configEntries];
              updated[idx].value = e.target.value;
              setConfigEntries(updated);
            }}
            size="small"
            sx={{ flex: 1 }}
          />
          <IconButton
            size="small"
            onClick={() => {
              setConfigEntries(configEntries.filter((_, i) => i !== idx));
            }}
          >
            <DeleteIcon size={14} />
          </IconButton>
        </Box>
      ))}

      <Button
        size="small"
        startIcon={<AddIcon size={14} />}
        onClick={() =>
          setConfigEntries([...configEntries, { key: "", value: "" }])
        }
        sx={{ alignSelf: "flex-start", textTransform: "none" }}
      >
        Add Config
      </Button>

      <Box sx={{ mt: 2 }}>
        <Button
          variant="contained"
          startIcon={<SaveIcon size={14} />}
          onClick={handleSave}
          disabled={saving}
          sx={{ textTransform: "none" }}
        >
          {saving
            ? "Saving..."
            : instanceId
              ? "Update Instance"
              : "Create Instance"}
        </Button>
      </Box>
    </Box>
  );
}
