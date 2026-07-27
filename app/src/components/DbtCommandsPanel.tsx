/**
 * Commands tab of the dbt file editor — dbt Cloud's list-plus-detail layout.
 *
 * Left rail: every command run this session (status dot, command, environment,
 * duration). Right pane: the selected invocation's headline status, collapsible
 * system logs, and the per-node results table (node / type / status / time /
 * rows) that used to live in the Results tab. Results is now the Preview data
 * grid, so node outcomes belong here alongside the command that produced them.
 */

import { useState } from "react";
import { Box, Chip, CircularProgress, Typography } from "@mui/material";
import {
  ChevronRight as ChevronRightIcon,
  ChevronDown as ChevronDownIcon,
  CircleX as ErrorIcon,
  CheckCircle2 as OkIcon,
  Clock as ClockIcon,
  GitBranch as EnvIcon,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import {
  countDbtSteps,
  type DbtCommandInvocation,
} from "../lib/dbt-command-history";
import { formatRowsAffected, formatStepDuration } from "../lib/dbt-step-format";
import type { DbtRunLogLine, DbtStepResult } from "../store/dbtStore";

function statusColor(status: DbtCommandInvocation["status"]): string {
  return status === "error"
    ? "error.main"
    : status === "success"
      ? "success.main"
      : "text.secondary";
}

function StatusIcon({ status }: { status: DbtCommandInvocation["status"] }) {
  if (status === "running") return <CircularProgress size={13} />;
  return status === "error" ? (
    <ErrorIcon size={14} color="var(--mui-palette-error-main)" />
  ) : (
    <OkIcon size={14} color="var(--mui-palette-success-main)" />
  );
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function LogLines({ logs }: { logs: DbtRunLogLine[] }) {
  if (logs.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        No output.
      </Typography>
    );
  }
  return (
    <Box
      sx={{
        fontFamily: "monospace",
        fontSize: "0.72rem",
        whiteSpace: "pre-wrap",
        maxHeight: 260,
        overflow: "auto",
        borderRadius: 1,
        border: "1px solid",
        borderColor: "divider",
        bgcolor: "action.hover",
        p: 1,
      }}
    >
      {logs.map((log, index) => (
        <Box
          key={index}
          sx={{
            color:
              log.level === "error"
                ? "error.main"
                : log.level === "warn"
                  ? "warning.main"
                  : "text.primary",
          }}
        >
          {log.line}
        </Box>
      ))}
    </Box>
  );
}

const COUNTER_COLORS: Record<string, string> = {
  Pass: "success.main",
  Warn: "warning.main",
  Error: "error.main",
};

function StepCounters({ steps }: { steps: DbtStepResult[] }) {
  const counts = countDbtSteps(steps);
  const entries: Array<[string, number]> = [
    ["All", counts.all],
    ["Pass", counts.pass],
    ["Warn", counts.warn],
    ["Error", counts.error],
    ["Skip", counts.skip],
    ["Running", counts.running],
  ];
  return (
    <Box
      sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}
    >
      {entries.map(([label, value]) => (
        <Box
          key={label}
          sx={{ display: "flex", alignItems: "center", gap: 0.75 }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {label}
          </Typography>
          <Chip
            size="small"
            label={value}
            sx={{
              height: 20,
              fontSize: "0.7rem",
              fontWeight: 600,
              color: value > 0 ? COUNTER_COLORS[label] : undefined,
            }}
          />
        </Box>
      ))}
    </Box>
  );
}

function StepResultsTable({ steps }: { steps: DbtStepResult[] }) {
  return (
    <Box
      component="table"
      sx={{
        width: "100%",
        fontSize: "0.75rem",
        borderCollapse: "collapse",
        "& td, & th": {
          borderBottom: "1px solid",
          borderColor: "divider",
          p: 0.5,
          textAlign: "left",
        },
        "& th": { color: "text.secondary", fontWeight: 600 },
      }}
    >
      <thead>
        <tr>
          <th>Node</th>
          <th>Type</th>
          <th>Status</th>
          <th>Time</th>
          <th>Rows</th>
        </tr>
      </thead>
      <tbody>
        {steps.map(step => (
          <Box
            component="tr"
            key={step.uniqueId}
            sx={{
              color:
                step.status === "error" || step.status === "fail"
                  ? "error.main"
                  : step.status === "warn"
                    ? "warning.main"
                    : "inherit",
            }}
          >
            <td>{step.name}</td>
            <td>{step.resourceType}</td>
            <td>{step.status}</td>
            <td>{formatStepDuration(step.executionTimeMs)}</td>
            <td>{formatRowsAffected(step.rowsAffected)}</td>
          </Box>
        ))}
      </tbody>
    </Box>
  );
}

function InvocationDetail({ entry }: { entry: DbtCommandInvocation }) {
  const [logsOpen, setLogsOpen] = useState(false);

  return (
    <Box sx={{ p: 2.5, overflow: "auto", height: "100%" }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 1.5,
          flexWrap: "wrap",
        }}
      >
        <Typography
          variant="h6"
          sx={{ fontSize: "1.05rem", fontWeight: 600, wordBreak: "break-word" }}
        >
          dbt {entry.command}
        </Typography>
        <Chip
          size="small"
          icon={<StatusIcon status={entry.status} />}
          label={
            entry.status === "running"
              ? "Running"
              : entry.status === "error"
                ? "Error"
                : "Success"
          }
          sx={{ color: statusColor(entry.status), fontWeight: 600 }}
        />
      </Box>

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          mt: 1,
          color: "text.secondary",
        }}
      >
        <EnvIcon size={14} />
        <Typography variant="body2">{entry.environment}</Typography>
      </Box>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          mt: 0.5,
          color: "text.secondary",
        }}
      >
        <ClockIcon size={14} />
        <Typography variant="body2">
          {formatDistanceToNow(new Date(entry.startedAt), { addSuffix: true })}
          {entry.durationMs !== undefined
            ? ` · ${formatDuration(entry.durationMs)}`
            : ""}
        </Typography>
      </Box>

      <Box sx={{ mt: 3 }}>
        <Box
          role="button"
          tabIndex={0}
          onClick={() => setLogsOpen(open => !open)}
          onKeyDown={e => {
            if (e.key === "Enter" || e.key === " ") setLogsOpen(open => !open);
          }}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            cursor: "pointer",
            width: "fit-content",
          }}
        >
          {logsOpen ? (
            <ChevronDownIcon size={16} />
          ) : (
            <ChevronRightIcon size={16} />
          )}
          <Typography variant="body1" sx={{ fontWeight: 600 }}>
            System logs
          </Typography>
        </Box>
        {logsOpen && (
          <Box sx={{ mt: 1 }}>
            <LogLines logs={entry.logs} />
          </Box>
        )}
      </Box>

      <Box sx={{ mt: 3 }}>
        <StepCounters steps={entry.stepResults} />
      </Box>

      {entry.stepResults.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <StepResultsTable steps={entry.stepResults} />
        </Box>
      )}
    </Box>
  );
}

export default function DbtCommandsPanel({
  history,
  selectedId,
  onSelect,
}: {
  history: DbtCommandInvocation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const selected =
    history.find(entry => entry.id === selectedId) ?? history[0] ?? null;

  if (history.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="caption" color="text.secondary">
          Press Preview, Compile or Build above — or type a dbt command in the
          bar below (e.g. <code>build --select stg_orders+</code>) and press
          Enter.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", height: "100%", minHeight: 0 }}>
      <Box
        sx={{
          width: 260,
          flexShrink: 0,
          borderRight: "1px solid",
          borderColor: "divider",
          overflow: "auto",
        }}
      >
        {history.map(entry => {
          const active = selected?.id === entry.id;
          return (
            <Box
              key={entry.id}
              role="button"
              tabIndex={0}
              aria-current={active}
              onClick={() => onSelect(entry.id)}
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") onSelect(entry.id);
              }}
              sx={{
                px: 1.5,
                py: 1,
                cursor: "pointer",
                borderBottom: "1px solid",
                borderColor: "divider",
                borderLeft: "2px solid",
                borderLeftColor: active ? "primary.main" : "transparent",
                bgcolor: active ? "action.selected" : undefined,
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                <StatusIcon status={entry.status} />
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 600,
                    color: active ? "primary.main" : "text.primary",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  dbt {entry.command}
                </Typography>
              </Box>
              <Box
                sx={{
                  display: "flex",
                  justifyContent: "space-between",
                  mt: 0.25,
                }}
              >
                <Typography variant="caption" color="text.secondary">
                  {entry.environment}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatDuration(entry.durationMs)}
                </Typography>
              </Box>
            </Box>
          );
        })}
      </Box>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        {selected && <InvocationDetail key={selected.id} entry={selected} />}
      </Box>
    </Box>
  );
}
