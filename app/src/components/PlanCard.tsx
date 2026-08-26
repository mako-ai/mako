import React, { useEffect, useMemo } from "react";
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { ClipboardList, X } from "lucide-react";
import type { SubmitPlanInput, SubmitPlanOutput } from "@mako/agent-tools";
import { BUI_META_CHIP_SX } from "./bui-status";
import {
  closePlanTab,
  DECISION_COLOR,
  DECISION_LABEL,
  focusPlanTab,
  normalizeSubmitPlanInput,
  normalizeSubmitPlanOutput,
  usePlanStore,
} from "../store/planStore";

/** BUI tint pill colors for each plan decision (chip replacement). */
const DECISION_PILL_SX: Record<
  (typeof DECISION_COLOR)[keyof typeof DECISION_COLOR],
  { backgroundColor: string; color: string }
> = {
  success: {
    backgroundColor: "var(--bui-green-tint)",
    color: "var(--bui-green)",
  },
  warning: {
    backgroundColor: "var(--bui-orange-tint)",
    color: "var(--bui-orange)",
  },
  default: {
    backgroundColor: "var(--bui-field)",
    color: "var(--bui-ink-2)",
  },
};

interface PlanCardProps {
  toolCallId: string;
  /** Chat owning the tool call; falls back to the registered plan entry when
   * omitted (inline summaries in message history). */
  chatId?: string;
  /** True while the model is still streaming the plan input. The card renders
   * the "Writing plan…" progress variant and reads live data from planStore
   * (which Chat.tsx feeds on every streamed delta). */
  streaming?: boolean;
  input?: SubmitPlanInput;
  /** Present once the plan has been resolved (read-only summary view). */
  output?: SubmitPlanOutput;
}

/**
 * Compact summary card for the deferred `submit_plan` tool (Cursor-style).
 * All review/editing happens in the main-view plan tab; clicking the card
 * opens or focuses that tab. While pending, a quick "Approve & run" button
 * resolves the plan directly — iteration happens by replying in chat.
 */
export const PlanCard: React.FC<PlanCardProps> = ({
  toolCallId,
  chatId,
  streaming = false,
  input,
  output,
}) => {
  const plan = usePlanStore(s => s.plans[toolCallId]);
  const resolvePlan = usePlanStore(s => s.resolvePlan);

  // Hydrate the store from message history (idempotent; registerPlan never
  // clobbers an existing draft and markResolved skips already-resolved plans).
  // Skipped while streaming: a partial input must not finalize the draft —
  // Chat.tsx feeds streaming deltas via setStreamingInput instead.
  useEffect(() => {
    if (!toolCallId || streaming) return;
    const store = usePlanStore.getState();
    if (input) {
      store.registerPlan(
        toolCallId,
        chatId ?? store.plans[toolCallId]?.chatId ?? "",
        input,
      );
    }
    if (output) store.markResolved(toolCallId, output);
  }, [toolCallId, chatId, streaming, input, output]);

  // Props can carry unvalidated ACP payloads (raw agent MCP arguments where
  // any field may be missing or mistyped) — normalize once, read declaratively.
  const safeInput = useMemo(
    () => (input ? normalizeSubmitPlanInput(input) : undefined),
    [input],
  );
  const safeOutput = useMemo(
    () => (output ? normalizeSubmitPlanOutput(output) : undefined),
    [output],
  );

  const isStreaming = streaming || plan?.status === "streaming";
  const title =
    plan?.draft.title ??
    safeOutput?.editedPlan?.title ??
    safeInput?.title ??
    "Plan";
  const stepCount =
    plan?.draft.todos.length ??
    safeOutput?.editedPlan?.todos.length ??
    safeInput?.todos.length ??
    0;
  const decision =
    plan && plan.status !== "pending" && plan.status !== "streaming"
      ? plan.status
      : safeOutput?.decision;
  const pending = !decision && !isStreaming;
  const requiredCapabilities =
    plan?.input.requiredCapabilities ?? safeInput?.requiredCapabilities ?? [];

  const openTab = () => {
    if (!toolCallId) return;
    focusPlanTab(toolCallId, chatId ?? plan?.chatId ?? "", title);
  };

  // Discard (Cursor-style "not now"): resolves the deferred tool with a
  // cancel decision — the agent stops without executing — and closes the
  // plan tab. The summary card stays in the chat with a "Cancelled" chip.
  const discardPlan = () => {
    if (!toolCallId) return;
    if (resolvePlan(toolCallId, "cancel")) {
      closePlanTab(toolCallId, chatId ?? plan?.chatId ?? "");
    }
  };

  return (
    <Box
      onClick={openTab}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openTab();
        }
      }}
      sx={{
        borderRadius: "14px",
        p: 1.5,
        my: 0.5,
        backgroundColor: "var(--bui-surface)",
        boxShadow:
          pending || isStreaming
            ? "0 0 0 1px var(--bui-accent), 0 1px 2px oklch(0% 0 0 / 0.05), 0 2px 6px oklch(0% 0 0 / 0.04)"
            : "var(--bui-shadow-card)",
        cursor: "pointer",
        transition: "background-color 0.1s",
        "&:hover": { backgroundColor: "var(--bui-hover)" },
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center">
        {isStreaming ? (
          <CircularProgress size={15} thickness={5} />
        ) : (
          <ClipboardList size={15} style={{ color: "var(--bui-ink-2)" }} />
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="subtitle2"
            noWrap
            sx={{
              fontSize: 13,
              fontWeight: 500,
              color: "var(--bui-ink)",
              ...(isStreaming && !title.trim()
                ? {
                    animation: "planCardPulse 1.4s ease-in-out infinite",
                    "@keyframes planCardPulse": {
                      "0%, 100%": { opacity: 1 },
                      "50%": { opacity: 0.45 },
                    },
                  }
                : {}),
            }}
          >
            {isStreaming && !title.trim()
              ? "Writing plan…"
              : title.trim() || "Plan"}
          </Typography>
          <Typography variant="caption" sx={{ color: "var(--bui-ink-3)" }}>
            {isStreaming
              ? `Writing plan… · ${stepCount} step${stepCount === 1 ? "" : "s"}`
              : pending
                ? `${stepCount} step${stepCount === 1 ? "" : "s"} · reply in chat to iterate`
                : `Plan · ${stepCount} step${stepCount === 1 ? "" : "s"}`}
          </Typography>
        </Box>
        {requiredCapabilities.length > 0 && (
          <Tooltip
            title={`Approval grants this task: ${requiredCapabilities.join(", ")}`}
            placement="top"
          >
            <Box component="span" sx={BUI_META_CHIP_SX}>
              {requiredCapabilities.join(" · ")}
            </Box>
          </Tooltip>
        )}
        {decision && (
          <Box
            component="span"
            sx={{
              display: "inline-flex",
              alignItems: "center",
              px: 1,
              py: 0.25,
              borderRadius: "999px",
              fontSize: 11.5,
              fontWeight: 600,
              flexShrink: 0,
              ...DECISION_PILL_SX[DECISION_COLOR[decision]],
            }}
          >
            {DECISION_LABEL[decision]}
          </Box>
        )}
        {pending && (
          <>
            <Tooltip title="Discard plan" placement="top">
              <IconButton
                size="small"
                aria-label="Discard plan"
                onClick={e => {
                  e.stopPropagation();
                  discardPlan();
                }}
              >
                <X size={15} />
              </IconButton>
            </Tooltip>
            <Button
              size="small"
              variant="contained"
              disableElevation
              onClick={e => {
                e.stopPropagation();
                resolvePlan(toolCallId, "approve");
              }}
              sx={{
                textTransform: "none",
                fontSize: 12.5,
                fontWeight: 500,
                borderRadius: "8px",
                backgroundColor: "var(--bui-ink)",
                color: "var(--bui-surface)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14)",
                "&:hover": {
                  backgroundColor: "var(--bui-ink)",
                  opacity: 0.85,
                },
              }}
            >
              Approve &amp; run
            </Button>
          </>
        )}
      </Stack>
    </Box>
  );
};
