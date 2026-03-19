import React, { useState, useEffect } from "react";
import {
  Box,
  FormControl,
  Select,
  MenuItem,
  Typography,
  IconButton,
  Tooltip,
  Checkbox,
  ListItemText,
  OutlinedInput,
} from "@mui/material";
import { X } from "lucide-react";
import type { GlobalFilter } from "../../../store/dashboardStore";
import type { DashboardQueryExecutor } from "../../../dashboard-runtime/types";

interface MultiSelectFilterProps {
  filter: GlobalFilter;
  queryExecutor: DashboardQueryExecutor;
  onChange: (value: unknown) => void;
  onRemove: () => void;
}

const MultiSelectFilter: React.FC<MultiSelectFilterProps> = ({
  filter,
  queryExecutor,
  onChange,
  onRemove,
}) => {
  const [options, setOptions] = useState<string[]>(
    (filter.config?.options as string[]) || [],
  );
  const [selected, setSelected] = useState<string[]>(
    (filter.config?.defaultValue as string[]) || [],
  );

  useEffect(() => {
    if (options.length > 0) return;
    (async () => {
      try {
        const result = await queryExecutor(
          `SELECT DISTINCT "${filter.column}" AS val FROM {{source}} WHERE "${filter.column}" IS NOT NULL ORDER BY val LIMIT 200`,
          { dataSourceId: filter.dataSourceId },
        );
        setOptions(result.rows.map(r => String(r.val)));
      } catch {
        // Silent
      }
    })();
  }, [filter.column, filter.dataSourceId, options.length, queryExecutor]);

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
        {filter.label}
      </Typography>
      <FormControl size="small" sx={{ minWidth: 140 }}>
        <Select
          multiple
          value={selected}
          onChange={e => {
            const val = e.target.value as string[];
            setSelected(val);
            onChange(val);
          }}
          input={<OutlinedInput />}
          renderValue={sel => (sel as string[]).join(", ")}
          sx={{ fontSize: "0.8rem" }}
        >
          {options.map(opt => (
            <MenuItem key={opt} value={opt}>
              <Checkbox checked={selected.includes(opt)} size="small" />
              <ListItemText
                primary={opt}
                primaryTypographyProps={{ fontSize: "0.8rem" }}
              />
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

export default MultiSelectFilter;
