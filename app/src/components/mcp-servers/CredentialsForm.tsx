import { useState } from "react";
import {
  Alert,
  Button,
  Chip,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useWorkspace } from "../../contexts/workspace-context";
import {
  type McpPresetInfo,
  type McpServerInfo,
  useMcpStore,
} from "../../store/mcpStore";
import { type HeaderRow, newHeaderRow } from "./mcp-server-helpers";

export function CredentialsForm({
  server,
  preset,
  onSaved,
}: {
  server: McpServerInfo;
  preset: McpPresetInfo | undefined;
  onSaved: () => void;
}) {
  const { currentWorkspace } = useWorkspace();
  const saveCredentials = useMcpStore(s => s.saveCredentials);
  const fields = preset?.headerFields ?? [];
  const isCustom = fields.length === 0;
  const [values, setValues] = useState<Record<string, string>>({});
  const [customHeaders, setCustomHeaders] = useState<Array<HeaderRow>>(() => [
    newHeaderRow(),
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasCredential =
    server.authPerformer === "workspace"
      ? server.hasWorkspaceCredential
      : server.hasUserCredential;

  const handleSave = async () => {
    if (!currentWorkspace) return;
    setSaving(true);
    setError(null);
    try {
      const headers = isCustom
        ? Object.fromEntries(
            customHeaders
              .filter(h => h.key.trim() && h.value.trim())
              .map(h => [h.key.trim(), h.value.trim()]),
          )
        : Object.fromEntries(
            Object.entries(values).filter(([, v]) => v.trim().length > 0),
          );
      await saveCredentials(currentWorkspace.id, server.id, headers);
      setValues({});
      setCustomHeaders([newHeaderRow()]);
      onSaved();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save credentials",
      );
    } finally {
      setSaving(false);
    }
  };

  const filled = isCustom
    ? customHeaders.some(h => h.key.trim() && h.value.trim())
    : fields.every(
        f => !f.required || (values[f.name] ?? "").trim().length > 0,
      );

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">
        {server.authPerformer === "workspace"
          ? "Workspace credential"
          : "Your credential"}
        {hasCredential && (
          <Chip
            label="Saved"
            size="small"
            color="success"
            variant="outlined"
            sx={{ ml: 1 }}
          />
        )}
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {isCustom ? (
        <>
          {customHeaders.map((h, i) => (
            <Stack key={h.id} direction="row" spacing={1}>
              <TextField
                label="Header name"
                size="small"
                value={h.key}
                onChange={e =>
                  setCustomHeaders(prev =>
                    prev.map((p, j) =>
                      j === i ? { ...p, key: e.target.value } : p,
                    ),
                  )
                }
                placeholder="Authorization"
                sx={{ flex: 1 }}
              />
              <TextField
                label="Value"
                size="small"
                type="password"
                value={h.value}
                onChange={e =>
                  setCustomHeaders(prev =>
                    prev.map((p, j) =>
                      j === i ? { ...p, value: e.target.value } : p,
                    ),
                  )
                }
                placeholder="Bearer …"
                sx={{ flex: 2 }}
              />
            </Stack>
          ))}
          <Button
            size="small"
            onClick={() => setCustomHeaders(prev => [...prev, newHeaderRow()])}
            sx={{ alignSelf: "flex-start" }}
          >
            Add header
          </Button>
        </>
      ) : (
        fields.map(field => (
          <TextField
            key={field.name}
            label={field.label}
            size="small"
            fullWidth
            type={field.type === "password" ? "password" : "text"}
            required={field.required}
            helperText={field.helperText}
            value={values[field.name] ?? ""}
            onChange={e =>
              setValues(prev => ({ ...prev, [field.name]: e.target.value }))
            }
            placeholder={hasCredential ? "•••••••• (saved)" : undefined}
          />
        ))
      )}
      <Button
        variant="outlined"
        size="small"
        disabled={!filled || saving}
        onClick={handleSave}
        sx={{ alignSelf: "flex-start" }}
      >
        {saving ? "Saving…" : "Save credentials"}
      </Button>
    </Stack>
  );
}
