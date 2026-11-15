import { Controller } from "react-hook-form";
import {
  Box,
  Checkbox,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { SCHEDULE_PRESETS } from "../flow-form/schedule-presets";
import type { SyncFlowFormModel } from "./useSyncFlowForm";
import { BorderedSection } from "../flow-form/flow-form-styles";

export function SyncScheduleTrigger({ model }: { model: SyncFlowFormModel }) {
  const {
    scheduleCronMode,
    setScheduleCronMode,
    control,
    setValue,
    watchScheduleEnabled,
    showScheduleTrigger,
    cronPresetValue,
  } = model;
  return (
    <>
      {/* Scheduled trigger. Hidden for Full Refresh on CDC
          destinations: "poll on a cron" and "periodic full
          reconcile" are the same operation there (a full
          backfill), so showing both would just be two cron
          controls for one behavior. The reconcile trigger below
          becomes the sync's single cron in that case. */}
      {showScheduleTrigger && (
        <BorderedSection>
          <Controller
            name="scheduleEnabled"
            control={control}
            render={({ field }) => (
              <FormControlLabel
                control={
                  <Checkbox
                    checked={Boolean(field.value)}
                    onChange={e => field.onChange(e.target.checked)}
                  />
                }
                label={
                  <Box>
                    <Typography variant="subtitle2">Poll</Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      Read changes from the source on a cron cadence.
                    </Typography>
                  </Box>
                }
              />
            )}
          />
          {watchScheduleEnabled && (
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={2}
              sx={{ mt: 1 }}
            >
              <FormControl size="small" fullWidth>
                <InputLabel>Cadence</InputLabel>
                <Select
                  label="Cadence"
                  value={
                    scheduleCronMode === "custom"
                      ? "__custom__"
                      : cronPresetValue
                  }
                  onChange={e => {
                    const value = e.target.value;
                    if (value === "__custom__") {
                      setScheduleCronMode("custom");
                    } else {
                      setScheduleCronMode("preset");
                      setValue("scheduleCron", value, {
                        shouldDirty: true,
                      });
                    }
                  }}
                >
                  {SCHEDULE_PRESETS.map(preset => (
                    <MenuItem key={preset.cron} value={preset.cron}>
                      {preset.label}
                    </MenuItem>
                  ))}
                  <MenuItem value="__custom__">Custom cron…</MenuItem>
                </Select>
              </FormControl>
              {scheduleCronMode === "custom" && (
                <Controller
                  name="scheduleCron"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Cron Expression"
                      placeholder="0 * * * *"
                      size="small"
                      fullWidth
                      helperText="Format: minute hour day month weekday"
                    />
                  )}
                />
              )}
              <Controller
                name="scheduleTimezone"
                control={control}
                render={({ field }) => (
                  <TextField
                    {...field}
                    label="Timezone"
                    placeholder="UTC"
                    size="small"
                    fullWidth
                  />
                )}
              />
            </Stack>
          )}
        </BorderedSection>
      )}
    </>
  );
}
