import React, { useState } from "react";
import { Box, TextField, Typography, IconButton, Tooltip } from "@mui/material";
import { X } from "lucide-react";
import type { GlobalFilter } from "../../../store/dashboardStore";
import type { DashboardQueryExecutor } from "../../../dashboard-runtime/types";

interface DateRangeFilterProps {
  filter: GlobalFilter;
  queryExecutor: DashboardQueryExecutor;
  onChange: (value: unknown) => void;
  onRemove: () => void;
}

const DateRangeFilter: React.FC<DateRangeFilterProps> = ({
  filter,
  onChange,
  onRemove,
}) => {
  const defaultRange = filter.config?.defaultRange as
    | { start?: string; end?: string }
    | undefined;
  const [start, setStart] = useState(defaultRange?.start || "");
  const [end, setEnd] = useState(defaultRange?.end || "");

  const handleChange = (newStart: string, newEnd: string) => {
    setStart(newStart);
    setEnd(newEnd);
    onChange({ start: newStart, end: newEnd });
  };

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
        {filter.label}
      </Typography>
      <TextField
        type="date"
        size="small"
        value={start}
        onChange={e => handleChange(e.target.value, end)}
        sx={{ width: 140 }}
        slotProps={{ inputLabel: { shrink: true } }}
      />
      <Typography variant="caption" color="text.secondary">
        to
      </Typography>
      <TextField
        type="date"
        size="small"
        value={end}
        onChange={e => handleChange(start, e.target.value)}
        sx={{ width: 140 }}
        slotProps={{ inputLabel: { shrink: true } }}
      />
      <Tooltip title="Remove filter">
        <IconButton size="small" onClick={onRemove} sx={{ p: 0.25 }}>
          <X size={14} />
        </IconButton>
      </Tooltip>
    </Box>
  );
};

export default DateRangeFilter;
