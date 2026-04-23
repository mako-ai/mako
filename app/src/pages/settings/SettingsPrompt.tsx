import { useEffect, useState } from "react";
import { Alert, Box, Button, Snackbar, TextField } from "@mui/material";
import { Save as SaveIcon, Refresh as RefreshIcon } from "@mui/icons-material";
import SettingsLayout from "./SettingsLayout";
import { useCustomPrompt } from "../../hooks/useCustomPrompt";
import { useWorkspace } from "../../contexts/workspace-context";

export default function SettingsPrompt() {
  const { currentWorkspace } = useWorkspace();
  const {
    content: customPromptContent,
    isLoading,
    error,
    updateCustomPrompt,
    fetchCustomPrompt,
  } = useCustomPrompt();

  const [local, setLocal] = useState("");
  const [modified, setModified] = useState(false);
  const [snackbar, setSnackbar] = useState<string | null>(null);

  useEffect(() => {
    setLocal(customPromptContent);
    setModified(false);
  }, [customPromptContent]);

  const handleSave = async () => {
    const ok = await updateCustomPrompt(local);
    if (ok) {
      setModified(false);
      setSnackbar("Custom prompt saved successfully!");
    }
  };

  const handleReset = async () => {
    if (!currentWorkspace?.id) return;
    try {
      const res = await fetch(
        `/api/workspaces/${currentWorkspace.id}/custom-prompt/reset`,
        { method: "POST" },
      );
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          await fetchCustomPrompt();
          setSnackbar("Custom prompt reset to default!");
        }
      }
    } catch (err) {
      console.error("Error resetting custom prompt:", err);
    }
  };

  return (
    <SettingsLayout
      title="Custom Prompt"
      description="Customize the AI assistant's behavior by adding context about your business, data relationships, and common query patterns."
    >
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <TextField
        fullWidth
        multiline
        rows={14}
        value={local}
        onChange={e => {
          setLocal(e.target.value);
          setModified(e.target.value !== customPromptContent);
        }}
        placeholder="Enter your custom prompt content here..."
        disabled={isLoading}
        sx={{ mb: 2 }}
      />

      <Box sx={{ display: "flex", gap: 1 }}>
        <Button
          variant="contained"
          disableElevation
          startIcon={<SaveIcon />}
          onClick={handleSave}
          disabled={!modified || isLoading}
        >
          Save Custom Prompt
        </Button>
        <Button
          variant="outlined"
          startIcon={<RefreshIcon />}
          onClick={handleReset}
          disabled={isLoading}
        >
          Reset to Default
        </Button>
      </Box>

      <Snackbar
        open={snackbar !== null}
        autoHideDuration={4000}
        onClose={() => setSnackbar(null)}
      >
        <Alert onClose={() => setSnackbar(null)} severity="success">
          {snackbar}
        </Alert>
      </Snackbar>
    </SettingsLayout>
  );
}
