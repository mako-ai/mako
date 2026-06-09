import React, { useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
  Divider,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { ClipboardList } from "lucide-react";
import type {
  PlanDecision,
  PlanTodo,
  SubmitPlanInput,
  SubmitPlanOutput,
} from "@mako/agent-tools";

interface PlanCardProps {
  input?: SubmitPlanInput;
  /** Present once the plan has been resolved (read-only summary view). */
  output?: SubmitPlanOutput;
  /** Required for the pending (interactive) card; unused for summaries. */
  onResolve?: (output: SubmitPlanOutput) => void;
}

const DECISION_LABEL: Record<PlanDecision, string> = {
  approve: "Approved",
  request_changes: "Changes requested",
  cancel: "Cancelled",
};

const DECISION_COLOR: Record<PlanDecision, "success" | "warning" | "default"> =
  {
    approve: "success",
    request_changes: "warning",
    cancel: "default",
  };

/**
 * Editable plan card for the deferred `submit_plan` tool. The user can edit the
 * plan, then Approve (unlocks mutations on the next turn), Request changes
 * (returns feedback), or Cancel. Resolves the tool call via `onResolve`.
 */
export const PlanCard: React.FC<PlanCardProps> = ({
  input,
  output,
  onResolve,
}) => {
  const resolved = Boolean(output);
  const [title, setTitle] = useState(input?.title ?? "");
  const [planMarkdown, setPlanMarkdown] = useState(input?.planMarkdown ?? "");
  const [todos, setTodos] = useState<PlanTodo[]>(() => input?.todos ?? []);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");

  const editedPlan = useMemo(
    () => ({ title, planMarkdown, todos }),
    [title, planMarkdown, todos],
  );

  const decide = (decision: PlanDecision) => {
    if (resolved) return;
    if (decision === "request_changes" && !showFeedback) {
      setShowFeedback(true);
      return;
    }
    onResolve?.({
      success: true,
      decision,
      ...(decision === "request_changes" ? { feedback } : {}),
      ...(decision !== "cancel" ? { editedPlan } : {}),
    });
  };

  const updateTodo = (index: number, content: string) =>
    setTodos(prev => prev.map((t, i) => (i === index ? { ...t, content } : t)));

  const displayTodos = resolved ? (output?.editedPlan?.todos ?? todos) : todos;

  return (
    <Box
      sx={{
        border: 1,
        borderColor: resolved ? "divider" : "primary.main",
        borderRadius: 2,
        p: 1.5,
        my: 0.5,
        bgcolor: "background.paper",
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" mb={1}>
        <ClipboardList size={15} />
        <Typography variant="subtitle2" fontWeight={600}>
          Plan
        </Typography>
        {resolved && output && (
          <Chip
            size="small"
            label={DECISION_LABEL[output.decision]}
            color={DECISION_COLOR[output.decision]}
            variant="outlined"
          />
        )}
      </Stack>

      {resolved ? (
        <>
          <Typography variant="body2" fontWeight={600} mb={0.5}>
            {output?.editedPlan?.title ?? title}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ whiteSpace: "pre-wrap" }}
          >
            {output?.editedPlan?.planMarkdown ?? planMarkdown}
          </Typography>
          {output?.feedback && (
            <Typography variant="body2" color="warning.main" mt={1}>
              Feedback: {output.feedback}
            </Typography>
          )}
        </>
      ) : (
        <Stack spacing={1.25}>
          <TextField
            size="small"
            fullWidth
            label="Title"
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
          <TextField
            size="small"
            fullWidth
            multiline
            minRows={3}
            maxRows={14}
            label="Plan"
            value={planMarkdown}
            onChange={e => setPlanMarkdown(e.target.value)}
          />
        </Stack>
      )}

      {displayTodos.length > 0 && (
        <>
          <Divider sx={{ my: 1 }} />
          <Typography variant="caption" color="text.secondary">
            Steps
          </Typography>
          <Stack spacing={0.5} mt={0.5}>
            {displayTodos.map((todo, index) =>
              resolved ? (
                <Typography
                  key={todo.id ?? index}
                  variant="body2"
                  color="text.secondary"
                >
                  {index + 1}. {todo.content}
                </Typography>
              ) : (
                <Stack
                  key={todo.id ?? index}
                  direction="row"
                  spacing={1}
                  alignItems="center"
                >
                  <Typography variant="body2" color="text.secondary">
                    {index + 1}.
                  </Typography>
                  <TextField
                    size="small"
                    fullWidth
                    value={todo.content}
                    onChange={e => updateTodo(index, e.target.value)}
                  />
                </Stack>
              ),
            )}
          </Stack>
        </>
      )}

      {!resolved && (
        <>
          {showFeedback && (
            <TextField
              size="small"
              fullWidth
              multiline
              minRows={2}
              maxRows={6}
              placeholder="What should change?"
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              sx={{ mt: 1.5 }}
            />
          )}
          <Stack direction="row" spacing={1} mt={1.5} justifyContent="flex-end">
            <Button
              size="small"
              color="inherit"
              onClick={() => decide("cancel")}
            >
              Cancel
            </Button>
            <Button
              size="small"
              color="warning"
              variant={showFeedback ? "contained" : "outlined"}
              disabled={showFeedback && feedback.trim().length === 0}
              onClick={() => decide("request_changes")}
            >
              {showFeedback ? "Send feedback" : "Request changes"}
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => decide("approve")}
            >
              Approve & run
            </Button>
          </Stack>
        </>
      )}
    </Box>
  );
};
