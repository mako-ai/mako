import React, { useState, useEffect } from "react";
import {
  Box,
  Typography,
  Switch,
  FormControlLabel,
  Button,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Alert,
  Snackbar,
} from "@mui/material";
import { Save as SaveIcon, Refresh as RefreshIcon } from "@mui/icons-material";
import ThemeSelector from "../components/ThemeSelector";
import { useCustomPrompt } from "../hooks/useCustomPrompt";
import { WorkspaceMembers } from "../components/WorkspaceMembers";
import { ApiKeyManager } from "../components/ApiKeyManager";
import { useWorkspace } from "../contexts/workspace-context";

function Settings() {
  const { currentWorkspace } = useWorkspace();
  const [openaiApiKey, setOpenaiApiKey] = useState(
    localStorage.getItem("openai_api_key") || "",
  );

  // Custom prompt state
  const {
    content: customPromptContent,
    isLoading: customPromptLoading,
    error: customPromptError,
    updateCustomPrompt,
    fetchCustomPrompt,
  } = useCustomPrompt();

  const [localCustomPrompt, setLocalCustomPrompt] = useState("");
  const [customPromptModified, setCustomPromptModified] = useState(false);
  const [showSnackbar, setShowSnackbar] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState("");

  // Update local state when custom prompt content changes
  useEffect(() => {
    setLocalCustomPrompt(customPromptContent);
    setCustomPromptModified(false);
  }, [customPromptContent]);

  const handleSaveSettings = () => {
    // Save OpenAI API key to localStorage
    localStorage.setItem("openai_api_key", openaiApiKey);

    setSnackbarMessage("Settings saved successfully!");
    setShowSnackbar(true);
  };

  const handleCustomPromptChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    setLocalCustomPrompt(event.target.value);
    setCustomPromptModified(event.target.value !== customPromptContent);
  };

  const handleSaveCustomPrompt = async () => {
    const success = await updateCustomPrompt(localCustomPrompt);
    if (success) {
      setCustomPromptModified(false);
      setSnackbarMessage("Custom prompt saved successfully!");
      setShowSnackbar(true);
    }
  };

  const handleResetCustomPrompt = async () => {
    if (!currentWorkspace?.id) {
      setSnackbarMessage("No workspace selected");
      setShowSnackbar(true);
      return;
    }

    try {
      const response = await fetch(
        `/api/workspaces/${currentWorkspace.id}/custom-prompt/reset`,
        {
          method: "POST",
        },
      );

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          await fetchCustomPrompt(); // Refresh the content
          setSnackbarMessage("Custom prompt reset to default!");
          setShowSnackbar(true);
        }
      }
    } catch (error) {
      console.error("Error resetting custom prompt:", error);
    }
  };

  return (
    <Box
      sx={{
        height: "100%",
        p: 1,
        overflow: "auto",
        bgcolor: "background.paper",
      }}
    >
      <Box sx={{ p: 2, maxWidth: "800px", mx: "auto" }}>
        <Typography variant="h4" component="h1" sx={{ mb: 4 }}>
          Workspace Settings
        </Typography>

        {/* OpenAI Configuration */}
        <Box sx={{ mb: 4 }}>
          <Typography
            variant="subtitle1"
            gutterBottom
            sx={{ fontWeight: 600, mb: 2 }}
          >
            OpenAI Configuration
          </Typography>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <TextField
              label="OpenAI API Key"
              value={openaiApiKey}
              onChange={e => setOpenaiApiKey(e.target.value)}
              type="password"
              fullWidth
              placeholder="sk-..."
              helperText="Enter your OpenAI API key to enable AI chat functionality"
            />
            <Button
              variant="outlined"
              sx={{ alignSelf: "flex-start" }}
              disabled={!openaiApiKey.trim()}
            >
              Test API Key
            </Button>
          </Box>
        </Box>

        {/* Custom Prompt Configuration */}
        <Box sx={{ mb: 4 }}>
          <Typography
            variant="subtitle1"
            gutterBottom
            sx={{ fontWeight: 600, mb: 1 }}
          >
            Custom Prompt Configuration
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Customize the AI assistant&apos;s behavior by adding context about
            your business, data relationships, and common query patterns.
          </Typography>

          {customPromptError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {customPromptError}
            </Alert>
          )}

          <TextField
            fullWidth
            multiline
            rows={10}
            value={localCustomPrompt}
            onChange={handleCustomPromptChange}
            placeholder="Enter your custom prompt content here..."
            disabled={customPromptLoading}
            sx={{ mb: 2 }}
          />

          <Box sx={{ display: "flex", gap: 1 }}>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={handleSaveCustomPrompt}
              disabled={!customPromptModified || customPromptLoading}
            >
              Save Custom Prompt
            </Button>
            <Button
              variant="outlined"
              startIcon={<RefreshIcon />}
              onClick={handleResetCustomPrompt}
              disabled={customPromptLoading}
            >
              Reset to Default
            </Button>
          </Box>
        </Box>

        {/* Workspace Members */}
        <Box sx={{ mb: 4 }}>
          <WorkspaceMembers />
        </Box>

        {/* API Keys */}
        <Box sx={{ mb: 4 }}>
          <ApiKeyManager />
        </Box>

        {/* Appearance Settings */}
        <Box sx={{ mb: 4 }}>
          <Typography
            variant="subtitle1"
            gutterBottom
            sx={{ fontWeight: 600, mb: 2 }}
          >
            Appearance
          </Typography>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <Box
              sx={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Typography variant="body1">Theme</Typography>
              <ThemeSelector />
            </Box>
            <FormControlLabel
              control={<Switch defaultChecked />}
              label="Show line numbers in editor"
            />
            <FormControlLabel
              control={<Switch defaultChecked />}
              label="Enable syntax highlighting"
            />
            <FormControlLabel
              control={<Switch />}
              label="Word wrap in editor"
            />
          </Box>
        </Box>

        {/* Query Execution Settings */}
        <Box sx={{ mb: 4 }}>
          <Typography
            variant="subtitle1"
            gutterBottom
            sx={{ fontWeight: 600, mb: 2 }}
          >
            Query Execution
          </Typography>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <FormControl fullWidth>
              <InputLabel>Default result limit</InputLabel>
              <Select defaultValue={1000} label="Default result limit">
                <MenuItem value={100}>100 rows</MenuItem>
                <MenuItem value={500}>500 rows</MenuItem>
                <MenuItem value={1000}>1,000 rows</MenuItem>
                <MenuItem value={5000}>5,000 rows</MenuItem>
                <MenuItem value={10000}>10,000 rows</MenuItem>
              </Select>
            </FormControl>
            <FormControl fullWidth>
              <InputLabel>Query timeout</InputLabel>
              <Select defaultValue={30} label="Query timeout">
                <MenuItem value={10}>10 seconds</MenuItem>
                <MenuItem value={30}>30 seconds</MenuItem>
                <MenuItem value={60}>1 minute</MenuItem>
                <MenuItem value={300}>5 minutes</MenuItem>
                <MenuItem value={600}>10 minutes</MenuItem>
              </Select>
            </FormControl>
            <FormControlLabel
              control={<Switch defaultChecked />}
              label="Auto-save queries"
            />
            <FormControlLabel
              control={<Switch />}
              label="Confirm before executing destructive queries"
            />
          </Box>
        </Box>

        {/* Database Connection */}
        <Box sx={{ mb: 4 }}>
          <Typography
            variant="subtitle1"
            gutterBottom
            sx={{ fontWeight: 600, mb: 2 }}
          >
            Database Connection
          </Typography>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <TextField
              label="Connection Name"
              defaultValue="Production Database"
              fullWidth
            />
            <TextField label="Host" defaultValue="localhost" fullWidth />
            <TextField
              label="Port"
              defaultValue="5432"
              type="number"
              fullWidth
            />
            <TextField label="Database" defaultValue="revops_db" fullWidth />
            <Button variant="outlined" sx={{ alignSelf: "flex-start" }}>
              Test Connection
            </Button>
          </Box>
        </Box>

        {/* Save Button */}
        <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 4, mb: 2 }}>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={handleSaveSettings}
            disableElevation
          >
            Save Settings
          </Button>
        </Box>
      </Box>

      <Snackbar
        open={showSnackbar}
        autoHideDuration={6000}
        onClose={() => setShowSnackbar(false)}
      >
        <Alert onClose={() => setShowSnackbar(false)} severity="success">
          {snackbarMessage}
        </Alert>
      </Snackbar>
    </Box>
  );
}

export default Settings;
