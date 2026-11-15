import {
  Box,
  Typography,
  Alert,
  LinearProgress,
  IconButton,
  Tooltip,
} from "@mui/material";
import {
  History as BackfillIcon,
  Pause as PauseIcon,
  Stop as CancelIcon,
  PlayArrow as ResumeIcon,
  Healing as RecoverIcon,
  Refresh as RefreshIcon,
} from "@mui/icons-material";
import { pillToneForMuiColor, StatusPill } from "../bui-status";
import { formatLag } from "./backfill-helpers";
import {
  ButtonRow,
  CompactButton,
  KpiCard,
  KpiLabel,
  KpiValue,
} from "./backfill-styles";
import type { BackfillPanelModel } from "./useBackfillPanel";

export function BackfillKpiCards({ model }: { model: BackfillPanelModel }) {
  const {
    cdc,
    busy,
    error,
    setError,
    destinationCounts,
    destCountsLoading,
    isReconcileOnly,
    streamState,
    bfStatus,
    pollDestCounts,
    handleStartBackfill,
    handleStartStream,
    handlePauseStream,
    handleResumeStream,
    handleRecoverStream,
    handlePauseBackfill,
    handleCancelBackfill,
    handleResumeBackfill,
    handleRecoverBackfill,
    totalEventsProcessed,
    totalRowsApplied,
    totalDestinationRows,
    hasAnyDestinationCount,
    ss,
    bs,
  } = model;
  return (
    <Box sx={{ px: 2, pt: 2, pb: 1, flexShrink: 0 }}>
      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {busy && <LinearProgress sx={{ mb: 1 }} />}

      {cdc ? (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 1.5,
          }}
        >
          {/* Stream */}
          <KpiCard>
            <KpiLabel>Stream</KpiLabel>
            {isReconcileOnly ? (
              <>
                <KpiValue>—</KpiValue>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    display: "block",
                    mt: 0.25,
                    fontSize: "0.68rem",
                  }}
                >
                  No streaming trigger — this sync runs on the periodic full
                  reconcile.
                </Typography>
              </>
            ) : (
              <>
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    mb: 0.75,
                  }}
                >
                  <StatusPill tone={pillToneForMuiColor(ss.color)}>
                    {ss.label}
                  </StatusPill>
                  {cdc.lagSeconds !== null && (
                    <Typography
                      variant="caption"
                      color={
                        cdc.lagSeconds >= 0 && cdc.lagSeconds <= 5
                          ? "success.main"
                          : "text.secondary"
                      }
                      sx={{
                        fontSize: "0.72rem",
                        fontWeight:
                          cdc.lagSeconds >= 0 && cdc.lagSeconds <= 5
                            ? 600
                            : 400,
                      }}
                    >
                      {cdc.lagSeconds < 0
                        ? "catching up"
                        : cdc.lagSeconds <= 5
                          ? "live"
                          : `${formatLag(cdc.lagSeconds)} lag`}
                    </Typography>
                  )}
                </Box>
                {(cdc as any).failedWebhookCount > 0 && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "error.main",
                      fontSize: "0.72rem",
                      fontWeight: 600,
                      mb: 0.5,
                    }}
                  >
                    {(cdc as any).failedWebhookCount} webhook
                    {(cdc as any).failedWebhookCount === 1 ? "" : "s"} failed to
                    enqueue
                  </Typography>
                )}
                <ButtonRow>
                  {streamState === "idle" && (
                    <CompactButton
                      size="small"
                      variant="outlined"
                      startIcon={<ResumeIcon sx={{ fontSize: 14 }} />}
                      onClick={handleStartStream}
                      disabled={busy}
                    >
                      Start
                    </CompactButton>
                  )}
                  {streamState === "active" && (
                    <CompactButton
                      size="small"
                      variant="outlined"
                      startIcon={<PauseIcon sx={{ fontSize: 14 }} />}
                      onClick={handlePauseStream}
                      disabled={busy}
                    >
                      Pause
                    </CompactButton>
                  )}
                  {streamState === "paused" && (
                    <CompactButton
                      size="small"
                      variant="outlined"
                      startIcon={<ResumeIcon sx={{ fontSize: 14 }} />}
                      onClick={handleResumeStream}
                      disabled={busy}
                    >
                      Resume
                    </CompactButton>
                  )}
                  {streamState === "error" && (
                    <CompactButton
                      size="small"
                      variant="outlined"
                      color="error"
                      startIcon={<RecoverIcon sx={{ fontSize: 14 }} />}
                      onClick={handleRecoverStream}
                      disabled={busy}
                    >
                      Recover
                    </CompactButton>
                  )}
                  {cdc.webhookPendingCount > 0 && streamState !== "idle" && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                        alignSelf: "center",
                        fontSize: "0.72rem",
                      }}
                    >
                      {cdc.webhookPendingCount.toLocaleString()} pending
                    </Typography>
                  )}
                </ButtonRow>
              </>
            )}
          </KpiCard>

          {/* Backfill */}
          <KpiCard>
            <KpiLabel>Backfill</KpiLabel>
            <Box sx={{ mb: 0.75 }}>
              <StatusPill tone={pillToneForMuiColor(bs.color)}>
                {bs.label}
              </StatusPill>
            </Box>
            <ButtonRow>
              {(bfStatus === "idle" || bfStatus === "completed") && (
                <CompactButton
                  size="small"
                  variant="outlined"
                  startIcon={<BackfillIcon sx={{ fontSize: 14 }} />}
                  onClick={() => handleStartBackfill()}
                  disabled={busy}
                >
                  {bfStatus === "completed" ? "Re-run" : "Start"}
                </CompactButton>
              )}
              {bfStatus === "running" && (
                <CompactButton
                  size="small"
                  variant="outlined"
                  color="error"
                  startIcon={<PauseIcon sx={{ fontSize: 14 }} />}
                  onClick={handlePauseBackfill}
                  disabled={busy}
                >
                  Pause
                </CompactButton>
              )}
              {bfStatus === "paused" && (
                <>
                  <CompactButton
                    size="small"
                    variant="outlined"
                    startIcon={<ResumeIcon sx={{ fontSize: 14 }} />}
                    onClick={handleResumeBackfill}
                    disabled={busy}
                  >
                    Resume
                  </CompactButton>
                  <CompactButton
                    size="small"
                    variant="outlined"
                    color="error"
                    startIcon={<CancelIcon sx={{ fontSize: 14 }} />}
                    onClick={handleCancelBackfill}
                    disabled={busy}
                  >
                    Cancel
                  </CompactButton>
                </>
              )}
              {bfStatus === "error" && (
                <CompactButton
                  size="small"
                  variant="outlined"
                  color="error"
                  startIcon={<RecoverIcon sx={{ fontSize: 14 }} />}
                  onClick={handleRecoverBackfill}
                  disabled={busy}
                >
                  Recover
                </CompactButton>
              )}
            </ButtonRow>
          </KpiCard>

          {/* Events processed */}
          <KpiCard>
            <KpiLabel>Events processed</KpiLabel>
            <KpiValue>{totalEventsProcessed.toLocaleString()}</KpiValue>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
                display: "block",
                mt: 0.25,
                fontSize: "0.68rem",
              }}
            >
              Rows applied: {totalRowsApplied.toLocaleString()}
            </Typography>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                mt: 0.1,
              }}
            >
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  fontSize: "0.68rem",
                }}
              >
                Destination rows:{" "}
                {destinationCounts === null || !hasAnyDestinationCount
                  ? "—"
                  : totalDestinationRows.toLocaleString()}
              </Typography>
              <Tooltip title="Refresh destination row counts">
                <span>
                  <IconButton
                    size="small"
                    onClick={pollDestCounts}
                    disabled={destCountsLoading}
                    sx={{ p: 0.25 }}
                  >
                    <RefreshIcon
                      sx={{
                        fontSize: 12,
                        ...(destCountsLoading && {
                          animation: "spin 1s linear infinite",
                          "@keyframes spin": {
                            "0%": { transform: "rotate(0deg)" },
                            "100%": { transform: "rotate(360deg)" },
                          },
                        }),
                      }}
                    />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
            {cdc.lastMaterializedAt && (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  display: "block",
                  mt: 0.25,
                  fontSize: "0.68rem",
                }}
              >
                Last {new Date(cdc.lastMaterializedAt).toLocaleString()}
              </Typography>
            )}
          </KpiCard>
        </Box>
      ) : (
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
            Loading…
          </Typography>
        </Box>
      )}
    </Box>
  );
}
