import React, { useState, useEffect } from "react";
import {
  Box,
  FormControl,
  Select,
  MenuItem,
  Typography,
  IconButton,
  Tooltip,
} from "@mui/material";
import { X } from "lucide-react";
import { queryDuckDB } from "../../../lib/duckdb";
import type { GlobalFilter } from "../../../store/dashboardStore";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

interface SelectFilterProps {
  filter: GlobalFilter;
  db: AsyncDuckDB;
  onChange: (value: unknown) => void;
  onRemove: () => void;
}

const SelectFilter: React.FC<SelectFilterProps> = ({
  filter,
  db,
  onChange,
  onRemove,
}) => {
  const [options, setOptions] = useState<string[]>(
    (filter.config?.options as string[]) || [],
  );
  const [value, setValue] = useState<string>(
    (filter.config?.defaultValue as string) || "",
  );

  useEffect(() => {
    if (options.length > 0) return;
    (async () => {
      try {
        const result = await queryDuckDB(
          db,
          `SELECT DISTINCT "${filter.column}" AS val FROM "${filter.dataSourceId}" WHERE "${filter.column}" IS NOT NULL ORDER BY val LIMIT 200`,
        );
        setOptions(result.rows.map(r => String(r.val)));
      } catch {
        // Silent — options remain empty
      }
    })();
  }, [db, filter.column, filter.dataSourceId, options.length]);

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
        {filter.label}
      </Typography>
      <FormControl size="small" sx={{ minWidth: 120 }}>
        <Select
          value={value}
          onChange={e => {
            setValue(e.target.value);
            onChange(e.target.value);
          }}
          displayEmpty
          sx={{ fontSize: "0.8rem" }}
        >
          <MenuItem value="">
            <em>All</em>
          </MenuItem>
          {options.map(opt => (
            <MenuItem key={opt} value={opt}>
              {opt}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <Tooltip title="Remove filter">
        <IconButton size="small" onClick={onRemove} sx={{ p: 0.25 }}>
          <X size={14} />
        </IconButton>
      </Tooltip>
    </Box>
  );
};

export default SelectFilter;
