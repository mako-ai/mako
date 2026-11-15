import { Controller } from "react-hook-form";
import {
  Box,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Typography,
  FormHelperText,
  Stack,
} from "@mui/material";
import type { DbFlowFormModel } from "./useDbFlowForm";

export function DbPaginationConfig({ model }: { model: DbFlowFormModel }) {
  const { control, errors, watchPaginationMode } = model;
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Pagination
      </Typography>
      <Stack spacing={2}>
        <Controller
          name="paginationConfig.mode"
          control={control}
          render={({ field }) => (
            <FormControl fullWidth>
              <InputLabel>Pagination Mode</InputLabel>
              <Select
                {...field}
                value={field.value || "offset"}
                label="Pagination Mode"
              >
                <MenuItem value="offset">Offset (LIMIT/OFFSET)</MenuItem>
                <MenuItem value="keyset">
                  Keyset (WHERE col &gt; last_value)
                </MenuItem>
              </Select>
              <FormHelperText>
                {field.value === "offset"
                  ? "Standard pagination. Works for any query but slower for large tables."
                  : "Faster for large tables (100k+ rows). Requires a unique, indexed column."}
              </FormHelperText>
            </FormControl>
          )}
        />

        {watchPaginationMode === "keyset" && (
          <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
            <Controller
              name="paginationConfig.keysetColumn"
              control={control}
              rules={{
                required:
                  watchPaginationMode === "keyset"
                    ? "Keyset column is required for keyset pagination"
                    : false,
              }}
              render={({ field }) => (
                <TextField
                  {...field}
                  value={field.value || ""}
                  label="Keyset Column"
                  placeholder="id"
                  error={!!errors.paginationConfig?.keysetColumn}
                  helperText={
                    errors.paginationConfig?.keysetColumn?.message ||
                    "Column to use for keyset pagination (e.g., id, created_at)"
                  }
                  sx={{ flex: 1 }}
                />
              )}
            />
            <Controller
              name="paginationConfig.keysetDirection"
              control={control}
              render={({ field }) => (
                <FormControl sx={{ flex: 1 }}>
                  <InputLabel>Sort Direction</InputLabel>
                  <Select
                    {...field}
                    value={field.value || "asc"}
                    label="Sort Direction"
                  >
                    <MenuItem value="asc">Ascending (ASC)</MenuItem>
                    <MenuItem value="desc">Descending (DESC)</MenuItem>
                  </Select>
                  <FormHelperText>
                    Must match ORDER BY in your query
                  </FormHelperText>
                </FormControl>
              )}
            />
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
