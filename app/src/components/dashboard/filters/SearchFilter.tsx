import React, { useState } from "react";
import { Box, TextField, Typography, IconButton, Tooltip } from "@mui/material";
import { X } from "lucide-react";
import type { GlobalFilter } from "../../../store/dashboardStore";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

interface SearchFilterProps {
  filter: GlobalFilter;
  db: AsyncDuckDB;
  onChange: (value: unknown) => void;
  onRemove: () => void;
}

const SearchFilter: React.FC<SearchFilterProps> = ({
  filter,
  onChange,
  onRemove,
}) => {
  const [value, setValue] = useState(
    (filter.config?.defaultValue as string) || "",
  );

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
        {filter.label}
      </Typography>
      <TextField
        size="small"
        placeholder={`Search ${filter.column}...`}
        value={value}
        onChange={e => {
          setValue(e.target.value);
          onChange(e.target.value);
        }}
        sx={{ width: 160 }}
      />
      <Tooltip title="Remove filter">
        <IconButton size="small" onClick={onRemove} sx={{ p: 0.25 }}>
          <X size={14} />
        </IconButton>
      </Tooltip>
    </Box>
  );
};

export default SearchFilter;
