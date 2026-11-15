import { Box, Typography, Alert, CircularProgress } from "@mui/material";
import { isFieldShown } from "./source-connection-schema";
import { DynamicField } from "./DynamicField";
import type { SourceConnectionFormModel } from "./useSourceConnectionForm";

export function ConnectionConfigSection({
  model,
}: {
  model: SourceConnectionFormModel;
}) {
  const { schema, schemaLoading, schemaError, form, watch } = model;
  return (
    <>
      {schemaLoading && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <CircularProgress size={20} />
          <Typography variant="body2">Loading schema…</Typography>
        </Box>
      )}
      {schemaError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {schemaError}
        </Alert>
      )}
      {schema &&
        schema.fields
          .filter(f => isFieldShown(f, schema.fields, watch))
          .map(f => (
            <DynamicField key={f.name} field={f} form={form} model={model} />
          ))}
      {!schemaLoading && !schema && (
        <Typography
          sx={{
            color: "text.secondary",
            mt: 2,
          }}
        >
          Select a connector type to load configuration fields.
        </Typography>
      )}
    </>
  );
}
