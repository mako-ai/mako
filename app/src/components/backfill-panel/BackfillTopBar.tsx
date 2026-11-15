import { useState } from "react";
import { Box, Typography, IconButton, Tooltip } from "@mui/material";
import {
  RestartAlt as ResyncIcon,
  ContentCopy as CopyIcon,
  Edit as EditIcon,
} from "@mui/icons-material";
import { useFlowStore } from "../../store/flowStore";
import { EntityHistoryButton } from "../EntityHistoryButton";
import { PanelTopBar, TopBarButton } from "./backfill-styles";
import type { BackfillPanelModel } from "./useBackfillPanel";

export function BackfillTopBar({ model }: { model: BackfillPanelModel }) {
  const {
    workspaceId,
    flowId,
    onEdit,
    setResyncOpen,
    webhookUrl,
    connectorName,
    destName,
    dataset,
  } = model;
  const [webhookCopied, setWebhookCopied] = useState(false);
  const copyWebhook = async () => {
    if (!webhookUrl) return;
    await navigator.clipboard.writeText(webhookUrl);
    setWebhookCopied(true);
    setTimeout(() => setWebhookCopied(false), 1500);
  };
  return (
    <PanelTopBar>
      {connectorName && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {connectorName}
        </Typography>
      )}
      {connectorName && destName && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          →
        </Typography>
      )}
      {destName && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {destName}
          {dataset ? ` / ${dataset}` : ""}
        </Typography>
      )}
      {webhookUrl && (
        <Tooltip title={webhookCopied ? "Copied!" : webhookUrl}>
          <IconButton size="small" onClick={copyWebhook} sx={{ ml: 0.5 }}>
            <CopyIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}
      <Box sx={{ flex: 1 }} />
      <TopBarButton
        size="small"
        color="error"
        startIcon={<ResyncIcon sx={{ fontSize: 16 }} />}
        onClick={() => setResyncOpen(true)}
      >
        Reset
      </TopBarButton>
      <EntityHistoryButton
        entity="flow"
        id={flowId}
        onRestored={() => void useFlowStore.getState().refresh(workspaceId)}
      />
      {onEdit && (
        <TopBarButton
          size="small"
          startIcon={<EditIcon sx={{ fontSize: 16 }} />}
          onClick={onEdit}
        >
          Edit
        </TopBarButton>
      )}
    </PanelTopBar>
  );
}
