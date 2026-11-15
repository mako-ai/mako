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
  TextField,
} from "@mui/material";
import {
  NavigateNext as NextIcon,
  Storage as DatabaseIcon,
} from "@mui/icons-material";
import type { SyncFlowFormModel } from "./useSyncFlowForm";
import { InlineRow, StepActions } from "../flow-form/flow-form-styles";

export function SyncDestinationStep({ model }: { model: SyncFlowFormModel }) {
  const {
    databases,
    availableDatabases,
    isNewMode,
    openNextStep,
    control,
    errors,
    watchDestinationId,
    isBigQueryDest,
    isCdcCapableDest,
    requiresDestinationDatabaseName,
  } = model;
  return (
    <Stack spacing={3}>
      <Controller
        name="destinationDatabaseId"
        control={control}
        rules={{ required: "Destination database is required" }}
        render={({ field }) => (
          <FormControl fullWidth error={!!errors.destinationDatabaseId}>
            <InputLabel>Destination Database</InputLabel>
            <Select
              {...field}
              label="Destination Database"
              disabled={!isNewMode}
              startAdornment={
                <DatabaseIcon sx={{ mr: 1, color: "action.active" }} />
              }
            >
              {databases.map(db => (
                <MenuItem key={db.id} value={db.id}>
                  <InlineRow>
                    {db.name}
                    <Chip label={db.type} size="small" />
                  </InlineRow>
                </MenuItem>
              ))}
            </Select>
            {errors.destinationDatabaseId && (
              <FormHelperText>
                {errors.destinationDatabaseId.message}
              </FormHelperText>
            )}
          </FormControl>
        )}
      />

      {isCdcCapableDest && (
        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          <Controller
            name="tableDestination.schema"
            control={control}
            render={({ field }) => (
              <TextField
                {...field}
                label={isBigQueryDest ? "Dataset" : "Schema / Database"}
                placeholder={isBigQueryDest ? "my_dataset" : "public"}
                fullWidth
                size="small"
                disabled={!isNewMode}
                error={!!errors.tableDestination?.schema}
                helperText={
                  errors.tableDestination?.schema?.message ||
                  (isBigQueryDest
                    ? "BigQuery dataset name"
                    : "Target schema or database name")
                }
              />
            )}
          />
          <Controller
            name="tableDestination.tablePrefix"
            control={control}
            render={({ field }) => (
              <TextField
                {...field}
                label="Table Prefix (optional)"
                placeholder="e.g. crm"
                fullWidth
                size="small"
                disabled={!isNewMode}
                helperText={
                  field.value
                    ? `Tables: ${field.value}_leads, ${field.value}_contacts, ...`
                    : "Tables: leads, contacts, ... (no prefix)"
                }
              />
            )}
          />
        </Stack>
      )}

      {requiresDestinationDatabaseName && (
        <Controller
          name="destinationDatabaseName"
          control={control}
          render={({ field }) => (
            <FormControl fullWidth>
              <InputLabel>Destination Database Name</InputLabel>
              <Select {...field} label="Destination Database Name" displayEmpty>
                <MenuItem value="">
                  <em>Select a database</em>
                </MenuItem>
                {availableDatabases.map(db => (
                  <MenuItem key={db.id} value={db.id}>
                    {db.label || db.id}
                  </MenuItem>
                ))}
              </Select>
              <FormHelperText>
                This server hosts multiple databases — pick the one that
                receives the synced records.
              </FormHelperText>
            </FormControl>
          )}
        />
      )}

      <StepActions>
        <Button
          variant="contained"
          endIcon={<NextIcon />}
          onClick={() => openNextStep(1)}
          disabled={!watchDestinationId}
        >
          Continue to Sync Configuration
        </Button>
      </StepActions>
    </Stack>
  );
}
