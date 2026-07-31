import React, { useEffect, useMemo } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { ClipboardList, X } from "lucide-react";
import type { SubmitPlanInput, SubmitPlanOutput } from "@mako/agent-tools";
import {
  closePlanTab,
  DECISION_COLOR,
  DECISION_LABEL,
  focusPlanTab,
  normalizeSubmitPlanInput,
  normalizeSubmitPlanOutput,
  usePlanStore,
} from "../store/planStore";

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
        border: 1,
        borderColor: pending || isStreaming ? "primary.main" : "divider",
        borderRadius: 2,
        p: 1.5,
        my: 0.5,
        bgcolor: "background.paper",
        cursor: "pointer",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center">
        {isStreaming ? (
          <CircularProgress size={15} thickness={5} />
        ) : (
          <ClipboardList size={15} />
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="subtitle2"
            fontWeight={600}
            noWrap
            sx={
              isStreaming && !title.trim()
                ? {
                    animation: "planCardPulse 1.4s ease-in-out infinite",
                    "@keyframes planCardPulse": {
                      "0%, 100%": { opacity: 1 },
                      "50%": { opacity: 0.45 },
                    },
                  }
                : undefined
            }
          >
            {isStreaming && !title.trim() ? "Writing plan…" : title}
          </Typography>
          <Typography variant="caption" color="text.secondary">
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
            <Chip
              size="small"
              label={requiredCapabilities.join(" · ")}
              variant="outlined"
            />
          </Tooltip>
        )}
        {decision && (
          <Chip
            size="small"
            label={DECISION_LABEL[decision]}
            color={DECISION_COLOR[decision]}
            variant="outlined"
          />
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
              onClick={e => {
                e.stopPropagation();
                resolvePlan(toolCallId, "approve");
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
