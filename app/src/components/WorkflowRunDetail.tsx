/**
 * One run in the `workflow` tab: where it failed and why, its steps in the
 * order they ran beside their log, output and input, and its flow behind
 * View flow. Everything comes from Hatchet's own record of the run; a
 * workflow adds nothing for it.
 */
import { useState, type ReactNode } from "react";
import {
  Box,
  CircularProgress,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import {
  STEP_COLOR,
  columnsOf,
  failureOf,
  firstLine,
} from "../lib/workflowRunSteps";
import {
  type WorkflowRun,
  type WorkflowRunStep,
} from "../store/workflowsStore";
import { formatDuration, formatUsd } from "../utils/format";
import FlowPanel from "./WorkflowRunFlow";
import StatusDot from "./WorkflowStatusDot";

const Dim = ({ children }: { children: ReactNode }) => (
  <Typography variant="caption" color="text.secondary">
    {children}
  </Typography>
);

/** Where in the workflow's code an error was thrown, from its stack. */
function codeLineOf(error?: string): string | undefined {
  const match = (error ?? "").match(/(workflows\/[^\s():]+):(\d+)/);
  return match ? `${match[1]}:${match[2]}` : undefined;
}

function FailureCard({ steps }: { steps: WorkflowRunStep[] }) {
  const { failed } = failureOf(steps);
  if (failed.length === 0) return null;
  const first = failed[0];
  const where = codeLineOf(first.error);
  return (
    <Box
      sx={{
        mx: 1.5,
        my: 1.5,
        p: 1.25,
        border: "1px solid",
        borderColor: "error.main",
        borderRadius: 1,
        display: "flex",
        flexDirection: "column",
        gap: 0.5,
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 600, color: "error.main" }}>
        Failed at step “{first.step}”
        {failed.length > 1 ? ` (and ${failed.length - 1} more)` : ""}
      </Typography>
      <Typography
        variant="body2"
        sx={{ fontFamily: "monospace", fontSize: "0.75rem" }}
      >
        {firstLine(first.error) || "No error message."}
      </Typography>
      {where && <Dim>at {where}</Dim>}
    </Box>
  );
}

type ListRow =
  | { kind: "step"; step: WorkflowRunStep; parallel: boolean }
  | { kind: "label"; text: string; key: string }
  | { kind: "fold"; text: string; key: string; names: string[] };

/** A long run of steps all done, or all not run, folds to one row. */
const FOLD_AT = 4;

/**
 * The steps as a list, in the order they ran: steps that ran side by side
 * are grouped under "in parallel". With many steps, long runs of done or
 * not-run steps fold, so the step that matters stays in view.
 */
function rowsOf(
  steps: WorkflowRunStep[],
  blockedBy: (step: WorkflowRunStep) => string | undefined,
  selected: string | null,
  unfolded: Set<string>,
): ListRow[] {
  const flat: Array<{
    step: WorkflowRunStep;
    parallel: boolean;
    group?: number;
  }> = [];
  columnsOf(steps).forEach((column, index) =>
    column.forEach(step =>
      flat.push({
        step,
        parallel: column.length > 1,
        group: column.length > 1 ? index : undefined,
      }),
    ),
  );
  const kindOf = (step: WorkflowRunStep) =>
    step.status === "COMPLETED"
      ? "done"
      : step.status === "WAITING"
        ? "waiting"
        : step.status === "CANCELLED" && blockedBy(step)
          ? "not run"
          : "other";
  const rows: ListRow[] = [];
  let lastGroup: number | undefined;
  for (let i = 0; i < flat.length;) {
    const kind = kindOf(flat[i].step);
    let j = i;
    while (
      j < flat.length &&
      kindOf(flat[j].step) === kind &&
      flat[j].step.step !== selected
    ) {
      j++;
    }
    const names = flat.slice(i, j).map(f => String(f.step.step));
    const key = `${kind}:${names[0]}`;
    if (
      steps.length > 12 &&
      kind !== "other" &&
      j - i >= FOLD_AT &&
      !unfolded.has(key)
    ) {
      // Keep the step next to the one that matters: the last done step
      // before a failure, the first not-run step after it.
      const keepLast = kind === "done";
      const folded = keepLast ? names.slice(0, -1) : names.slice(1);
      if (!keepLast) rows.push({ kind: "step", ...flat[i] });
      rows.push({
        kind: "fold",
        key,
        names: folded,
        text: `… ${folded.length} more ${kind}`,
      });
      if (keepLast) rows.push({ kind: "step", ...flat[j - 1] });
      lastGroup = undefined;
      i = j;
      continue;
    }
    const end = Math.max(j, i + 1);
    for (let k = i; k < end; k++) {
      const row = flat[k];
      if (row.group !== undefined && row.group !== lastGroup) {
        rows.push({ kind: "label", text: "in parallel", key: `p${row.group}` });
      }
      lastGroup = row.group;
      rows.push({ kind: "step", step: row.step, parallel: row.parallel });
    }
    i = end;
  }
  return rows;
}

function StepList({
  steps,
  selected,
  onSelect,
}: {
  steps: WorkflowRunStep[];
  selected: string | null;
  onSelect: (step: string | null) => void;
}) {
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const { blockedBy } = failureOf(steps);
  const rows = rowsOf(steps, blockedBy, selected, unfolded);
  const rowSx = (active: boolean) => ({
    display: "flex",
    alignItems: "center",
    gap: 0.75,
    px: 1.25,
    py: 0.5,
    cursor: "pointer",
    backgroundColor: active ? "action.selected" : "transparent",
    "&:hover": { backgroundColor: active ? "action.selected" : "action.hover" },
  });
  return (
    <Box
      sx={{
        width: 250,
        flexShrink: 0,
        overflow: "auto",
        borderRight: "1px solid",
        borderColor: "divider",
        fontSize: "0.75rem",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          px: 1.25,
          py: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Dim>
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </Dim>
      </Box>
      <Box
        role="button"
        tabIndex={0}
        onClick={() => onSelect(null)}
        onKeyDown={e => e.key === "Enter" && onSelect(null)}
        sx={{ ...rowSx(selected === null), fontWeight: 600 }}
      >
        All steps
      </Box>
      {rows.map(row => {
        if (row.kind === "label") {
          return (
            <Box key={row.key} sx={{ px: 1.25, pt: 0.5 }}>
              <Dim>{row.text}</Dim>
            </Box>
          );
        }
        if (row.kind === "fold") {
          return (
            <Box
              key={row.key}
              role="button"
              tabIndex={0}
              title={row.names.join(", ")}
              onClick={() => setUnfolded(new Set(unfolded).add(row.key))}
              onKeyDown={e =>
                e.key === "Enter" && setUnfolded(new Set(unfolded).add(row.key))
              }
              sx={{ ...rowSx(false), color: "text.secondary" }}
            >
              {row.text}
            </Box>
          );
        }
        const { step, parallel } = row;
        const waiting = step.status === "WAITING";
        const notRun =
          waiting || (step.status === "CANCELLED" && blockedBy(step));
        const failed = step.status === "FAILED";
        return (
          <Box
            key={step.step}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(step.step ?? null)}
            onKeyDown={e => e.key === "Enter" && onSelect(step.step ?? null)}
            sx={{
              ...rowSx(selected === step.step),
              ...(parallel
                ? {
                    ml: 1.25,
                    pl: 1,
                    borderLeft: "2px solid",
                    borderColor: "divider",
                  }
                : {}),
              color: failed
                ? "error.main"
                : notRun
                  ? "text.disabled"
                  : "text.primary",
            }}
          >
            <StatusDot
              status={step.status}
              color={STEP_COLOR[step.status ?? ""] ?? "text.secondary"}
              hollow={Boolean(notRun)}
            />
            <Box
              component="span"
              sx={{
                flex: 1,
                fontFamily: "monospace",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {step.step}
            </Box>
            {(step.attempt ?? 1) > 1 && <Dim>×{step.attempt}</Dim>}
            {step.costUsd !== undefined && <Dim>{formatUsd(step.costUsd)}</Dim>}
            <Dim>
              {waiting
                ? "waiting"
                : notRun
                  ? "not run"
                  : formatDuration(step.durationMs)}
            </Dim>
          </Box>
        );
      })}
    </Box>
  );
}

function LogView({
  steps,
  only,
  status,
}: {
  steps: WorkflowRunStep[];
  only: string | null;
  status?: string;
}) {
  const [search, setSearch] = useState("");
  const lines = steps
    .filter(step => !only || step.step === only)
    .flatMap(step =>
      [...step.logs, step.error].map((text, index) => ({
        step: step.step,
        text,
        error: index === step.logs.length,
      })),
    )
    .filter(
      (
        line,
      ): line is { step: string | undefined; text: string; error: boolean } =>
        Boolean(line.text),
    )
    .filter(
      line => !search || line.text.toLowerCase().includes(search.toLowerCase()),
    );
  return (
    <Box
      sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, pt: 1 }}>
        <TextField
          size="small"
          placeholder="Search the log"
          value={search}
          onChange={e => setSearch(e.target.value)}
          sx={{ width: 240, "& input": { py: 0.5, fontSize: 13 } }}
        />
        <Dim>{only ? `Step “${only}”, last attempt` : "All steps"}</Dim>
      </Box>
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          fontFamily: "monospace",
          fontSize: "0.72rem",
          p: 1,
          whiteSpace: "pre-wrap",
        }}
      >
        {lines.length === 0 ? (
          <Dim>
            {search
              ? "No line matches."
              : status === "QUEUED"
                ? "Run queued…"
                : "No logs."}
          </Dim>
        ) : (
          lines.map((line, index) => (
            <Box
              key={index}
              sx={line.error ? { color: "error.main" } : undefined}
            >
              {!only && (
                <Box component="span" sx={{ color: "text.secondary", mr: 1 }}>
                  {line.step}
                </Box>
              )}
              {line.text}
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

function Pretty({ text }: { text?: string }) {
  let shown = text ?? "";
  try {
    shown = JSON.stringify(JSON.parse(shown), null, 2);
  } catch {
    // Not JSON (or cut short): as it is.
  }
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        fontFamily: "monospace",
        fontSize: "0.72rem",
        p: 1,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {shown && shown !== "{}" ? shown : <Dim>Nothing.</Dim>}
    </Box>
  );
}

export default function WorkflowRunDetail({
  run,
  status,
}: {
  run: WorkflowRun | undefined;
  status?: string;
}) {
  // Until the viewer picks a step, a failed run shows its failed step.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [tab, setTab] = useState<"log" | "flow" | "output" | "input">("log");
  if (!run) {
    return (
      <Box sx={{ p: 2 }}>
        <CircularProgress size={14} />
      </Box>
    );
  }
  const steps = run.steps;
  const selected =
    picked === undefined
      ? (steps.find(s => s.status === "FAILED")?.step ?? null)
      : picked;
  const step = steps.find(s => s.step === selected);
  // The steps on the left pick what the log on the right shows.
  return (
    <Box
      sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <FailureCard steps={steps} />
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: "flex",
        }}
      >
        {steps.length > 0 && (
          <StepList steps={steps} selected={selected} onSelect={setPicked} />
        )}
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Tabs
            value={tab}
            onChange={(_e, value) => setTab(value)}
            sx={{
              minHeight: 32,
              px: 1,
              borderBottom: "1px solid",
              borderColor: "divider",
              "& .MuiTab-root": {
                minHeight: 32,
                py: 0,
                textTransform: "none",
                fontSize: 13,
              },
            }}
          >
            <Tab value="log" label="Log" />
            <Tab value="flow" label="Flow" />
            <Tab
              value="output"
              label={step ? `Output of “${step.step}”` : "Output"}
            />
            <Tab value="input" label="Input" />
          </Tabs>
          {tab === "log" && (
            <LogView steps={steps} only={selected} status={status} />
          )}
          {tab === "flow" && (
            <FlowPanel
              steps={steps}
              title="Flow of this run"
              selected={selected}
              onSelect={setPicked}
            />
          )}
          {tab === "output" && (
            <Pretty text={step ? step.output : run.output} />
          )}
          {tab === "input" && <Pretty text={run.input} />}
        </Box>
      </Box>
    </Box>
  );
}
