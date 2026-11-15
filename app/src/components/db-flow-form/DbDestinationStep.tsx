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
  FormHelperText,
  FormControlLabel,
  Switch,
  Stack,
  CircularProgress,
} from "@mui/material";
import {
  Storage as DatabaseIcon,
  NavigateNext as NextIcon,
} from "@mui/icons-material";
import { ConnectionSelector } from "../ConnectionSelector";
import type { DbFlowFormModel } from "./useDbFlowForm";
import { SpacedStepActions } from "../flow-form/flow-form-styles";

export function DbDestinationStep({ model }: { model: DbFlowFormModel }) {
  const {
    destDatabases,
    isLoadingDestDbs,
    control,
    errors,
    watchDestConnectionId,
    openNextStep,
    isBigQueryDest,
    showSchemaField,
  } = model;
  return (
    <Stack spacing={3}>
      <Box>
        <Typography
          variant="subtitle2"
          sx={{
            mb: 1,
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          <DatabaseIcon fontSize="small" />
          Destination Database
        </Typography>
        <Stack spacing={2}>
          <Controller
            name="tableDestination.connectionId"
            control={control}
            rules={{
              required: "Destination connection is required",
            }}
            render={({ field }) => (
              <ConnectionSelector
                value={field.value}
                onChange={field.onChange}
                label="Destination Connection"
                error={!!errors.tableDestination?.connectionId}
                helperText={errors.tableDestination?.connectionId?.message}
                fullWidth
              />
            )}
          />

          {watchDestConnectionId && !isBigQueryDest && (
            <>
              {isLoadingDestDbs ? (
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 2,
                  }}
                >
                  <CircularProgress size={20} />
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    Loading databases...
                  </Typography>
                </Box>
              ) : destDatabases.length > 0 ? (
                <Controller
                  name="tableDestination.database"
                  control={control}
                  render={({ field }) => (
                    <FormControl fullWidth>
                      <InputLabel>Destination Database</InputLabel>
                      <Select {...field} label="Destination Database">
                        <MenuItem value="">
                          <em>Default</em>
                        </MenuItem>
                        {destDatabases.map(db => (
                          <MenuItem key={db.id} value={db.id}>
                            {db.label || db.id}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  )}
                />
              ) : null}
            </>
          )}

          <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
            {showSchemaField &&
              (isBigQueryDest ? (
                <Controller
                  name="tableDestination.schema"
                  control={control}
                  rules={{
                    required: "Dataset is required for BigQuery",
                  }}
                  render={({ field }) => (
                    <FormControl
                      fullWidth
                      sx={{ flex: 1 }}
                      error={!!errors.tableDestination?.schema}
                    >
                      <InputLabel>Dataset</InputLabel>
                      <Select {...field} label="Dataset">
                        {isLoadingDestDbs ? (
                          <MenuItem value="" disabled>
                            Loading datasets...
                          </MenuItem>
                        ) : destDatabases.length === 0 ? (
                          <MenuItem value="" disabled>
                            No datasets found
                          </MenuItem>
                        ) : (
                          destDatabases.map(ds => (
                            <MenuItem key={ds.id} value={ds.id}>
                              {ds.label || ds.id}
                            </MenuItem>
                          ))
                        )}
                      </Select>
                      <FormHelperText>
                        {errors.tableDestination?.schema?.message ||
                          "Select the BigQuery dataset"}
                      </FormHelperText>
                    </FormControl>
                  )}
                />
              ) : (
                <Controller
                  name="tableDestination.schema"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      label="Schema (optional)"
                      placeholder="public"
                      helperText="PostgreSQL schema name"
                      sx={{ flex: 1 }}
                    />
                  )}
                />
              ))}
            <Controller
              name="tableDestination.tableName"
              control={control}
              rules={{ required: "Table name is required" }}
              render={({ field }) => (
                <TextField
                  {...field}
                  label="Table Name"
                  placeholder="synced_users"
                  error={!!errors.tableDestination?.tableName}
                  helperText={errors.tableDestination?.tableName?.message}
                  sx={{ flex: 1 }}
                />
              )}
            />
          </Stack>

          <Controller
            name="tableDestination.createIfNotExists"
            control={control}
            render={({ field }) => (
              <FormControlLabel
                control={
                  <Switch checked={field.value} onChange={field.onChange} />
                }
                label="Create table if not exists"
              />
            )}
          />
        </Stack>
      </Box>

      <SpacedStepActions>
        <Button
          variant="contained"
          endIcon={<NextIcon />}
          onClick={() => openNextStep(1)}
        >
          Continue to Schema Mapping
        </Button>
      </SpacedStepActions>
    </Stack>
  );
}
