/**
 * ModelSelector Component
 * A dropdown component for selecting AI models, similar to Cursor's model picker
 */

import React, { useEffect, useState } from "react";
import {
  Box,
  Button,
  Menu,
  MenuItem,
  ListSubheader,
  Typography,
  CircularProgress,
  Tooltip,
} from "@mui/material";
import { KeyboardArrowDown } from "@mui/icons-material";
import { useSettingsStore } from "../store/settingsStore";

import type { AIModel } from "../lib/api-types";

// Provider display names for grouping
const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  meta: "Meta",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  xai: "xAI",
  cohere: "Cohere",
  amazon: "Amazon",
  alibaba: "Alibaba",
  nvidia: "NVIDIA",
  perplexity: "Perplexity",
};

// Preferred provider order; unlisted providers appear at the end alphabetically
const PROVIDER_PRIORITY: string[] = [
  "openai",
  "anthropic",
  "google",
  "meta",
  "deepseek",
  "mistral",
  "xai",
  "cohere",
];

export const ModelSelector: React.FC = () => {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const selectedModelId = useSettingsStore(s => s.selectedModelId);
  const setSelectedModelId = useSettingsStore(s => s.setSelectedModelId);
  const models = useSettingsStore(s => s.models);
  const loading = useSettingsStore(s => s.modelsLoading);
  const error = useSettingsStore(s => s.modelsError);
  const fetchModels = useSettingsStore(s => s.fetchModels);

  const open = Boolean(anchorEl);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleSelectModel = (modelId: string) => {
    setSelectedModelId(modelId);
    handleClose();
  };

  // Get the currently selected model info
  const selectedModel = models.find(m => m.id === selectedModelId);
  const displayName = selectedModel?.name || selectedModelId || "Select Model";

  // Group models by provider, ordered by priority then alphabetically
  const modelsByProvider = (() => {
    const groups: Record<string, AIModel[]> = {};
    for (const m of models) {
      if (!groups[m.provider]) groups[m.provider] = [];
      groups[m.provider].push(m);
    }
    const priorityIdx = new Map(PROVIDER_PRIORITY.map((p, i) => [p, i]));
    const sortedEntries = Object.entries(groups).sort(([a], [b]) => {
      const ai = priorityIdx.get(a) ?? Infinity;
      const bi = priorityIdx.get(b) ?? Infinity;
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    });
    return Object.fromEntries(sortedEntries) as Record<string, AIModel[]>;
  })();

  if (loading) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        <CircularProgress size={14} />
        <Typography variant="caption" color="text.secondary">
          Loading...
        </Typography>
      </Box>
    );
  }

  if (error || models.length === 0) {
    return (
      <Tooltip title={error || "No models available"}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ cursor: "default" }}
        >
          No models
        </Typography>
      </Tooltip>
    );
  }

  return (
    <>
      <Button
        size="small"
        onClick={handleClick}
        endIcon={<KeyboardArrowDown sx={{ fontSize: 16 }} />}
        sx={{
          textTransform: "none",
          color: "text.secondary",
          fontSize: 12,
          py: 0.25,
          px: 1,
          minWidth: 0,
          maxWidth: "100%",
          minHeight: 28,
          flexShrink: 1,
          justifyContent: "space-between",
          "&:hover": {
            backgroundColor: "action.hover",
          },
        }}
      >
        <Box
          component="span"
          className="app-truncate-inline"
          sx={{ flex: "1 1 auto", minWidth: 0 }}
        >
          {displayName}
        </Box>
      </Button>
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorOrigin={{
          vertical: "top",
          horizontal: "left",
        }}
        transformOrigin={{
          vertical: "bottom",
          horizontal: "left",
        }}
        slotProps={{
          paper: {
            sx: {
              minWidth: 220,
              maxHeight: 400,
            },
          },
        }}
      >
        {Object.entries(modelsByProvider).map(([provider, providerModels]) => [
          <ListSubheader
            key={`header-${provider}`}
            sx={{
              backgroundColor: "background.paper",
              lineHeight: 2.5,
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "text.secondary",
            }}
          >
            {PROVIDER_NAMES[provider] || provider}
          </ListSubheader>,
          ...providerModels.map(model => (
            <MenuItem
              key={model.id}
              selected={model.id === selectedModelId}
              onClick={() => handleSelectModel(model.id)}
              sx={{
                py: 1,
                px: 2,
              }}
            >
              <Box sx={{ minWidth: 0, width: "100%" }}>
                <Typography variant="body2" noWrap>
                  {model.name}
                </Typography>
                {model.description && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: "block" }}
                    noWrap
                  >
                    {model.description}
                  </Typography>
                )}
              </Box>
            </MenuItem>
          )),
        ])}
      </Menu>
    </>
  );
};

export default ModelSelector;
