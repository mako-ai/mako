import { useEffect, useState } from "react";
import { Button, Stack, TextField, Typography } from "@mui/material";
import { useWorkspace } from "../../contexts/workspace-context";
import { type McpServerInfo, useMcpStore } from "../../store/mcpStore";
import { notifyMcp } from "./mcp-server-helpers";

/**
 * Admin-only rename + description editor. Renaming is safe: credentials,
 * grants, and tool policies are keyed by server ID — only the agent-facing
 * tool prefix (derived from the name) changes.
 */
export function ServerDetailsForm({ server }: { server: McpServerInfo }) {
  const { currentWorkspace } = useWorkspace();
  const updateServer = useMcpStore(s => s.updateServer);
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description ?? "");
  const [saving, setSaving] = useState(false);

  // Re-sync when switching to a different server in the same dialog.
  useEffect(() => {
    setName(server.name);
    setDescription(server.description ?? "");
  }, [server.id, server.name, server.description]);

  const dirty =
    name.trim() !== server.name ||
    description.trim() !== (server.description ?? "");

  const handleSave = async () => {
    if (!currentWorkspace) return;
    setSaving(true);
    try {
      await updateServer(currentWorkspace.id, server.id, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      notifyMcp("Connection details saved", "success");
    } catch (err) {
      notifyMcp(
        err instanceof Error ? err.message : "Failed to save details",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">Connection details</Typography>
      <TextField
        label="Name"
        size="small"
        fullWidth
        value={name}
        onChange={e => setName(e.target.value)}
        helperText="Shown in tool names, e.g. mcp_close_crm_lead_search — renaming changes the tool prefix the agent sees"
      />
      <TextField
        label="Description"
        size="small"
        fullWidth
        multiline
        minRows={2}
        value={description}
        onChange={e => setDescription(e.target.value)}
        helperText="Optional — shown on the connection card"
      />
      <Button
        variant="outlined"
        size="small"
        disabled={!dirty || name.trim().length === 0 || saving}
        onClick={() => void handleSave()}
        sx={{ alignSelf: "flex-start" }}
        data-testid="mcp-save-details"
      >
        {saving ? "Saving…" : "Save details"}
      </Button>
    </Stack>
  );
}
