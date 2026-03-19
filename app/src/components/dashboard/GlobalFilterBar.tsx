import React from "react";
import { Box } from "@mui/material";
import type { GlobalFilter } from "../../store/dashboardStore";
import DateRangeFilter from "./filters/DateRangeFilter";
import SelectFilter from "./filters/SelectFilter";
import MultiSelectFilter from "./filters/MultiSelectFilter";
import SearchFilter from "./filters/SearchFilter";
import type { DashboardQueryExecutor } from "../../dashboard-runtime/types";

interface GlobalFilterBarProps {
  filters: GlobalFilter[];
  queryExecutor: DashboardQueryExecutor;
  onFilterChange: (filterId: string, value: unknown) => void;
  onRemoveFilter: (filterId: string) => void;
}

const GlobalFilterBar: React.FC<GlobalFilterBarProps> = ({
  filters,
  queryExecutor,
  onFilterChange,
  onRemoveFilter,
}) => {
  if (filters.length === 0) return null;

  const sorted = [...filters].sort((a, b) => a.layout.order - b.layout.order);

  return (
    <Box
      sx={{
        px: 2,
        py: 1,
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        borderBottom: "1px solid",
        borderColor: "divider",
        backgroundColor: "background.default",
        flexWrap: "wrap",
        minHeight: 48,
      }}
    >
      {sorted.map(filter => {
        const commonProps = {
          key: filter.id,
          filter,
          queryExecutor,
          onChange: (value: unknown) => onFilterChange(filter.id, value),
          onRemove: () => onRemoveFilter(filter.id),
        };

        switch (filter.type) {
          case "date-range":
            return <DateRangeFilter {...commonProps} />;
          case "select":
            return <SelectFilter {...commonProps} />;
          case "multi-select":
            return <MultiSelectFilter {...commonProps} />;
          case "search":
            return <SearchFilter {...commonProps} />;
          default:
            return null;
        }
      })}
    </Box>
  );
};

export default GlobalFilterBar;
