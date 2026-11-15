import { Controller } from "react-hook-form";
import {
  Box,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Button,
  Typography,
  ToggleButtonGroup,
  ToggleButton,
  Alert,
  FormControlLabel,
  Switch,
  Stack,
  CircularProgress,
} from "@mui/material";
import {
  Save as SaveIcon,
  Schedule as ScheduleIcon,
  Add as AddIcon,
} from "@mui/icons-material";
import { FlowRunNotificationsSection } from "../FlowRunNotificationsSection";
import { SCHEDULE_PRESETS } from "../flow-form/schedule-presets";
import type { DbFlowFormModel } from "./useDbFlowForm";
import { SpacedStepActions } from "../flow-form/flow-form-styles";

export function DbScheduleStep({ model }: { model: DbFlowFormModel }) {
  const {
    currentWorkspace,
    scheduleMode,
    isSubmitting,
    currentFlowId,
    isNewMode,
    control,
    handleSubmit,
    errors,
    watchScheduleEnabled,
    watchScheduleCron,
    watchScheduleTimezone,
    canSave,
    onSubmit,
    getCronDescription,
    handleScheduleModeChange,
  } = model;
  return (
    <Stack spacing={3}>
      {/* Schedule Enable Toggle */}
      <Box>
        <Controller
          name="schedule.enabled"
          control={control}
          render={({ field }) => (
            <FormControlLabel
              control={
                <Switch checked={field.value} onChange={field.onChange} />
              }
              label={
                <Box>
                  <Typography variant="body1">
                    Enable automatic scheduling
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {field.value
                      ? "Flow will run automatically on the configured schedule"
                      : "Flow can only be run manually (no automatic schedule)"}
                  </Typography>
                </Box>
              }
            />
          )}
        />
      </Box>

      {/* Schedule Configuration - only shown when enabled */}
      {watchScheduleEnabled && (
        <>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Schedule
            </Typography>
            <ToggleButtonGroup
              value={scheduleMode}
              exclusive
              onChange={handleScheduleModeChange}
              size="small"
              fullWidth
              sx={{
                mb: 2,
                width: "100%",
                p: 0.125,
                bgcolor: "action.hover",
                borderRadius: 1,
                "& .MuiToggleButton-root": {
                  flex: 1,
                  textTransform: "none",
                  border: "none",
                  borderRadius: 0.75,
                  fontWeight: 600,
                  fontSize: "0.875rem",
                  lineHeight: 1.2,
                  minHeight: 36,
                  py: 0.5,
                },
                "& .MuiToggleButton-root.Mui-selected": {
                  bgcolor: "background.paper",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
                },
              }}
            >
              <ToggleButton value="preset">Preset</ToggleButton>
              <ToggleButton value="custom">Custom</ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
            <Box
              sx={{
                flex: scheduleMode === "preset" ? 2 : 1.5,
              }}
            >
              <Controller
                name="schedule.cron"
                control={control}
                render={({ field }) => {
                  return scheduleMode === "preset" ? (
                    <FormControl fullWidth>
                      <InputLabel>Schedule Preset</InputLabel>
                      <Select
                        {...field}
                        value={field.value || ""}
                        label="Schedule Preset"
                      >
                        {SCHEDULE_PRESETS.map(preset => (
                          <MenuItem key={preset.cron} value={preset.cron}>
                            {preset.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  ) : (
                    <TextField
                      {...field}
                      value={field.value || ""}
                      fullWidth
                      label="Cron Expression"
                      error={!!errors.schedule?.cron}
                      helperText={
                        errors.schedule?.cron?.message ||
                        "Format: minute hour day month weekday"
                      }
                      placeholder="0 * * * *"
                    />
                  );
                }}
              />
            </Box>

            <Box sx={{ flex: 1 }}>
              <Controller
                name="schedule.timezone"
                control={control}
                render={({ field }) => (
                  <TextField
                    {...field}
                    fullWidth
                    label="Timezone"
                    helperText="e.g., America/New_York"
                  />
                )}
              />
            </Box>
          </Stack>

          {/* Schedule Preview */}
          <Alert severity="info" icon={<ScheduleIcon />}>
            <Typography variant="body2">
              <strong>Schedule:</strong> {getCronDescription(watchScheduleCron)}
              {watchScheduleTimezone && ` in ${watchScheduleTimezone}`}
            </Typography>
          </Alert>
        </>
      )}

      {!watchScheduleEnabled && (
        <Alert severity="info">
          <Typography variant="body2">
            This flow will only run when triggered manually. You can enable
            automatic scheduling at any time.
          </Typography>
        </Alert>
      )}

      {currentWorkspace && (
        <FlowRunNotificationsSection
          workspaceId={currentWorkspace.id}
          resourceType="flow"
          resourceId={currentFlowId}
          workspaceRole={currentWorkspace.role}
        />
      )}

      {/* Save Button */}
      <SpacedStepActions>
        <Button
          type="submit"
          variant="contained"
          startIcon={isNewMode ? <AddIcon /> : <SaveIcon />}
          disabled={isSubmitting || !canSave}
          onClick={handleSubmit(onSubmit)}
        >
          {isSubmitting ? (
            <>
              <CircularProgress size={16} sx={{ mr: 1 }} />
              {isNewMode ? "Creating..." : "Saving..."}
            </>
          ) : isNewMode ? (
            "Create Flow"
          ) : (
            "Save Flow"
          )}
        </Button>
      </SpacedStepActions>
    </Stack>
  );
}
