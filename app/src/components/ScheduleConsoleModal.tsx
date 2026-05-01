import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Drawer,
  FormControlLabel,
  IconButton,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { CronExpressionParser } from "cron-parser";
import { FlowRunNotificationsSection } from "./FlowRunNotificationsSection";

type SchedulePreset = "hourly" | "daily" | "every6h" | "weekly" | "custom";

interface ScheduleConsoleModalProps {
  open: boolean;
  mode: "create" | "update";
  initialName: string;
  initialSchedule?: {
    cron: string;
    timezone: string;
  };
  connectionLabel?: string;
  /** Workspace containing the console — enables notification UI when set */
  workspaceId?: string;
  /** Saved console id for notification rules (omit until console is saved server-side) */
  notificationConsoleId?: string;
  workspaceRole?: string;
  onClose: () => void;
  onSave: (input: { cron: string; timezone: string }) => Promise<void>;
  onRemove?: () => Promise<void>;
  onRunNow?: () => Promise<void>;
}

const intlWithSupportedValues = Intl as typeof Intl & {
  supportedValuesOf?: (key: "timeZone") => string[];
};

const TIMEZONE_OPTIONS =
  typeof intlWithSupportedValues.supportedValuesOf === "function"
    ? intlWithSupportedValues.supportedValuesOf("timeZone")
    : ["UTC"];

const presetFromCron = (cron: string): SchedulePreset => {
  if (cron === "0 * * * *") return "hourly";
  if (cron === "0 0 * * *") return "daily";
  if (cron === "0 */6 * * *") return "every6h";
  if (cron === "0 0 * * 1") return "weekly";
  return "custom";
};

const timeFromCron = (cron: string, fallback = "02:00") => {
  const parts = cron.split(" ");
  if (parts.length < 2) return fallback;
  const hour = parts[1]?.padStart(2, "0") || "02";
  const minute = parts[0]?.padStart(2, "0") || "00";
  if (/^\d+$/.test(hour) && /^\d+$/.test(minute)) {
    return `${hour}:${minute}`;
  }
  return fallback;
};

const cronFromPreset = (
  preset: SchedulePreset,
  time: string,
  weekday: string,
  customCron: string,
) => {
  const [hour = "02", minute = "00"] = time.split(":");
  switch (preset) {
    case "hourly":
      return `0 * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "every6h":
      return `${minute} */6 * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`;
    case "custom":
    default:
      return customCron.trim();
  }
};

export default function ScheduleConsoleModal({
  open,
  mode,
  initialName,
  initialSchedule,
  connectionLabel,
  workspaceId,
  notificationConsoleId,
  workspaceRole,
  onClose,
  onSave,
  onRemove,
  onRunNow,
}: ScheduleConsoleModalProps) {
  const displayConsoleName =
    initialName.split("/").filter(Boolean).pop() ?? initialName;

  const [preset, setPreset] = useState<SchedulePreset>(
    presetFromCron(initialSchedule?.cron || "0 0 * * *"),
  );
  const [time, setTime] = useState(timeFromCron(initialSchedule?.cron || ""));
  const [weekday, setWeekday] = useState("1");
  const [customCron, setCustomCron] = useState(initialSchedule?.cron || "");
  const [timezone, setTimezone] = useState(
    initialSchedule?.timezone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      "UTC",
  );
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRunningNow, setIsRunningNow] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreset(presetFromCron(initialSchedule?.cron || "0 0 * * *"));
    setTime(timeFromCron(initialSchedule?.cron || ""));
    setCustomCron(initialSchedule?.cron || "");
    setTimezone(
      initialSchedule?.timezone ||
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
        "UTC",
    );
    setError(null);
  }, [open, initialSchedule]);

  const cron = useMemo(
    () => cronFromPreset(preset, time, weekday, customCron),
    [preset, time, weekday, customCron],
  );

  const previewRuns = useMemo(() => {
    try {
      if (!cron) return [];
      const interval = CronExpressionParser.parse(cron, {
        currentDate: new Date(),
        tz: timezone,
      });
      return Array.from({ length: 3 }, () =>
        interval.next().toDate().toLocaleString(),
      );
    } catch {
      return [];
    }
  }, [cron, timezone]);

  const handleSave = async () => {
    try {
      setIsSubmitting(true);
      setError(null);
      await onSave({ cron, timezone });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save schedule");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRunNow = async () => {
    if (!onRunNow) return;
    try {
      setIsRunningNow(true);
      await onRunNow();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run query");
    } finally {
      setIsRunningNow(false);
    }
  };

  const handleRemove = async () => {
    if (!onRemove) return;
    try {
      setIsRemoving(true);
      await onRemove();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to remove schedule",
      );
    } finally {
      setIsRemoving(false);
    }
  };

  const isValid = Boolean(cron.trim()) && previewRuns.length > 0;

  const title =
    mode === "create" ? "Create scheduled query" : "Update scheduled query";

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: { xs: "100%", sm: 440 },
          maxWidth: "100vw",
          display: "flex",
          flexDirection: "column",
        },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
          px: 2,
          py: 1.5,
          borderBottom: 1,
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <Typography variant="subtitle1" fontWeight={600}>
          {title}
        </Typography>
        <IconButton
          size="small"
          onClick={onClose}
          aria-label="Close schedule panel"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Box sx={{ flex: 1, overflow: "auto", px: 2, py: 2 }}>
        <Stack spacing={2.5}>
          {error && <Alert severity="error">{error}</Alert>}

          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Console
            </Typography>
            <Typography variant="body1">{displayConsoleName}</Typography>
          </Box>

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Schedule
            </Typography>
            <RadioGroup
              value={preset}
              onChange={event =>
                setPreset(event.target.value as SchedulePreset)
              }
            >
              <FormControlLabel
                value="hourly"
                control={<Radio />}
                label="Hourly"
              />
              <FormControlLabel
                value="daily"
                control={<Radio />}
                label="Daily"
              />
              <FormControlLabel
                value="every6h"
                control={<Radio />}
                label="Every 6 hours"
              />
              <FormControlLabel
                value="weekly"
                control={<Radio />}
                label="Weekly"
              />
              <FormControlLabel
                value="custom"
                control={<Radio />}
                label="Custom cron"
              />
            </RadioGroup>
          </Box>

          {preset === "weekly" && (
            <TextField
              select
              label="Weekday"
              value={weekday}
              onChange={event => setWeekday(event.target.value)}
              fullWidth
              SelectProps={{ native: true }}
            >
              <option value="0">Sunday</option>
              <option value="1">Monday</option>
              <option value="2">Tuesday</option>
              <option value="3">Wednesday</option>
              <option value="4">Thursday</option>
              <option value="5">Friday</option>
              <option value="6">Saturday</option>
            </TextField>
          )}

          {preset !== "hourly" && preset !== "custom" && (
            <TextField
              label="Time"
              type="time"
              value={time}
              onChange={event => setTime(event.target.value)}
              fullWidth
              InputLabelProps={{ shrink: true }}
            />
          )}

          {preset === "custom" && (
            <TextField
              label="Cron expression"
              value={customCron}
              onChange={event => setCustomCron(event.target.value)}
              fullWidth
            />
          )}

          <TextField
            select
            label="Timezone"
            value={timezone}
            onChange={event => setTimezone(event.target.value)}
            fullWidth
            SelectProps={{ native: true }}
          >
            {TIMEZONE_OPTIONS.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </TextField>

          <Box>
            <Typography variant="subtitle2">Next runs</Typography>
            {previewRuns.length > 0 ? (
              previewRuns.map(run => (
                <Typography key={run} variant="body2" color="text.secondary">
                  {run}
                </Typography>
              ))
            ) : (
              <Typography variant="body2" color="error">
                Invalid cron expression
              </Typography>
            )}
          </Box>

          {connectionLabel && (
            <Typography variant="body2" color="text.secondary">
              Runs against: {connectionLabel}
            </Typography>
          )}

          {workspaceId && workspaceRole && (
            <FlowRunNotificationsSection
              workspaceId={workspaceId}
              resourceType="scheduled_query"
              resourceId={notificationConsoleId}
              workspaceRole={workspaceRole}
              compact
            />
          )}
        </Stack>
      </Box>

      <Box
        sx={{
          flexShrink: 0,
          borderTop: 1,
          borderColor: "divider",
          px: 2,
          py: 1.5,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 1,
        }}
      >
        <Box>
          {mode === "update" && onRemove && (
            <Button color="error" onClick={handleRemove} disabled={isRemoving}>
              Remove schedule
            </Button>
          )}
        </Box>
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          <Button onClick={onClose}>Cancel</Button>
          {mode === "update" && onRunNow && (
            <Button onClick={handleRunNow} disabled={isRunningNow}>
              Run now
            </Button>
          )}
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!isValid || isSubmitting}
          >
            Save
          </Button>
        </Box>
      </Box>
    </Drawer>
  );
}
