import React, { useEffect } from "react";
import { Box, Button, Chip, Stack, Typography } from "@mui/material";
import { ClipboardList } from "lucide-react";
import type { SubmitPlanInput, SubmitPlanOutput } from "@mako/agent-tools";
import {
  DECISION_COLOR,
  DECISION_LABEL,
  focusPlanTab,
  usePlanStore,
} from "../store/planStore";

interface PlanCardProps {
  toolCallId: string;
  /** Chat owning the tool call; falls back to the registered plan entry when
   * omitted (inline summaries in message history). */
  chatId?: string;
  input?: SubmitPlanInput;
  /** Present once the plan has been resolved (read-only summary view). */
  output?: SubmitPlanOutput;
}

/**
 * Compact summary card for the deferred `submit_plan` tool (Cursor-style).
 * All review/editing happens in the main-view plan tab; clicking the card
 * opens or focuses that tab. While pending, a quick "Approve & run" button
 * resolves the plan directly without opening the tab.
 */
export const PlanCard: React.FC<PlanCardProps> = ({
  toolCallId,
  chatId,
  input,
  output,
}) => {
  const plan = usePlanStore(s => s.plans[toolCallId]);
  const resolvePlan = usePlanStore(s => s.resolvePlan);

  // Hydrate the store from message history (idempotent; registerPlan never
  // clobbers an existing draft and markResolved skips already-resolved plans).
  useEffect(() => {
    if (!toolCallId) return;
    const store = usePlanStore.getState();
    if (input) {
      store.registerPlan(
        toolCallId,
        chatId ?? store.plans[toolCallId]?.chatId ?? "",
        input,
      );
    }
    if (output) store.markResolved(toolCallId, output);
  }, [toolCallId, chatId, input, output]);

  const title =
    plan?.draft.title ?? output?.editedPlan?.title ?? input?.title ?? "Plan";
  const stepCount =
    plan?.draft.todos.length ??
    output?.editedPlan?.todos.length ??
    input?.todos.length ??
    0;
  const decision =
    plan && plan.status !== "pending" ? plan.status : output?.decision;
  const pending = !decision;

  const openTab = () => {
    if (!toolCallId) return;
    focusPlanTab(toolCallId, chatId ?? plan?.chatId ?? "", title);
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
        borderColor: pending ? "primary.main" : "divider",
        borderRadius: 2,
        p: 1.5,
        my: 0.5,
        bgcolor: "background.paper",
        cursor: "pointer",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center">
        <ClipboardList size={15} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" fontWeight={600} noWrap>
            {title}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Plan · {stepCount} step{stepCount === 1 ? "" : "s"}
          </Typography>
        </Box>
        {decision ? (
          <Chip
            size="small"
            label={DECISION_LABEL[decision]}
            color={DECISION_COLOR[decision]}
            variant="outlined"
          />
        ) : (
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
        )}
      </Stack>
    </Box>
  );
};
