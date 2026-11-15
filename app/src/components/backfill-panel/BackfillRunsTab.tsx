import {
  Box,
  Button,
  Typography,
  LinearProgress,
  Tooltip,
} from "@mui/material";
import { ArrowBack as ArrowBackIcon } from "@mui/icons-material";
import { ResultBadge, SpinnerRingBadge, StatusPill } from "../bui-status";
import { BUI_MONO_FONT_FAMILY } from "../chat/bui-styles";
import { clickableProps } from "../../lib/a11y";
import { formatLog } from "./backfill-helpers";
import type { BackfillPanelModel } from "./useBackfillPanel";

export function BackfillRunsTab({ model }: { model: BackfillPanelModel }) {
  const {
    executionId,
    liveLogs,
    runs,
    selectedRunId,
    setSelectedRunId,
    selectedRunLogs,
    setSelectedRunLogs,
    loadRunLogs,
  } = model;
  return (
    <Box sx={{ p: 2, display: "grid", gap: 2 }}>
      {/* Live running execution */}
      {(executionId || liveLogs.length > 0) && !selectedRunId && (
        <Box>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              mb: 0.75,
            }}
          >
            <Typography
              variant="caption"
              sx={{
                fontWeight: 600,
                fontSize: "0.72rem",
                textTransform: "uppercase",
                letterSpacing: 0.3,
                color: "text.secondary",
              }}
            >
              {executionId ? "Running" : "Last run"}
            </Typography>
            {executionId && <SpinnerRingBadge size={14} />}
          </Box>
          <Box
            sx={{
              borderRadius: "10px",
              boxShadow: executionId
                ? "0 0 0 1px var(--bui-accent)"
                : "var(--bui-shadow-hairline)",
              bgcolor: "grey.950",
              p: 1.5,
              height: 200,
              overflow: "auto",
            }}
          >
            {liveLogs.length === 0 ? (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  fontFamily: "monospace",
                }}
              >
                Waiting for logs…
              </Typography>
            ) : (
              liveLogs.map((log, i) => (
                <Typography
                  key={`${log.timestamp}-${i}`}
                  variant="caption"
                  sx={{
                    display: "block",
                    fontFamily: "monospace",
                    fontSize: "0.72rem",
                    whiteSpace: "pre-wrap",
                    color:
                      log.level === "error"
                        ? "error.main"
                        : log.level === "warn"
                          ? "warning.main"
                          : "text.secondary",
                    lineHeight: 1.6,
                  }}
                >
                  <Typography
                    component="span"
                    sx={{
                      fontFamily: "monospace",
                      fontSize: "0.68rem",
                      color: "text.disabled",
                    }}
                  >
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </Typography>{" "}
                  {formatLog(log)}
                </Typography>
              ))
            )}
          </Box>
        </Box>
      )}

      {/* Selected historical run logs */}
      {selectedRunId && selectedRunLogs !== null ? (
        <Box>
          <Button
            size="small"
            startIcon={<ArrowBackIcon sx={{ fontSize: 14 }} />}
            onClick={() => {
              setSelectedRunId(null);
              setSelectedRunLogs(null);
            }}
            sx={{ textTransform: "none", fontSize: "0.75rem", mb: 1 }}
          >
            Back to runs
          </Button>
          <Box
            sx={{
              borderRadius: 1,
              border: 1,
              borderColor: "divider",
              bgcolor: "grey.950",
              p: 1.5,
              maxHeight: 400,
              overflow: "auto",
              minHeight: 80,
            }}
          >
            {selectedRunLogs.length === 0 ? (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  fontFamily: "monospace",
                }}
              >
                No logs recorded for this run.
              </Typography>
            ) : (
              selectedRunLogs.map((log, i) => (
                <Typography
                  key={`${log.timestamp}-${i}`}
                  variant="caption"
                  sx={{
                    display: "block",
                    fontFamily: "monospace",
                    fontSize: "0.72rem",
                    whiteSpace: "pre-wrap",
                    color:
                      log.level === "error"
                        ? "error.main"
                        : log.level === "warn"
                          ? "warning.main"
                          : "text.secondary",
                    lineHeight: 1.6,
                  }}
                >
                  <Typography
                    component="span"
                    sx={{
                      fontFamily: "monospace",
                      fontSize: "0.68rem",
                      color: "text.disabled",
                    }}
                  >
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </Typography>{" "}
                  {formatLog(log)}
                </Typography>
              ))
            )}
          </Box>
        </Box>
      ) : selectedRunId ? (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            py: 3,
            justifyContent: "center",
          }}
        >
          <LinearProgress sx={{ width: 24 }} />
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            Loading logs…
          </Typography>
        </Box>
      ) : runs.length === 0 && !executionId && liveLogs.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            textAlign: "center",
            py: 2,
          }}
        >
          No execution history yet.
        </Typography>
      ) : runs.length > 0 ? (
        <Box>
          {(executionId || liveLogs.length > 0) && (
            <Typography
              variant="caption"
              sx={{
                fontWeight: 600,
                fontSize: "0.72rem",
                textTransform: "uppercase",
                letterSpacing: 0.3,
                color: "text.secondary",
                mb: 0.75,
                display: "block",
              }}
            >
              Past runs
            </Typography>
          )}
          {/* BUI Task Rows: badge + started time + duration/log meta +
              status pill; click loads the run's logs. */}
          <Box
            sx={{
              borderRadius: "14px",
              backgroundColor: "var(--bui-surface)",
              boxShadow: "var(--bui-shadow-card)",
              p: 0.5,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {runs.map(run => {
              const durationStr = run.duration
                ? run.duration < 60000
                  ? `${Math.round(run.duration / 1000)}s`
                  : run.duration < 3600000
                    ? `${Math.floor(run.duration / 60000)}m ${Math.round((run.duration % 60000) / 1000)}s`
                    : `${Math.floor(run.duration / 3600000)}h ${Math.floor((run.duration % 3600000) / 60000)}m`
                : "—";
              const errorText = run.error
                ? typeof run.error === "string"
                  ? run.error
                  : run.error.message
                : null;
              const logCount = (run as { logCount?: number }).logCount;
              return (
                <Box
                  key={run.executionId}
                  onClick={() => loadRunLogs(run.executionId)}
                  {...clickableProps(() => loadRunLogs(run.executionId))}
                  sx={{
                    px: 1,
                    py: 0.75,
                    borderRadius: "8px",
                    cursor: "pointer",
                    transition: "background-color 0.1s",
                    "&:hover": {
                      backgroundColor: "var(--bui-hover)",
                    },
                  }}
                >
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1.25,
                    }}
                  >
                    {run.status === "running" ? (
                      <SpinnerRingBadge size={18} />
                    ) : (
                      <ResultBadge
                        size={18}
                        tone={
                          run.status === "completed"
                            ? "green"
                            : run.status === "failed"
                              ? "red"
                              : "neutral"
                        }
                      />
                    )}
                    <Typography
                      sx={{
                        fontSize: "12.5px",
                        fontWeight: 500,
                        color: "var(--bui-ink)",
                        flex: 1,
                        minWidth: 0,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {new Date(run.executedAt).toLocaleString()}
                    </Typography>
                    <Box
                      component="span"
                      sx={{
                        fontFamily: BUI_MONO_FONT_FAMILY,
                        fontSize: "11px",
                        color: "var(--bui-ink-3)",
                        fontVariantNumeric: "tabular-nums",
                        flexShrink: 0,
                      }}
                    >
                      {durationStr}
                      {logCount !== undefined && ` · ${logCount} logs`}
                    </Box>
                    <StatusPill
                      tone={
                        run.status === "completed"
                          ? "green"
                          : run.status === "failed"
                            ? "red"
                            : run.status === "abandoned"
                              ? "orange"
                              : run.status === "running"
                                ? "accent"
                                : "neutral"
                      }
                    >
                      {run.status.charAt(0).toUpperCase() + run.status.slice(1)}
                    </StatusPill>
                  </Box>
                  {errorText && (
                    <Tooltip
                      title={errorText}
                      placement="bottom-start"
                      slotProps={{
                        tooltip: {
                          sx: {
                            maxWidth: 420,
                            fontFamily: "monospace",
                            fontSize: "0.72rem",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          },
                        },
                      }}
                    >
                      <Typography
                        variant="caption"
                        sx={{
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                          wordBreak: "break-word",
                          cursor: "help",
                          mt: 0.5,
                          ml: "30px",
                          px: 1,
                          py: 0.25,
                          borderRadius: "6px",
                          fontSize: "0.68rem",
                          color: "var(--bui-red)",
                          backgroundColor: "var(--bui-red-tint)",
                        }}
                      >
                        {errorText}
                      </Typography>
                    </Tooltip>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
