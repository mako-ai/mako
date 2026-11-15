import { Controller } from "react-hook-form";
import {
  Alert,
  Box,
  Button,
  IconButton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { Add as AddIcon, Delete as DeleteIcon } from "@mui/icons-material";
import {
  type TransferQuery,
  type TransferQueryField,
} from "./sync-flow-config";
import type { SyncFlowFormModel } from "./useSyncFlowForm";

export function SyncQueriesSection({ model }: { model: SyncFlowFormModel }) {
  const {
    transferQueriesSchema,
    control,
    queryFields,
    appendQuery,
    removeQuery,
    hasTransferQueries,
    requiresQueries,
  } = model;
  return (
    <>
      {/* Query-based connectors (GraphQL / PostHog) */}
      {hasTransferQueries && transferQueriesSchema && (
        <Box>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              mb: 2,
            }}
          >
            <Typography variant="subtitle2">
              {transferQueriesSchema.label || "Queries"}
            </Typography>
            <Button
              size="small"
              startIcon={<AddIcon />}
              onClick={() => {
                const defaultQuery: Record<string, unknown> = {
                  name: "",
                  query: "",
                };
                transferQueriesSchema.fields?.forEach(
                  (f: TransferQueryField) => {
                    if (f.default !== undefined) {
                      defaultQuery[f.name] = f.default;
                    } else if (f.type === "number") {
                      defaultQuery[f.name] = undefined;
                    } else {
                      defaultQuery[f.name] = "";
                    }
                  },
                );
                appendQuery(defaultQuery as unknown as TransferQuery);
              }}
            >
              Add Query
            </Button>
          </Box>
          {queryFields.length === 0 ? (
            <Alert severity="info">
              {requiresQueries
                ? "Add at least one query to define what data to sync."
                : "Optional: add HogQL queries, or sync built-in entities below (Surveys)."}
            </Alert>
          ) : (
            queryFields.map((field, index) => (
              <Box
                key={field.id}
                sx={{
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1,
                  p: 2,
                  mb: 2,
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    mb: 2,
                  }}
                >
                  <Typography variant="subtitle2">Query {index + 1}</Typography>
                  <IconButton
                    aria-label="Remove query"
                    size="small"
                    color="error"
                    onClick={() => removeQuery(index)}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Box>
                <Stack spacing={2}>
                  {transferQueriesSchema.fields?.map(
                    (schemaField: TransferQueryField) => (
                      <Controller
                        key={schemaField.name}
                        name={`queries.${index}.${schemaField.name}` as any}
                        control={control}
                        rules={{
                          required: schemaField.required
                            ? `${schemaField.label} is required`
                            : false,
                        }}
                        render={({ field: formField, fieldState }) => (
                          <TextField
                            {...formField}
                            label={schemaField.label}
                            placeholder={schemaField.placeholder}
                            error={!!fieldState.error}
                            helperText={
                              fieldState.error?.message ||
                              schemaField.helperText
                            }
                            multiline={schemaField.type === "textarea"}
                            rows={
                              schemaField.type === "textarea"
                                ? schemaField.rows || 6
                                : undefined
                            }
                            type={
                              schemaField.type === "number" ? "number" : "text"
                            }
                            size="small"
                            fullWidth
                            onChange={e =>
                              formField.onChange(
                                schemaField.type === "number"
                                  ? e.target.value
                                    ? parseInt(e.target.value)
                                    : undefined
                                  : e.target.value,
                              )
                            }
                          />
                        )}
                      />
                    ),
                  )}
                </Stack>
              </Box>
            ))
          )}
        </Box>
      )}
    </>
  );
}
