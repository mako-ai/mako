import { Controller } from "react-hook-form";
import {
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Button,
  FormHelperText,
  Stack,
  Divider,
} from "@mui/material";
import { NavigateNext as NextIcon } from "@mui/icons-material";
import { DbIncrementalConfig } from "./DbIncrementalConfig";
import { DbPaginationConfig } from "./DbPaginationConfig";
import type { DbFlowFormModel } from "./useDbFlowForm";
import { SpacedStepActions } from "../flow-form/flow-form-styles";

export function DbSyncModeStep({ model }: { model: DbFlowFormModel }) {
  const { control, openNextStep } = model;
  return (
    <Stack spacing={3}>
      {/* Sync Mode Selection */}
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <Controller
          name="syncMode"
          control={control}
          render={({ field }) => (
            <FormControl sx={{ flex: 1 }}>
              <InputLabel>Sync Mode</InputLabel>
              <Select {...field} label="Sync Mode">
                <MenuItem value="full">Full Sync</MenuItem>
                <MenuItem value="incremental">Incremental Sync</MenuItem>
              </Select>
              <FormHelperText>
                {field.value === "full"
                  ? "Replace all data on each sync"
                  : "Only sync new or updated records"}
              </FormHelperText>
            </FormControl>
          )}
        />
      </Stack>

      {/* Incremental Config */}
      <DbIncrementalConfig model={model} />
      <Divider />

      {/* Conflict Resolution */}
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <Controller
          name="conflictConfig.keyColumns"
          control={control}
          render={({ field }) => (
            <TextField
              value={Array.isArray(field.value) ? field.value.join(", ") : ""}
              onChange={e => {
                const value = e.target.value;
                const columns = value
                  ? value
                      .split(",")
                      .map(k => k.trim())
                      .filter(Boolean)
                  : [];
                field.onChange(columns);
              }}
              label="Key Columns (optional)"
              placeholder="id, email"
              helperText="Comma-separated list of columns for upsert"
              sx={{ flex: 1 }}
            />
          )}
        />
        <Controller
          name="conflictConfig.strategy"
          control={control}
          render={({ field }) => (
            <FormControl sx={{ flex: 1 }}>
              <InputLabel>Conflict Strategy</InputLabel>
              <Select
                {...field}
                value={field.value || "update"}
                label="Conflict Strategy"
              >
                <MenuItem value="update">Update (update or insert)</MenuItem>
                <MenuItem value="ignore">Skip duplicates</MenuItem>
                <MenuItem value="replace">Replace entire row</MenuItem>
              </Select>
            </FormControl>
          )}
        />
      </Stack>

      {/* Batch Size */}
      <Controller
        name="batchSize"
        control={control}
        render={({ field }) => (
          <TextField
            {...field}
            type="number"
            label="Batch Size"
            helperText="Number of rows to process per batch (100-50000)"
            onChange={e => field.onChange(parseInt(e.target.value) || 2000)}
            sx={{ maxWidth: 200 }}
            slotProps={{
              htmlInput: { min: 100, max: 50000 },
            }}
          />
        )}
      />

      <Divider />

      {/* Pagination Configuration */}
      <DbPaginationConfig model={model} />

      <SpacedStepActions>
        <Button
          variant="contained"
          endIcon={<NextIcon />}
          onClick={() => openNextStep(3)}
        >
          Continue to Schedule
        </Button>
      </SpacedStepActions>
    </Stack>
  );
}
