import {
  Box,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  describeMaterializationSchedule,
  MATERIALIZATION_SCHEDULE_PRESETS,
  type MaterializationScheduleValue,
} from "../lib/materializationSchedule";

function resolveSchedulePresetKey(cron: string | null | undefined): string {
  const preset = MATERIALIZATION_SCHEDULE_PRESETS.find(
    item => item.cron === cron,
  );
  return preset?.key ?? "custom";
}

export default function MaterializationScheduleControls({
  value,
  onChange,
  disabled = false,
  title = "Automatic materialization",
  caption,
}: {
  value: MaterializationScheduleValue;
  onChange: (value: MaterializationScheduleValue) => void;
  disabled?: boolean;
  title?: string;
  caption?: string;
}) {
  const cron = value.cron ?? "0 0 * * *";
  const presetKey = resolveSchedulePresetKey(value.cron);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      <FormControlLabel
        control={
          <Switch
            checked={value.enabled}
            onChange={e =>
              onChange({
                ...value,
                enabled: e.target.checked,
                cron: e.target.checked ? cron : null,
                timezone: value.timezone || "UTC",
              })
            }
            disabled={disabled}
          />
        }
        label={title}
      />
      {caption && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
          {caption}
        </Typography>
      )}

      {value.enabled && (
        <>
          <FormControl size="small" fullWidth disabled={disabled}>
            <InputLabel>Materialization Schedule</InputLabel>
            <Select
              value={presetKey}
              label="Materialization Schedule"
              onChange={e => {
                const nextPreset = e.target.value;
                const preset = MATERIALIZATION_SCHEDULE_PRESETS.find(
                  item => item.key === nextPreset,
                );
                onChange({
                  ...value,
                  enabled: true,
                  cron: preset ? preset.cron : cron,
                  timezone: value.timezone || "UTC",
                });
              }}
            >
              {MATERIALIZATION_SCHEDULE_PRESETS.map(preset => (
                <MenuItem key={preset.key} value={preset.key}>
                  {preset.label}
                </MenuItem>
              ))}
              <MenuItem value="custom">Custom</MenuItem>
            </Select>
          </FormControl>

          <TextField
            label="Cron Expression"
            value={cron}
            onChange={e =>
              onChange({
                ...value,
                enabled: true,
                cron: e.target.value,
                timezone: value.timezone || "UTC",
              })
            }
            fullWidth
            size="small"
            disabled={disabled}
            helperText={describeMaterializationSchedule(value.enabled, cron)}
          />
        </>
      )}
    </Box>
  );
}
