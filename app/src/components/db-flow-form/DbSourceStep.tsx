import { Controller } from "react-hook-form";
import {
  Box,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Button,
  Typography,
  FormHelperText,
  Stack,
  CircularProgress,
} from "@mui/material";
import {
  Storage as DatabaseIcon,
  PlayArrow as ValidateIcon,
  NavigateNext as NextIcon,
} from "@mui/icons-material";
import Editor from "../../lib/monaco/MonacoEditor";
import { EDITOR_OPTIONS } from "../../lib/monaco-presets";
import { ConnectionSelector } from "../ConnectionSelector";
import { DbQueryValidationResults } from "./DbQueryValidationResults";
import type { DbFlowFormModel } from "./useDbFlowForm";
import { SpacedStepActions } from "../flow-form/flow-form-styles";

export function DbSourceStep({ model }: { model: DbFlowFormModel }) {
  const {
    sourceDatabases,
    isLoadingSourceDbs,
    isValidating,
    validationResult,
    queryModelPath,
    monacoTheme,
    onEditorMount,
    control,
    errors,
    watchSourceConnectionId,
    watchQuery,
    openNextStep,
    isBigQuerySource,
    handleValidateQuery,
    handleMergeColumnsFromValidation,
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
          Source Database
        </Typography>
        <Stack spacing={2}>
          <Controller
            name="databaseSource.connectionId"
            control={control}
            rules={{
              required: "Source connection is required",
            }}
            render={({ field }) => (
              <ConnectionSelector
                value={field.value}
                onChange={field.onChange}
                label="Source Connection"
                error={!!errors.databaseSource?.connectionId}
                helperText={errors.databaseSource?.connectionId?.message}
                fullWidth
              />
            )}
          />

          {watchSourceConnectionId && (
            <>
              {isLoadingSourceDbs ? (
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
                    Loading {isBigQuerySource ? "datasets" : "databases"}
                    ...
                  </Typography>
                </Box>
              ) : sourceDatabases.length > 0 ? (
                <Controller
                  name="databaseSource.database"
                  control={control}
                  render={({ field }) => (
                    <FormControl fullWidth>
                      <InputLabel>
                        {isBigQuerySource
                          ? "Source Dataset"
                          : "Source Database"}
                      </InputLabel>
                      <Select
                        {...field}
                        label={
                          isBigQuerySource
                            ? "Source Dataset"
                            : "Source Database"
                        }
                      >
                        <MenuItem value="">
                          <em>Default</em>
                        </MenuItem>
                        {sourceDatabases.map(db => (
                          <MenuItem key={db.id} value={db.id}>
                            {db.label || db.id}
                          </MenuItem>
                        ))}
                      </Select>
                      <FormHelperText>
                        {isBigQuerySource
                          ? "Select the BigQuery dataset"
                          : "Select the database within this connection"}
                      </FormHelperText>
                    </FormControl>
                  )}
                />
              ) : null}
            </>
          )}

          <Controller
            name="databaseSource.query"
            control={control}
            rules={{ required: "SQL query is required" }}
            render={({ field }) => (
              <Box>
                <Typography
                  variant="body2"
                  sx={{
                    mb: 0.5,
                    color: errors.databaseSource?.query
                      ? "error.main"
                      : "text.secondary",
                  }}
                >
                  SQL Query *
                </Typography>
                <Box
                  sx={{
                    height: 200,
                    border: 1,
                    borderColor: errors.databaseSource?.query
                      ? "error.main"
                      : "divider",
                    borderRadius: 1,
                    overflow: "hidden",
                  }}
                >
                  <Editor
                    language="sql"
                    path={queryModelPath}
                    value={field.value}
                    theme={monacoTheme}
                    onChange={value => field.onChange(value || "")}
                    options={{
                      ...EDITOR_OPTIONS.code,
                      wordWrap: "on",
                      tabSize: 2,
                      padding: { top: 8, bottom: 8 },
                    }}
                    onMount={onEditorMount}
                  />
                </Box>
                <FormHelperText error={!!errors.databaseSource?.query}>
                  {errors.databaseSource?.query?.message ||
                    "Use {{limit}}, {{offset}}, {{last_sync_value}}, {{keyset_value}} for dynamic values"}
                </FormHelperText>
              </Box>
            )}
          />

          {/* Validate Query Button */}
          <Box>
            <Button
              variant="outlined"
              size="small"
              startIcon={
                isValidating ? <CircularProgress size={16} /> : <ValidateIcon />
              }
              onClick={handleValidateQuery}
              disabled={
                isValidating || !watchSourceConnectionId || !watchQuery?.trim()
              }
            >
              {isValidating ? "Validating..." : "Validate Query"}
            </Button>
          </Box>

          {/* Validation Results */}
          <DbQueryValidationResults model={model} />
        </Stack>
      </Box>

      <SpacedStepActions>
        <Button
          variant="contained"
          endIcon={<NextIcon />}
          onClick={() => {
            if (validationResult?.success && validationResult.columns) {
              handleMergeColumnsFromValidation();
            }
            openNextStep(0);
          }}
        >
          Continue to Destination
        </Button>
      </SpacedStepActions>
    </Stack>
  );
}
