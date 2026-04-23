import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Collapse,
  IconButton,
  InputAdornment,
  Snackbar,
  TextField,
  Typography,
} from "@mui/material";
import {
  Save as SaveIcon,
  Search as SearchIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
} from "@mui/icons-material";
import SettingsLayout from "./SettingsLayout";
import { useSettingsStore } from "../../store/settingsStore";
import { useWorkspace } from "../../contexts/workspace-context";
import type { GatewayModelInfo } from "../../lib/api-types";

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

export default function SettingsModels() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

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
  const [snackbar, setSnackbar] = useState<string | null>(null);
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    fetchGatewayModels();
  }, [fetchGatewayModels]);

  useEffect(() => {
    if (workspaceId) fetchEnabledModels(workspaceId);
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
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleProvider = useCallback(
    (_provider: string, models: GatewayModelInfo[]) => {
      setLocalEnabled(prev => {
        const next = new Set(prev);
        const allEnabled = models.every(m => next.has(m.id));
        if (allEnabled) models.forEach(m => next.delete(m.id));
        else models.forEach(m => next.add(m.id));
        return next;
      });
    },
    [],
  );

  const toggleProviderCollapse = useCallback((provider: string) => {
    setCollapsedProviders(prev => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
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
      setSnackbar("At least one model must be enabled");
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
    const ok = await saveEnabledModels(workspaceId, modelsToSave);
    setSaving(false);
    if (ok) {
      setSnackbar("AI models updated successfully!");
      fetchModels();
    } else {
      setSnackbar("Failed to save model settings");
    }
  };

  const renderBody = () => {
    if (gatewayModelsLoading || enabledModelsLoading) {
      return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">
            Loading models...
          </Typography>
        </Box>
      );
    }
    if (gatewayModelsError) {
      return (
        <Alert severity="info">
          Model management requires AI Gateway mode to be enabled.
        </Alert>
      );
    }
    if (gatewayModels.length === 0) {
      return (
        <Alert severity="info">No AI models are currently available.</Alert>
      );
    }
    return (
      <>
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
            maxHeight: 500,
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
      </>
    );
  };

  return (
    <SettingsLayout
      title="AI Models"
      description="Choose which AI models are available to workspace members. Only enabled models will appear in the chat model selector."
    >
      {renderBody()}
      <Snackbar
        open={snackbar !== null}
        autoHideDuration={4000}
        onClose={() => setSnackbar(null)}
      >
        <Alert
          onClose={() => setSnackbar(null)}
          severity={snackbar?.startsWith("Failed") ? "error" : "success"}
        >
          {snackbar}
        </Alert>
      </Snackbar>
    </SettingsLayout>
  );
}
