import { Controller } from "react-hook-form";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { SyncFlowFormModel } from "./useSyncFlowForm";

export function SyncReconcileTrigger({ model }: { model: SyncFlowFormModel }) {
  const {
    formTouchedRef,
    control,
    getValues,
    setValue,
    watchBackfillScheduleEnabled,
    watchSyncMode,
    watchWriteMode,
    isCdcCapableDest,
    suggestReconcile,
    showScheduleTrigger,
    reconcileDescription,
  } = model;
  return (
    <>
      {/* Periodic full reconcile trigger (CDC destinations).
          For Full Refresh, this IS the schedule (see
          showScheduleTrigger above) — the label and helper text
          reflect that instead of duplicating a second cron. */}
      {isCdcCapableDest && (
        <Box
          sx={{
            border: 1,
            borderColor:
              suggestReconcile && !watchBackfillScheduleEnabled
                ? "warning.main"
                : "divider",
            borderRadius: 1,
            p: 2,
          }}
        >
          <Controller
            name="backfillScheduleEnabled"
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
                    <Typography variant="subtitle2">
                      {showScheduleTrigger
                        ? "Full resync"
                        : "Schedule (full resync)"}
                      {suggestReconcile ? " (recommended)" : ""}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {reconcileDescription}
                      {showScheduleTrigger &&
                        " Other triggers stay active between runs."}
                    </Typography>
                  </Box>
                }
              />
            )}
          />
          {suggestReconcile && !watchBackfillScheduleEnabled && (
            <Alert
              severity="warning"
              sx={{ mt: 1 }}
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    formTouchedRef.current = true;
                    setValue("backfillScheduleEnabled", true, {
                      shouldDirty: true,
                    });
                    if (!getValues("backfillScheduleCron")) {
                      setValue("backfillScheduleCron", "0 3 * * *", {
                        shouldDirty: true,
                      });
                    }
                  }}
                >
                  Enable daily
                </Button>
              }
            >
              Incremental polls for the selected entities miss updates
              (created-only) or silently re-fetch everything. Enable a periodic
              full reconcile so the destination stays honest between webhook
              events.
            </Alert>
          )}
          {watchBackfillScheduleEnabled &&
            watchSyncMode === "incremental" &&
            watchWriteMode === "append" && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                Combined with Incremental | Append, each reconcile run appends a
                full duplicate snapshot into the history table. Consider Full
                Refresh | Append (a snapshot-per-run table) or Deduped instead.
              </Alert>
            )}
          {watchBackfillScheduleEnabled && (
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={2}
              sx={{ mt: 2 }}
            >
              <Controller
                name="backfillScheduleCron"
                control={control}
                render={({ field }) => (
                  <TextField
                    {...field}
                    label="Cron expression"
                    placeholder="0 3 * * *"
                    size="small"
                    fullWidth
                    helperText="e.g. '0 3 * * *' = daily at 03:00"
                  />
                )}
              />
              <Controller
                name="backfillScheduleTimezone"
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
        </Box>
      )}
    </>
  );
}
