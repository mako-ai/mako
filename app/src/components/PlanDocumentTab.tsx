import React, { useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  InputBase,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import MonacoEditor from "@monaco-editor/react";
import { EDITOR_OPTIONS, useMonacoTheme } from "../lib/monaco-presets";
import {
  Circle,
  CircleCheck,
  CircleDot,
  CircleX,
  ClipboardList,
  Eye,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import type { PlanTodo } from "@mako/agent-tools";
import {
  closePlanTab,
  DECISION_COLOR,
  DECISION_LABEL,
  usePlanStore,
} from "../store/planStore";
import StreamingMarkdown from "./StreamingMarkdown";

const TODO_STATUS_ICON: Record<
  NonNullable<PlanTodo["status"]>,
  React.ReactNode
> = {
  pending: <Circle size={15} strokeWidth={1.5} />,
  in_progress: <CircleDot size={15} strokeWidth={1.5} />,
  completed: <CircleCheck size={15} strokeWidth={1.5} />,
  cancelled: <CircleX size={15} strokeWidth={1.5} />,
};

type ViewMode = "preview" | "edit";

/**
 * Cursor-style plan document rendered in a main-view tab (kind === "plan").
 * Reads/writes the draft in planStore by toolCallId; the approval actions
 * resolve the deferred `submit_plan` tool via the resolver registered by
 * Chat.tsx.
 */
export default function PlanDocumentTab({
  toolCallId,
}: {
  toolCallId: string;
}) {
  const monacoTheme = useMonacoTheme();

  const plan = usePlanStore(s => s.plans[toolCallId]);
  const setDraftTitle = usePlanStore(s => s.setDraftTitle);
  const setDraftMarkdown = usePlanStore(s => s.setDraftMarkdown);
  const updateTodo = usePlanStore(s => s.updateTodo);
  const addTodo = usePlanStore(s => s.addTodo);
  const removeTodo = usePlanStore(s => s.removeTodo);
  const resolvePlan = usePlanStore(s => s.resolvePlan);

  const [viewMode, setViewMode] = useState<ViewMode>("preview");

  if (!plan) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">
          This plan is no longer available. It may belong to an older chat
          session.
        </Typography>
      </Box>
    );
  }

  const streaming = plan.status === "streaming";
  const pending = plan.status === "pending";
  const effectiveMode: ViewMode = pending ? viewMode : "preview";

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 2,
          py: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
          backgroundColor: "background.paper",
        }}
      >
        <ClipboardList size={16} />
        <Typography variant="caption" color="text.secondary">
          Plan
        </Typography>
        {pending ? (
          <InputBase
            value={plan.draft.title}
            onChange={e => setDraftTitle(toolCallId, e.target.value)}
            placeholder="Plan title"
            sx={{
              flex: 1,
              minWidth: 0,
              typography: "subtitle1",
              fontWeight: 600,
            }}
          />
        ) : (
          <Typography
            variant="subtitle1"
            fontWeight={600}
            noWrap
            sx={{ flex: 1, minWidth: 0 }}
          >
            {plan.draft.title}
          </Typography>
        )}
        {streaming && (
          <Stack direction="row" spacing={0.75} alignItems="center">
            <CircularProgress size={12} thickness={5} />
            <Typography variant="caption" color="text.secondary">
              Writing plan…
            </Typography>
          </Stack>
        )}
        {!pending && !streaming && plan.output && (
          <Chip
            size="small"
            label={DECISION_LABEL[plan.output.decision]}
            color={DECISION_COLOR[plan.output.decision]}
            variant="outlined"
          />
        )}
        {pending && (
          <ToggleButtonGroup
            size="small"
            exclusive
            value={effectiveMode}
            onChange={(_, value: ViewMode | null) => {
              if (value) setViewMode(value);
            }}
          >
            <ToggleButton value="preview" aria-label="Preview">
              <Eye size={14} style={{ marginRight: 6 }} />
              Preview
            </ToggleButton>
            <ToggleButton value="edit" aria-label="Edit">
              <Pencil size={14} style={{ marginRight: 6 }} />
              Edit
            </ToggleButton>
          </ToggleButtonGroup>
        )}
      </Box>

      {/* Body */}
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {effectiveMode === "edit" ? (
          <MonacoEditor
            height="100%"
            path={`plan/${toolCallId}.md`}
            language="markdown"
            value={plan.draft.planMarkdown}
            theme={monacoTheme}
            onChange={value => setDraftMarkdown(toolCallId, value ?? "")}
            options={{ ...EDITOR_OPTIONS.code, wordWrap: "on" }}
          />
        ) : (
          <Box sx={{ maxWidth: 760, mx: "auto", px: 3, py: 3 }}>
            <StreamingMarkdown isStreaming={streaming}>
              {plan.draft.planMarkdown}
            </StreamingMarkdown>

            {/* Todos (appear/grow as they stream in) */}
            {(plan.draft.todos.length > 0 || pending) && (
              <Box sx={{ mt: 3 }}>
                <Typography variant="subtitle2" color="text.secondary" mb={1}>
                  {plan.draft.todos.length} To-do
                  {plan.draft.todos.length === 1 ? "" : "s"}
                </Typography>
                <Stack spacing={0.5}>
                  {plan.draft.todos.map((todo, index) => {
                    const status = todo.status ?? "pending";
                    return (
                      <Stack
                        key={todo.id ?? index}
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        sx={{
                          color:
                            status === "completed" || status === "cancelled"
                              ? "text.disabled"
                              : "text.primary",
                        }}
                      >
                        <Box
                          sx={{
                            display: "flex",
                            color:
                              status === "completed"
                                ? "success.main"
                                : "text.secondary",
                          }}
                        >
                          {TODO_STATUS_ICON[status]}
                        </Box>
                        {pending ? (
                          <InputBase
                            fullWidth
                            value={todo.content}
                            placeholder="Describe this step"
                            onChange={e =>
                              updateTodo(toolCallId, index, e.target.value)
                            }
                            sx={{ typography: "body2" }}
                          />
                        ) : (
                          <Typography
                            variant="body2"
                            sx={{
                              flex: 1,
                              textDecoration:
                                status === "cancelled"
                                  ? "line-through"
                                  : "none",
                            }}
                          >
                            {todo.content}
                          </Typography>
                        )}
                        {pending && (
                          <IconButton
                            size="small"
                            aria-label="Remove step"
                            onClick={() => removeTodo(toolCallId, index)}
                          >
                            <X size={14} />
                          </IconButton>
                        )}
                      </Stack>
                    );
                  })}
                </Stack>
                {pending && (
                  <Button
                    size="small"
                    color="inherit"
                    startIcon={<Plus size={14} />}
                    onClick={() => addTodo(toolCallId)}
                    sx={{ mt: 1 }}
                  >
                    Add step
                  </Button>
                )}
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* Sticky action bar — plan iteration happens conversationally: typing
          in the chat composer while the plan is pending sends the message as
          request_changes feedback. */}
      {pending && (
        <Box
          sx={{
            borderTop: "1px solid",
            borderColor: "divider",
            backgroundColor: "background.paper",
            px: 2,
            py: 1.5,
          }}
        >
          <Stack
            direction="row"
            spacing={1.5}
            alignItems="center"
            justifyContent="flex-end"
          >
            <Typography variant="caption" color="text.secondary">
              or reply in chat to iterate on the plan
            </Typography>
            <Button
              size="small"
              color="inherit"
              onClick={() => {
                // Cancel decision → the agent stops without executing; the
                // tab closes and the chat card keeps a "Cancelled" summary.
                if (resolvePlan(toolCallId, "cancel")) {
                  closePlanTab(toolCallId, plan.chatId);
                }
              }}
            >
              Discard
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => resolvePlan(toolCallId, "approve")}
            >
              Approve &amp; run
            </Button>
          </Stack>
        </Box>
      )}
    </Box>
  );
}
