import { Controller } from "react-hook-form";
import {
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Typography,
  Alert,
  Stack,
} from "@mui/material";
import type { DbFlowFormModel } from "./useDbFlowForm";

export function DbIncrementalConfig({ model }: { model: DbFlowFormModel }) {
  const { flows, currentFlowId, isNewMode, control, errors, watchSyncMode } =
    model;
  return (
    <>
      {watchSyncMode === "incremental" && (
        <>
          <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
            <Controller
              name="incrementalConfig.trackingColumn"
              control={control}
              rules={{
                required:
                  watchSyncMode === "incremental"
                    ? "Tracking column is required for incremental sync"
                    : false,
              }}
              render={({ field }) => (
                <TextField
                  {...field}
                  value={field.value || ""}
                  label="Tracking Column"
                  placeholder="updated_at"
                  error={!!errors.incrementalConfig?.trackingColumn}
                  helperText={
                    errors.incrementalConfig?.trackingColumn?.message ||
                    "Column to track for incremental updates"
                  }
                  sx={{ flex: 1 }}
                />
              )}
            />
            <Controller
              name="incrementalConfig.trackingType"
              control={control}
              render={({ field }) => (
                <FormControl sx={{ flex: 1 }}>
                  <InputLabel>Tracking Type</InputLabel>
                  <Select
                    {...field}
                    value={field.value || "timestamp"}
                    label="Tracking Type"
                  >
                    <MenuItem value="timestamp">Timestamp</MenuItem>
                    <MenuItem value="numeric">Numeric (ID)</MenuItem>
                  </Select>
                </FormControl>
              )}
            />
          </Stack>

          {!isNewMode &&
            currentFlowId &&
            (() => {
              const currentFlow = flows.find(f => f._id === currentFlowId);
              const lastValue = currentFlow?.incrementalConfig?.lastValue;
              const trackingCol =
                currentFlow?.incrementalConfig?.trackingColumn;

              if (lastValue && trackingCol) {
                return (
                  <Alert severity="info" sx={{ mt: 1 }}>
                    <Typography variant="body2">
                      <strong>Last synced value:</strong> {lastValue}
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{
                        color: "text.secondary",
                        mt: 0.5,
                      }}
                    >
                      Next sync will fetch rows where{" "}
                      <code
                        style={{
                          backgroundColor: "rgba(0,0,0,0.08)",
                          padding: "2px 4px",
                          borderRadius: 4,
                        }}
                      >
                        {trackingCol} &gt; &apos;{lastValue}
                        &apos;
                      </code>
                    </Typography>
                  </Alert>
                );
              }

              if (
                !lastValue &&
                currentFlow?.runCount &&
                currentFlow.runCount > 0
              ) {
                return (
                  <Alert severity="warning" sx={{ mt: 1 }}>
                    <Typography variant="body2">
                      Flow has run but no tracking value recorded. First run may
                      have synced all rows.
                    </Typography>
                  </Alert>
                );
              }

              return (
                <Alert severity="info" sx={{ mt: 1 }}>
                  <Typography variant="body2">
                    First sync will fetch all rows. Subsequent syncs will only
                    fetch new/updated records.
                  </Typography>
                </Alert>
              );
            })()}
        </>
      )}
    </>
  );
}
