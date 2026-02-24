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
import { Lock } from "lucide-react";
import { useSettingsStore } from "../store/settingsStore";
import { UpgradePrompt } from "./UpgradePrompt";

import type { AIModel } from "../lib/api-types";

// Provider display names for grouping
const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

// Provider order for display
const PROVIDER_ORDER: Array<AIModel["provider"]> = [
  "openai",
  "anthropic",
  "google",
];

export const ModelSelector: React.FC = () => {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
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

  const handleSelectModel = (model: AIModel) => {
    if (model.locked) {
      handleClose();
      setUpgradeOpen(true);
      return;
    }
    setSelectedModelId(model.id);
    handleClose();
  };

  // Get the currently selected model info
  const selectedModel = models.find(m => m.id === selectedModelId);
  const displayName = selectedModel?.name || selectedModelId || "Select Model";

  // Group models by provider
  const modelsByProvider = PROVIDER_ORDER.reduce(
    (acc, provider) => {
      const providerModels = models.filter(m => m.provider === provider);
      if (providerModels.length > 0) {
        acc[provider] = providerModels;
      }
      return acc;
    },
    {} as Record<string, AIModel[]>,
  );

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
          minWidth: "auto",
          "&:hover": {
            backgroundColor: "action.hover",
          },
        }}
      >
        {displayName}
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
              onClick={() => handleSelectModel(model)}
              sx={{
                py: 1,
                px: 2,
                opacity: model.locked ? 0.7 : 1,
              }}
            >
              <Box
                sx={{ display: "flex", alignItems: "center", gap: 1, flex: 1 }}
              >
                <Box sx={{ flex: 1 }}>
                  <Typography variant="body2">{model.name}</Typography>
                  {model.description && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: "block" }}
                    >
                      {model.description}
                    </Typography>
                  )}
                </Box>
                {model.locked && (
                  <Tooltip title="Requires Pro plan">
                    <Box sx={{ display: "flex", color: "text.disabled" }}>
                      <Lock size={14} />
                    </Box>
                  </Tooltip>
                )}
              </Box>
            </MenuItem>
          )),
        ])}
      </Menu>
      <UpgradePrompt open={upgradeOpen} onClose={() => setUpgradeOpen(false)} />
    </>
  );
};

export default ModelSelector;
