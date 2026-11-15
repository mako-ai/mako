import { isSyncSource } from "../../lib/source-connection-kind";
import { Controller } from "react-hook-form";
import {
  Button,
  Chip,
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import {
  DataObject as DataIcon,
  NavigateNext as NextIcon,
} from "@mui/icons-material";
import type { SyncFlowFormModel } from "./useSyncFlowForm";
import { InlineRow, StepActions } from "../flow-form/flow-form-styles";

export function SyncSourceStep({ model }: { model: SyncFlowFormModel }) {
  const {
    onSwitchToDbSync,
    webhookCapabilitiesByType,
    connectors,
    isLoadingConnectors,
    isNewMode,
    openNextStep,
    control,
    errors,
    watchDataSourceId,
  } = model;
  return (
    <Stack spacing={3}>
      <Controller
        name="dataSourceId"
        control={control}
        rules={{ required: "Source connection is required" }}
        render={({ field }) => (
          <FormControl fullWidth error={!!errors.dataSourceId}>
            <InputLabel>Source connection</InputLabel>
            <Select
              {...field}
              label="Source connection"
              startAdornment={
                <DataIcon sx={{ mr: 1, color: "action.active" }} />
              }
              disabled={isLoadingConnectors || !isNewMode}
            >
              {connectors
                .filter(
                  source =>
                    // Custom API connections are called, never
                    // synced; one already chosen stays visible.
                    isSyncSource(source.type) || source._id === field.value,
                )
                .map(source => (
                  <MenuItem key={source._id} value={source._id}>
                    <InlineRow>
                      {source.name}
                      <Chip label={source.type} size="small" />
                      {webhookCapabilitiesByType[source.type]?.supported && (
                        <Chip label="webhook" size="small" variant="outlined" />
                      )}
                    </InlineRow>
                  </MenuItem>
                ))}
            </Select>
            {errors.dataSourceId && (
              <FormHelperText>{errors.dataSourceId.message}</FormHelperText>
            )}
          </FormControl>
        )}
      />

      {isNewMode && onSwitchToDbSync && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          Syncing from a database query instead?{" "}
          <Button size="small" onClick={onSwitchToDbSync}>
            Use a database connection
          </Button>
        </Typography>
      )}

      <StepActions>
        <Button
          variant="contained"
          endIcon={<NextIcon />}
          onClick={() => openNextStep(0)}
          disabled={!watchDataSourceId}
        >
          Continue to Destination
        </Button>
      </StepActions>
    </Stack>
  );
}
