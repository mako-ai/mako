import { useEffect, useState } from "react";
import { Alert, Box, Button, Snackbar, TextField } from "@mui/material";
import { Save as SaveIcon, Refresh as RefreshIcon } from "@mui/icons-material";
import SettingsLayout from "./SettingsLayout";
import { useCustomPrompt } from "../../hooks/useCustomPrompt";

export default function SettingsPrompt() {
  const {
    content: customPromptContent,
    isLoading,
    error,
    updateCustomPrompt,
    resetCustomPrompt,
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
    if (await resetCustomPrompt()) {
      setSnackbar("Custom prompt reset to default!");
    }
  };

  return (
    <SettingsLayout
      title="Custom Prompt"
      description="Customize the AI assistant's behavior by adding context about your business, data relationships, and common query patterns. Saved as PROMPT.md in your workspace repository — versioned, diffable, and editable from any clone."
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
