/**
 * A flow as a graph: a card per step, placed one column after the steps it
 * waits for, joined to them by a line. A run's (with each step's status) or
 * a workflow's own (as its code defines it); shown in place, and full screen
 * from the expand button.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Box, Dialog, IconButton, Tooltip, Typography } from "@mui/material";
import { Maximize2 as ExpandIcon, X as CloseIcon } from "lucide-react";
import {
  STEP_COLOR,
  columnsOf,
  failureOf,
  firstLine,
} from "../lib/workflowRunSteps";
import { isActiveRun, type WorkflowRunStep } from "../store/workflowsStore";
import { formatDuration } from "../utils/format";
import StatusDot from "./WorkflowStatusDot";

const Dim = ({ children }: { children: ReactNode }) => (
  <Typography variant="caption" color="text.secondary">
    {children}
  </Typography>
);

const CARD_W = 176;
const CARD_H = 58;
const COL_GAP = 40;
const ROW_GAP = 14;
const PAD = 16;

function StepCard({
  step,
  blockedBy,
  selected,
  onSelect,
}: {
  step: WorkflowRunStep;
  blockedBy?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const waiting = step.status === "WAITING";
  const notRun = waiting || (step.status === "CANCELLED" && blockedBy);
  const color = STEP_COLOR[step.status ?? ""] ?? "text.secondary";
  const line = waiting
    ? "Waiting for the steps before it"
    : notRun
      ? `Not run: “${blockedBy}” failed`
      : step.status === "FAILED"
        ? firstLine(step.error)
        : (step.note ?? step.logs.filter(Boolean).at(-1) ?? "");
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={e => e.key === "Enter" && onSelect()}
      sx={{
        width: CARD_W,
        height: CARD_H,
        boxSizing: "border-box",
        px: 1,
        py: 0.75,
        borderRadius: 1,
        cursor: "pointer",
        border: step.status === "FAILED" ? "2px solid" : "1px solid",
        borderStyle: notRun ? "dashed" : "solid",
        borderColor:
          step.status === "FAILED"
            ? "error.main"
            : selected
              ? "primary.main"
              : "divider",
        backgroundColor: selected ? "action.selected" : "background.paper",
        opacity: notRun ? 0.7 : 1,
        "&:hover": { backgroundColor: "action.hover" },
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
        <StatusDot
          status={step.status}
          color={color}
          hollow={Boolean(notRun)}
        />
        <Typography
          variant="caption"
          sx={{ fontFamily: "monospace", fontWeight: 600, flex: 1 }}
          noWrap
        >
          {step.step}
        </Typography>
        {(step.attempt ?? 1) > 1 && (
          <Tooltip title={`Attempt ${step.attempt}`}>
            <Typography variant="caption" color="text.secondary">
              ×{step.attempt}
            </Typography>
          </Tooltip>
        )}
        {step.status && !isActiveRun(step.status) && (
          <Dim>{notRun ? "" : formatDuration(step.durationMs)}</Dim>
        )}
      </Box>
      <Typography
        variant="caption"
        component="div"
        sx={{
          mt: 0.5,
          fontFamily: notRun ? undefined : "monospace",
          fontSize: "0.68rem",
          color: step.status === "FAILED" ? "error.main" : "text.secondary",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={line}
      >
        {line || " "}
      </Typography>
    </Box>
  );
}

/**
 * Where each card goes, and the lines between them: from a step to each
 * step that waits for it. A sandbox run records no graph; its steps ran one
 * after another, so each is joined to the next.
 */
function layoutOf(steps: WorkflowRunStep[]) {
  const columns = columnsOf(steps);
  const rows = Math.max(1, ...columns.map(column => column.length));
  const height = PAD * 2 + rows * CARD_H + (rows - 1) * ROW_GAP;
  const width =
    PAD * 2 + columns.length * CARD_W + (columns.length - 1) * COL_GAP;
  const at = new Map<string | undefined, { x: number; y: number }>();
  columns.forEach((column, c) => {
    const columnHeight = column.length * CARD_H + (column.length - 1) * ROW_GAP;
    const top = (height - columnHeight) / 2;
    column.forEach((step, r) =>
      at.set(step.step, {
        x: PAD + c * (CARD_W + COL_GAP),
        y: top + r * (CARD_H + ROW_GAP),
      }),
    );
  });
  const graphed = steps.some(step => step.parents?.length);
  const edges = steps.flatMap((step, index) => {
    const parents = graphed
      ? (step.parents ?? [])
      : index > 0
        ? [steps[index - 1].step]
        : [];
    const to = at.get(step.step);
    return parents.flatMap(parent => {
      const from = at.get(parent);
      if (!from || !to) return [];
      const x1 = from.x + CARD_W;
      const y1 = from.y + CARD_H / 2;
      const x2 = to.x;
      const y2 = to.y + CARD_H / 2;
      const bend = (x2 - x1) / 2;
      return [
        {
          key: `${parent}>${step.step}`,
          d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
          muted:
            step.status === "CANCELLED" ||
            step.status === "WAITING" ||
            isActiveRun(step.status),
        },
      ];
    });
  });
  return { at, edges, width, height };
}

function FlowCanvas({
  steps,
  selected,
  onSelect,
}: {
  steps: WorkflowRunStep[];
  selected: string | null;
  onSelect: (step: string | null) => void;
}) {
  const { at, edges, width, height } = useMemo(() => layoutOf(steps), [steps]);
  const { blockedBy } = failureOf(steps);
  return (
    <Box sx={{ position: "relative", width, height, flexShrink: 0 }}>
      <Box
        component="svg"
        width={width}
        height={height}
        sx={{ position: "absolute", inset: 0, overflow: "visible" }}
        aria-hidden
      >
        <defs>
          <marker
            id="flow-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
          </marker>
        </defs>
        {edges.map(edge => (
          <Box
            component="path"
            key={edge.key}
            d={edge.d}
            fill="none"
            strokeWidth={1.5}
            strokeDasharray={edge.muted ? "4 4" : undefined}
            markerEnd="url(#flow-arrow)"
            sx={{ color: "text.disabled", stroke: "currentColor" }}
          />
        ))}
      </Box>
      {steps.map(step => {
        const pos = at.get(step.step);
        if (!pos) return null;
        return (
          <Box
            key={step.step}
            sx={{ position: "absolute", left: pos.x, top: pos.y }}
          >
            <StepCard
              step={step}
              blockedBy={blockedBy(step)}
              selected={selected === step.step}
              onSelect={() =>
                onSelect(selected === step.step ? null : (step.step ?? null))
              }
            />
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * The full-screen flow's scale: grown to fill the window, or shrunk (to half
 * at most) so a long flow fits; beyond that it scrolls.
 */
function fitScale(steps: WorkflowRunStep[]): number {
  const { width, height } = layoutOf(steps);
  return Math.max(
    0.5,
    Math.min(
      2,
      (window.innerWidth - 64) / width,
      (window.innerHeight - 120) / height,
    ),
  );
}

/** The flow full screen, scaled to fit; scrolls when larger. */
function FlowDialog({
  steps,
  title,
  open,
  onClose,
  selected,
  onSelect,
}: {
  steps: WorkflowRunStep[];
  title: string;
  open: boolean;
  onClose: () => void;
  selected: string | null;
  onSelect: (step: string | null) => void;
}) {
  return (
    <Dialog fullScreen open={open} onClose={onClose}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          px: 2,
          py: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          {title}
        </Typography>
        <IconButton size="small" onClick={onClose} aria-label="Close">
          <CloseIcon size={16} />
        </IconButton>
      </Box>
      <Box sx={{ flex: 1, overflow: "auto", display: "flex", p: 4 }}>
        {/* margin auto centres it when it fits and keeps it scrollable when not */}
        <Box sx={{ m: "auto", zoom: open ? fitScale(steps) : 1 }}>
          <FlowCanvas
            steps={steps}
            selected={selected}
            onSelect={step => {
              onSelect(step);
              onClose();
            }}
          />
        </Box>
      </Box>
    </Dialog>
  );
}

/**
 * The flow in place, scrolling when it is larger than the page, with a button
 * to open it full screen.
 */
export default function FlowPanel({
  steps,
  title,
  selected,
  onSelect,
}: {
  steps: WorkflowRunStep[];
  title: string;
  selected: string | null;
  onSelect: (step: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Dim>No steps to show.</Dim>
      </Box>
    );
  }
  return (
    <Box sx={{ flex: 1, minHeight: 0, position: "relative", display: "flex" }}>
      <Box sx={{ flex: 1, overflow: "auto", display: "flex" }}>
        <Box sx={{ m: "auto" }}>
          <FlowCanvas steps={steps} selected={selected} onSelect={onSelect} />
        </Box>
      </Box>
      <Tooltip title="Full screen">
        <IconButton
          size="small"
          onClick={() => setExpanded(true)}
          sx={{ position: "absolute", top: 6, right: 6 }}
          aria-label="Open the flow full screen"
        >
          <ExpandIcon size={14} />
        </IconButton>
      </Tooltip>
      <FlowDialog
        steps={steps}
        title={title}
        open={expanded}
        onClose={() => setExpanded(false)}
        selected={selected}
        onSelect={onSelect}
      />
    </Box>
  );
}
