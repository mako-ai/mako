import React, { useState, useEffect, useMemo, useCallback } from "react";
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
  Chip,
  CircularProgress,
  Checkbox,
  InputAdornment,
  Collapse,
  IconButton,
} from "@mui/material";
import {
  Save as SaveIcon,
  Refresh as RefreshIcon,
  Search as SearchIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
} from "@mui/icons-material";
import ThemeSelector from "../components/ThemeSelector";
import { useCustomPrompt } from "../hooks/useCustomPrompt";
import { WorkspaceMembers } from "../components/WorkspaceMembers";
import { ApiKeyManager } from "../components/ApiKeyManager";
import { BillingSection } from "../components/BillingSection";
import { useWorkspace } from "../contexts/workspace-context";
import { useSettingsStore } from "../store/settingsStore";
import type { GatewayModelInfo } from "../lib/api-types";

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

        {/* AI Models Configuration */}
        <AIModelsSection
          workspaceId={currentWorkspace?.id}
          onSnackbar={msg => {
            setSnackbarMessage(msg);
            setShowSnackbar(true);
          }}
        />

        {/* Billing */}
        <Box sx={{ mb: 4 }}>
          <BillingSection />
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

// ---------------------------------------------------------------------------
// AI Models Section
// ---------------------------------------------------------------------------

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  meta: "Meta",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  xai: "xAI",
  cohere: "Cohere",
  amazon: "Amazon",
};

function providerLabel(provider: string): string {
  return (
    PROVIDER_LABELS[provider] ||
    provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}

function AIModelsSection({
  workspaceId,
  onSnackbar,
}: {
  workspaceId?: string;
  onSnackbar: (msg: string) => void;
}) {
  const gatewayModels = useSettingsStore(s => s.gatewayModels);
  const gatewayModelsLoading = useSettingsStore(s => s.gatewayModelsLoading);
  const gatewayModelsError = useSettingsStore(s => s.gatewayModelsError);
  const fetchGatewayModels = useSettingsStore(s => s.fetchGatewayModels);
  const enabledModelIds = useSettingsStore(s => s.enabledModelIds);
  const enabledModelsLoading = useSettingsStore(s => s.enabledModelsLoading);
  const fetchEnabledModels = useSettingsStore(s => s.fetchEnabledModels);
  const saveEnabledModels = useSettingsStore(s => s.saveEnabledModels);
  const fetchModels = useSettingsStore(s => s.fetchModels);

  const [localEnabled, setLocalEnabled] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    fetchGatewayModels();
  }, [fetchGatewayModels]);

  useEffect(() => {
    if (workspaceId) {
      fetchEnabledModels(workspaceId);
    }
  }, [workspaceId, fetchEnabledModels]);

  useEffect(() => {
    setLocalEnabled(new Set(enabledModelIds));
  }, [enabledModelIds]);

  const providers = useMemo(() => {
    const p = new Set<string>();
    gatewayModels.forEach(m => p.add(m.provider));
    return Array.from(p).sort();
  }, [gatewayModels]);

  const filtered = useMemo(() => {
    let models = gatewayModels;
    if (providerFilter) {
      models = models.filter(m => m.provider === providerFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      models = models.filter(
        m =>
          m.id.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q),
      );
    }
    return models;
  }, [gatewayModels, providerFilter, search]);

  const groupedByProvider = useMemo(() => {
    const groups = new Map<string, GatewayModelInfo[]>();
    for (const m of filtered) {
      const list = groups.get(m.provider) || [];
      list.push(m);
      groups.set(m.provider, list);
    }
    return groups;
  }, [filtered]);

  const toggleModel = useCallback((id: string) => {
    setLocalEnabled(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleProvider = useCallback(
    (_provider: string, models: GatewayModelInfo[]) => {
      setLocalEnabled(prev => {
        const next = new Set(prev);
        const allEnabled = models.every(m => next.has(m.id));
        if (allEnabled) {
          models.forEach(m => next.delete(m.id));
        } else {
          models.forEach(m => next.add(m.id));
        }
        return next;
      });
    },
    [],
  );

  const toggleProviderCollapse = useCallback((provider: string) => {
    setCollapsedProviders(prev => {
      const next = new Set(prev);
      if (next.has(provider)) {
        next.delete(provider);
      } else {
        next.add(provider);
      }
      return next;
    });
  }, []);

  const hasChanges = useMemo(() => {
    if (localEnabled.size !== enabledModelIds.length) return true;
    return enabledModelIds.some(id => !localEnabled.has(id));
  }, [localEnabled, enabledModelIds]);

  const handleSave = async () => {
    if (!workspaceId) return;
    if (localEnabled.size === 0) {
      onSnackbar("At least one model must be enabled");
      return;
    }
    setSaving(true);
    const modelsToSave = gatewayModels
      .filter(m => localEnabled.has(m.id))
      .map(m => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        description: m.description,
      }));
    const success = await saveEnabledModels(workspaceId, modelsToSave);
    setSaving(false);
    if (success) {
      onSnackbar("AI models updated successfully!");
      fetchModels();
    } else {
      onSnackbar("Failed to save model settings");
    }
  };

  if (gatewayModelsLoading || enabledModelsLoading) {
    return (
      <Box sx={{ mb: 4 }}>
        <Typography
          variant="subtitle1"
          gutterBottom
          sx={{ fontWeight: 600, mb: 2 }}
        >
          AI Models
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">
            Loading models...
          </Typography>
        </Box>
      </Box>
    );
  }

  if (gatewayModelsError) {
    return (
      <Box sx={{ mb: 4 }}>
        <Typography
          variant="subtitle1"
          gutterBottom
          sx={{ fontWeight: 600, mb: 2 }}
        >
          AI Models
        </Typography>
        <Alert severity="info">
          Model management requires AI Gateway mode to be enabled.
        </Alert>
      </Box>
    );
  }

  if (gatewayModels.length === 0) return null;

  return (
    <Box sx={{ mb: 4 }}>
      <Typography
        variant="subtitle1"
        gutterBottom
        sx={{ fontWeight: 600, mb: 1 }}
      >
        AI Models
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Choose which AI models are available to workspace members. Only enabled
        models will appear in the chat model selector.
      </Typography>

      <TextField
        size="small"
        placeholder="Search models..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        fullWidth
        sx={{ mb: 1.5 }}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 18, color: "text.secondary" }} />
              </InputAdornment>
            ),
          },
        }}
      />

      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mb: 2 }}>
        <Chip
          label="All"
          size="small"
          variant={providerFilter === null ? "filled" : "outlined"}
          onClick={() => setProviderFilter(null)}
        />
        {providers.map(p => (
          <Chip
            key={p}
            label={providerLabel(p)}
            size="small"
            variant={providerFilter === p ? "filled" : "outlined"}
            onClick={() => setProviderFilter(providerFilter === p ? null : p)}
          />
        ))}
      </Box>

      <Box
        sx={{
          maxHeight: 420,
          overflow: "auto",
          border: 1,
          borderColor: "divider",
          borderRadius: 1,
        }}
      >
        {Array.from(groupedByProvider.entries()).map(
          ([provider, providerModels]) => {
            const enabledCount = providerModels.filter(m =>
              localEnabled.has(m.id),
            ).length;
            const allEnabled = enabledCount === providerModels.length;
            const someEnabled = enabledCount > 0 && !allEnabled;
            const isCollapsed = collapsedProviders.has(provider);

            return (
              <Box key={provider}>
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    px: 1.5,
                    py: 0.5,
                    bgcolor: "action.hover",
                    borderBottom: 1,
                    borderColor: "divider",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleProviderCollapse(provider)}
                >
                  <Checkbox
                    size="small"
                    checked={allEnabled}
                    indeterminate={someEnabled}
                    onClick={e => {
                      e.stopPropagation();
                      toggleProvider(provider, providerModels);
                    }}
                    sx={{ p: 0.5, mr: 1 }}
                  />
                  <Typography
                    variant="caption"
                    sx={{
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      flex: 1,
                    }}
                  >
                    {providerLabel(provider)}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ mr: 0.5 }}
                  >
                    {enabledCount}/{providerModels.length}
                  </Typography>
                  <IconButton size="small" sx={{ p: 0.25 }}>
                    {isCollapsed ? (
                      <ExpandMoreIcon sx={{ fontSize: 18 }} />
                    ) : (
                      <ExpandLessIcon sx={{ fontSize: 18 }} />
                    )}
                  </IconButton>
                </Box>
                <Collapse in={!isCollapsed}>
                  {providerModels.map(model => (
                    <Box
                      key={model.id}
                      sx={{
                        display: "flex",
                        alignItems: "flex-start",
                        px: 1.5,
                        py: 0.75,
                        borderBottom: 1,
                        borderColor: "divider",
                        "&:hover": { bgcolor: "action.hover" },
                        cursor: "pointer",
                      }}
                      onClick={() => toggleModel(model.id)}
                    >
                      <Checkbox
                        size="small"
                        checked={localEnabled.has(model.id)}
                        sx={{ p: 0.5, mr: 1, mt: -0.25 }}
                        onClick={e => e.stopPropagation()}
                        onChange={() => toggleModel(model.id)}
                      />
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography variant="body2" noWrap>
                          {model.name}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          noWrap
                          sx={{ display: "block" }}
                        >
                          {model.id}
                          {model.contextWindow
                            ? ` · ${Math.round(model.contextWindow / 1000)}K context`
                            : ""}
                        </Typography>
                      </Box>
                    </Box>
                  ))}
                </Collapse>
              </Box>
            );
          },
        )}
      </Box>

      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          mt: 1.5,
        }}
      >
        <Typography variant="caption" color="text.secondary">
          {localEnabled.size} of {gatewayModels.length} models enabled
        </Typography>
        <Button
          variant="contained"
          size="small"
          startIcon={saving ? <CircularProgress size={14} /> : <SaveIcon />}
          onClick={handleSave}
          disabled={!hasChanges || saving || localEnabled.size === 0}
          disableElevation
        >
          Save Model Settings
        </Button>
      </Box>
    </Box>
  );
}

export default Settings;
