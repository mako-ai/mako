import {
  Box,
  Button,
  Typography,
  Alert,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
} from "@mui/material";
import { Replay as RetryIcon } from "@mui/icons-material";
import { BorderedTableContainer, DenseHeadRow } from "./backfill-styles";
import type { BackfillPanelModel } from "./useBackfillPanel";

export function BackfillEventsTab({ model }: { model: BackfillPanelModel }) {
  const {
    cdc,
    webhookEvents,
    eventsFilter,
    setEventsFilter,
    eventCounts,
    retryingFailed,
    reprocessing,
    streamState,
    bfStatus,
    handleRetryAllFailed,
    handleReprocessStale,
  } = model;
  return (
    <Box sx={{ p: 2 }}>
      {cdc?.lastError && (streamState === "error" || bfStatus === "error") && (
        <Alert
          severity="error"
          sx={{
            mb: 1.5,
            "& .MuiAlert-message": { width: "100%" },
          }}
        >
          <Typography
            variant="body2"
            sx={{ fontWeight: 600, fontSize: "0.8rem", mb: 0.25 }}
          >
            {streamState === "error" && bfStatus === "error"
              ? "Stream & backfill error"
              : streamState === "error"
                ? "Stream error"
                : "Backfill error"}
            {cdc.consecutiveFailures > 0 && (
              <Chip
                label={`${cdc.consecutiveFailures} consecutive failures`}
                size="small"
                color="error"
                variant="outlined"
                sx={{
                  ml: 1,
                  height: 18,
                  fontSize: "0.65rem",
                  fontWeight: 500,
                }}
              />
            )}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              fontFamily: "monospace",
              fontSize: "0.72rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              display: "block",
            }}
          >
            {cdc.lastError.message || cdc.lastError.code || "Unknown error"}
          </Typography>
          {cdc.lastError.reason &&
            cdc.lastError.reason !== cdc.lastError.message && (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  fontSize: "0.68rem",
                  display: "block",
                  mt: 0.25,
                }}
              >
                Reason: {cdc.lastError.reason}
              </Typography>
            )}
        </Alert>
      )}
      <Box
        sx={{
          display: "flex",
          gap: 0.5,
          mb: 1.5,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {(
          [
            { key: "all", label: "All" },
            { key: "applied", label: "Applied" },
            { key: "pending", label: "Pending" },
            { key: "failed", label: "Failed" },
            { key: "dropped", label: "Dropped" },
          ] as const
        ).map(f => (
          <Chip
            key={f.key}
            label={`${f.label} (${eventCounts[f.key] ?? 0})`}
            size="small"
            variant={eventsFilter === f.key ? "filled" : "outlined"}
            color={
              eventsFilter === f.key
                ? f.key === "failed"
                  ? "error"
                  : f.key === "dropped"
                    ? "warning"
                    : f.key === "pending"
                      ? "info"
                      : f.key === "applied"
                        ? "success"
                        : "default"
                : "default"
            }
            onClick={() => setEventsFilter(f.key)}
            sx={{
              fontSize: "0.72rem",
              fontWeight: eventsFilter === f.key ? 600 : 400,
              cursor: "pointer",
            }}
          />
        ))}
        {(cdc as any)?.failedWebhookCount > 0 && (
          <Button
            size="small"
            variant="outlined"
            color="error"
            startIcon={<RetryIcon sx={{ fontSize: 14 }} />}
            onClick={handleRetryAllFailed}
            disabled={retryingFailed}
            sx={{
              textTransform: "none",
              fontSize: "0.72rem",
              ml: "auto",
            }}
          >
            {retryingFailed
              ? "Retrying..."
              : `Retry ${(cdc as any).failedWebhookCount} failed`}
          </Button>
        )}
        {eventCounts.pending > 0 && streamState !== "error" && (
          <Button
            size="small"
            variant="outlined"
            color="info"
            startIcon={<RetryIcon sx={{ fontSize: 14 }} />}
            onClick={handleReprocessStale}
            disabled={reprocessing}
            sx={{
              textTransform: "none",
              fontSize: "0.72rem",
              ...((cdc as any)?.failedWebhookCount > 0 ? {} : { ml: "auto" }),
            }}
          >
            {reprocessing
              ? "Reprocessing..."
              : `Reprocess ${eventCounts.pending} pending`}
          </Button>
        )}
      </Box>
      {webhookEvents.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            textAlign: "center",
            py: 2,
          }}
        >
          {eventsFilter === "all"
            ? "No webhook events received yet."
            : `No ${eventsFilter} events.`}
        </Typography>
      ) : (
        <BorderedTableContainer>
          <Table size="small">
            <TableHead>
              <DenseHeadRow>
                <TableCell>Event type</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Apply</TableCell>
                <TableCell>Error</TableCell>
                <TableCell>Received</TableCell>
                <TableCell align="right">Duration</TableCell>
              </DenseHeadRow>
            </TableHead>
            <TableBody>
              {webhookEvents.map((evt: any) => (
                <TableRow
                  key={evt.eventId || evt.id}
                  sx={{ "&:last-child td": { borderBottom: 0 } }}
                >
                  <TableCell
                    sx={{
                      fontFamily: "monospace",
                      fontSize: "0.75rem",
                    }}
                  >
                    {evt.eventType}
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={evt.status}
                      size="small"
                      variant="outlined"
                      color={
                        evt.status === "completed"
                          ? "success"
                          : evt.status === "failed"
                            ? "error"
                            : evt.status === "processing"
                              ? "info"
                              : "default"
                      }
                      sx={{
                        height: 22,
                        fontSize: "0.68rem",
                        fontWeight: 500,
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    {evt.applyStatus && (
                      <Chip
                        label={evt.applyStatus}
                        size="small"
                        variant="outlined"
                        color={
                          evt.applyStatus === "applied"
                            ? "success"
                            : evt.applyStatus === "failed"
                              ? "error"
                              : evt.applyStatus === "dropped"
                                ? "warning"
                                : "default"
                        }
                        sx={{
                          height: 22,
                          fontSize: "0.68rem",
                          fontWeight: 500,
                        }}
                      />
                    )}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 240 }}>
                    {(evt.applyError?.message || evt.error?.message) && (
                      <Tooltip
                        title={
                          evt.applyError?.message || evt.error?.message || ""
                        }
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
                            color: "error.main",
                            fontSize: "0.68rem",
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                            wordBreak: "break-word",
                            cursor: "help",
                          }}
                        >
                          {evt.applyError?.message || evt.error?.message}
                        </Typography>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {new Date(evt.receivedAt).toLocaleString()}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {evt.processingDurationMs != null
                        ? `${evt.processingDurationMs}ms`
                        : "—"}
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </BorderedTableContainer>
      )}
    </Box>
  );
}
