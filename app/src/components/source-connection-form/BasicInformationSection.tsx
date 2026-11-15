import { TextField, Box } from "@mui/material";
import { Controller } from "react-hook-form";
import type { SourceConnectionFormModel } from "./useSourceConnectionForm";

export function BasicInformationSection({
  model,
}: {
  model: SourceConnectionFormModel;
}) {
  const { control, readOnly } = model;
  return (
    <Box sx={{ mb: 3 }}>
      <Controller
        name="name"
        control={control}
        rules={{ required: true }}
        render={({ field, fieldState }) => (
          <TextField
            {...field}
            disabled={readOnly}
            fullWidth
            margin="normal"
            label="Name"
            error={!!fieldState.error}
            helperText={fieldState.error ? "Name is required" : undefined}
            name="connector_title"
          />
        )}
      />
    </Box>
  );
}
