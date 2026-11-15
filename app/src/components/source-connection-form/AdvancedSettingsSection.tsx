import { TextField, Box } from "@mui/material";
import { Controller } from "react-hook-form";
import type { SourceConnectionFormModel } from "./useSourceConnectionForm";

export function AdvancedSettingsSection({
  model,
}: {
  model: SourceConnectionFormModel;
}) {
  const { control, readOnly } = model;
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
        gap: 2,
      }}
    >
      <Box>
        <Controller
          name="settings_sync_batch_size"
          control={control}
          rules={{ min: 1, required: true }}
          render={({ field, fieldState }) => (
            <TextField
              {...field}
              disabled={readOnly}
              fullWidth
              label="Sync Batch Size"
              type="number"
              margin="normal"
              error={!!fieldState.error}
              helperText={
                fieldState.error ? "Must be at least 1" : "Records per batch"
              }
            />
          )}
        />
      </Box>
      <Box>
        <Controller
          name="settings_rate_limit_delay_ms"
          control={control}
          rules={{ min: 0, required: true }}
          render={({ field, fieldState }) => (
            <TextField
              {...field}
              disabled={readOnly}
              fullWidth
              label="Rate Limit Delay (ms)"
              type="number"
              margin="normal"
              error={!!fieldState.error}
              helperText={
                fieldState.error
                  ? "Cannot be negative"
                  : "Delay between API calls"
              }
            />
          )}
        />
      </Box>
      <Box>
        <Controller
          name="settings_max_retries"
          control={control}
          rules={{ min: 0, required: true }}
          render={({ field }) => (
            <TextField
              {...field}
              disabled={readOnly}
              fullWidth
              label="Max Retries"
              type="number"
              margin="normal"
            />
          )}
        />
      </Box>
      <Box>
        <Controller
          name="settings_timeout_ms"
          control={control}
          rules={{ min: 1000, required: true }}
          render={({ field }) => (
            <TextField
              {...field}
              disabled={readOnly}
              fullWidth
              label="Timeout (ms)"
              type="number"
              margin="normal"
              autoComplete="nope"
              slotProps={{
                htmlInput: {
                  min: 1000,
                  autoComplete: "nope",
                  "data-lpignore": "true",
                  "data-form-type": "other",
                },
              }}
            />
          )}
        />
      </Box>
    </Box>
  );
}
