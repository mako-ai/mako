/**
 * ModelSelector Component
 * A dropdown component for selecting AI models, similar to Cursor's model picker
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
  Menu,
  MenuItem,
  ListSubheader,
  Typography,
  CircularProgress,
  Tooltip,
} from "@mui/material";
import { KeyboardArrowDown, ArrowForward } from "@mui/icons-material";
import { useSettingsStore } from "../store/settingsStore";
import { useBillingStore } from "../store/billingStore";
import { useLocalAgentStore } from "../store/localAgentStore";
import { useAcpStore } from "../store/acpStore";
import { useWorkspace } from "../contexts/workspace-context";

import type { AIModel } from "../lib/api-types";
import {
  isLocalAcpModelId,
  localAcpModelIdToProviderId,
  localAcpModelPreference,
  localAcpModelsFromProviders,
} from "../lib/local-acp-models";
import { getModelBillingState } from "./model-selector-utils";

// Provider display names for grouping
const PROVIDER_NAMES: Record<string, string> = {
  local: "On this machine",
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
  "local",
  "openai",
  "anthropic",
  "google",
  "meta",
  "deepseek",
  "mistral",
  "xai",
  "cohere",
];

async function probeLocalAcpProviders(): Promise<void> {
  const agentStatus = await useLocalAgentStore.getState().checkAgent();
  if (agentStatus !== "online") return;
  await useAcpStore.getState().refreshStatus();
}

export const ModelSelector: React.FC = () => {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const selectedModelId = useSettingsStore(s => s.selectedModelId);
  const setSelectedModelId = useSettingsStore(s => s.setSelectedModelId);
  const models = useSettingsStore(s => s.models);
  const loading = useSettingsStore(s => s.modelsLoading);
  const error = useSettingsStore(s => s.modelsError);
  const fetchModels = useSettingsStore(s => s.fetchModels);
  const acpStatus = useAcpStore(s => s.status);

  const billingWorkspaceId = useBillingStore(s => s.workspaceId);
  const billingStatus = useBillingStore(s => s.status);
  const fetchBillingStatus = useBillingStore(s => s.fetchBillingStatus);
  const createCheckoutSession = useBillingStore(s => s.createCheckoutSession);
  const { currentWorkspace } = useWorkspace();

  const open = Boolean(anchorEl);

  useEffect(() => {
    void fetchModels();
    void probeLocalAcpProviders();
  }, [fetchModels]);

  useEffect(() => {
    if (!currentWorkspace?.id) return;
    if (billingWorkspaceId === currentWorkspace.id && billingStatus) return;
    void fetchBillingStatus(currentWorkspace.id);
  }, [
    billingStatus,
    billingWorkspaceId,
    currentWorkspace?.id,
    fetchBillingStatus,
  ]);

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
    // Refresh ACP availability when opening the menu
    void probeLocalAcpProviders();
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleSelectModel = (modelId: string) => {
    setSelectedModelId(modelId);
    handleClose();
    // If a Claude/Codex ACP session is already live, switch its model now so
    // the next Chat turn doesn't keep running Sonnet after picking Fable.
    if (!isLocalAcpModelId(modelId)) return;
    const providerId = localAcpModelIdToProviderId(modelId);
    const preference = localAcpModelPreference(modelId);
    if (!providerId || !preference) return;
    const store = useAcpStore.getState();
    const session =
      store.sessions.find(
        s =>
          s.id === store.activeSessionId &&
          s.providerId === providerId &&
          s.makoMcpAttached,
      ) ||
      store.sessions.find(
        s => s.providerId === providerId && s.makoMcpAttached,
      );
    if (!session) return;
    void store.setSessionModel(session.id, preference);
  };

  const localModels = useMemo(
    () => localAcpModelsFromProviders(acpStatus?.providers),
    [acpStatus?.providers],
  );

  const allModels = useMemo(
    () => [...localModels, ...models],
    [localModels, models],
  );

  // Get the currently selected model info
  const selectedModel = allModels.find(m => m.id === selectedModelId);
  const displayName =
    selectedModel?.name ||
    (isLocalAcpModelId(selectedModelId) ? "Local agent" : selectedModelId) ||
    "Select Model";

  // Group models by provider, ordered by priority
  const modelGroups = (() => {
    const byProvider: Record<string, AIModel[]> = {};
    for (const m of allModels) {
      if (!byProvider[m.provider]) {
        byProvider[m.provider] = [];
      }
      byProvider[m.provider].push(m);
    }

    const priorityIdx = new Map(PROVIDER_PRIORITY.map((p, i) => [p, i]));
    const sortedProviders = Object.keys(byProvider).sort((a, b) => {
      const ai = priorityIdx.get(a) ?? Infinity;
      const bi = priorityIdx.get(b) ?? Infinity;
      if (ai !== bi) {
        return ai - bi;
      }
      return a.localeCompare(b);
    });

    return sortedProviders.map(provider => ({
      label: PROVIDER_NAMES[provider] || provider,
      key: provider,
      models: byProvider[provider],
    }));
  })();

  if (loading && allModels.length === 0) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        <CircularProgress size={14} />
        <Typography variant="caption" color="text.secondary">
          Loading...
        </Typography>
      </Box>
    );
  }

  if (error && allModels.length === 0) {
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
              maxWidth: 350,
              maxHeight: 400,
            },
          },
        }}
      >
        {modelGroups.map(group => [
          <ListSubheader
            key={`header-${group.key}`}
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
            {group.label}
          </ListSubheader>,
          ...group.models.map(model => {
            const { isFreeModel, isProModel, billingEnabled, isRestricted } =
              getModelBillingState(model, billingStatus);

            const handleModelClick = async () => {
              if (isRestricted) {
                handleClose();
                if (!currentWorkspace?.id) return;
                const url = await createCheckoutSession(currentWorkspace.id);
                if (url) window.location.href = url;
                return;
              }
              handleSelectModel(model.id);
            };

            return (
              <MenuItem
                key={model.id}
                selected={!isRestricted && model.id === selectedModelId}
                onClick={handleModelClick}
                sx={{ py: 1, px: 2 }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    minWidth: 0,
                    width: "100%",
                  }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      variant="body2"
                      noWrap
                      sx={{
                        color: isRestricted ? "text.secondary" : undefined,
                      }}
                    >
                      {model.name}
                    </Typography>
                    {isRestricted ? (
                      <Typography
                        variant="caption"
                        noWrap
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          gap: 0.25,
                          color: "primary.main",
                          fontWeight: 500,
                        }}
                      >
                        Upgrade to unlock
                        <ArrowForward sx={{ fontSize: 11 }} />
                      </Typography>
                    ) : (
                      model.description && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: "block" }}
                          noWrap
                        >
                          {model.description}
                        </Typography>
                      )
                    )}
                  </Box>
                  {model.provider === "local" && (
                    <Chip
                      label="Subscription"
                      size="small"
                      color="info"
                      variant="outlined"
                      sx={{ height: 18, fontSize: 10 }}
                    />
                  )}
                  {isFreeModel &&
                    billingEnabled &&
                    model.provider !== "local" && (
                      <Chip
                        label="Free"
                        size="small"
                        color="success"
                        variant="outlined"
                        sx={{ height: 18, fontSize: 10 }}
                      />
                    )}
                  {isProModel && billingEnabled && (
                    <Chip
                      label="Pro"
                      size="small"
                      color="primary"
                      variant={isRestricted ? "filled" : "outlined"}
                      sx={{ height: 18, fontSize: 10 }}
                    />
                  )}
                </Box>
              </MenuItem>
            );
          }),
        ])}
      </Menu>
    </>
  );
};

export default ModelSelector;
