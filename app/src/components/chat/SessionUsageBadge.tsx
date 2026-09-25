/**
 * Cumulative token + cost for the whole chat session, shown in the composer
 * control row next to the model picker.
 *
 * Replaces the old per-response cost tag, which reported only the last segment
 * of a multi-segment turn and so badly understated real spend.
 *
 * Perf contract (`.cursor/rules/75-chat-performance.mdc`): every selector below
 * returns a primitive, and the store is written exactly once per chat load and
 * once per finished turn — never per streamed chunk — so this subtree does not
 * participate in streaming re-renders.
 */

import React from "react";
import { Box, Tooltip } from "@mui/material";
import { useChatUsageStore } from "../../store/chatUsageStore";
import { formatCostUsd, formatTokenCount } from "./response-cost";
import { BUI_MONO_FONT_FAMILY } from "./bui-styles";

interface SessionUsageBadgeProps {
  chatId: string;
  /** True when the selected model runs locally and is therefore unmetered. */
  isLocalAgent?: boolean;
}

const rowSx = { display: "flex", justifyContent: "space-between", gap: 2 };

export const SessionUsageBadge = React.memo(function SessionUsageBadge({
  chatId,
  isLocalAgent = false,
}: SessionUsageBadgeProps) {
  // Primitive selectors only — never return the usage object itself.
  const inputTokens = useChatUsageStore(
    s => s.byChatId[chatId]?.inputTokens ?? 0,
  );
  const outputTokens = useChatUsageStore(
    s => s.byChatId[chatId]?.outputTokens ?? 0,
  );
  const cacheReadTokens = useChatUsageStore(
    s => s.byChatId[chatId]?.cacheReadTokens ?? 0,
  );
  const cacheWriteTokens = useChatUsageStore(
    s => s.byChatId[chatId]?.cacheWriteTokens ?? 0,
  );
  const reasoningTokens = useChatUsageStore(
    s => s.byChatId[chatId]?.reasoningTokens ?? 0,
  );
  const costUsd = useChatUsageStore(s => s.byChatId[chatId]?.costUsd ?? 0);
  const hasCost = useChatUsageStore(s => s.byChatId[chatId]?.hasCost ?? false);

  // Cache reads are part of the prompt and reasoning is part of the
  // completion, so the volume figure is input + output and nothing else.
  const total = inputTokens + outputTokens;

  // A fresh chat, or one whose turns were never metered, shows nothing rather
  // than a meaningless "0 · $0.00".
  if (total === 0) return null;

  const tooltip = (
    <Box sx={{ py: 0.25, minWidth: 180 }}>
      <Box sx={{ fontWeight: 600, mb: 0.5 }}>Session total</Box>
      <Box sx={rowSx}>
        <span>Input</span>
        <span>{formatTokenCount(inputTokens)}</span>
      </Box>
      <Box sx={rowSx}>
        <span>Output</span>
        <span>{formatTokenCount(outputTokens)}</span>
      </Box>
      {cacheReadTokens > 0 && (
        <Box sx={rowSx}>
          <span>Cached read</span>
          <span>{formatTokenCount(cacheReadTokens)}</span>
        </Box>
      )}
      {cacheWriteTokens > 0 && (
        <Box sx={rowSx}>
          <span>Cached write</span>
          <span>{formatTokenCount(cacheWriteTokens)}</span>
        </Box>
      )}
      {(cacheReadTokens > 0 || cacheWriteTokens > 0) && (
        <Box sx={{ opacity: 0.7, mt: 0.25 }}>
          Cached tokens are part of input
        </Box>
      )}
      {reasoningTokens > 0 && (
        <>
          <Box sx={rowSx}>
            <span>Reasoning</span>
            <span>{formatTokenCount(reasoningTokens)}</span>
          </Box>
          <Box sx={{ opacity: 0.7, mt: 0.25 }}>
            Reasoning tokens are part of output
          </Box>
        </>
      )}
      {hasCost && (
        <Box sx={{ opacity: 0.7, mt: 0.5 }}>
          {formatCostUsd(costUsd)} estimated at list price
        </Box>
      )}
      {isLocalAgent && (
        <Box sx={{ opacity: 0.7, mt: 0.5 }}>
          Local agent turns are not metered
        </Box>
      )}
    </Box>
  );

  return (
    <Tooltip title={tooltip} placement="top">
      <Box
        component="span"
        aria-label="Session usage"
        sx={{
          fontFamily: BUI_MONO_FONT_FAMILY,
          fontSize: "11px",
          lineHeight: 1,
          color: "var(--bui-ink-3)",
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
          cursor: "default",
          userSelect: "none",
          transition: "color 120ms ease-out",
          "&:hover": { color: "var(--bui-ink-2)" },
        }}
      >
        {formatTokenCount(total)}
        {hasCost ? ` · ${formatCostUsd(costUsd)}` : ""}
      </Box>
    </Tooltip>
  );
});
