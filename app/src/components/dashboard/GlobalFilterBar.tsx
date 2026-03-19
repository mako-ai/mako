import React from "react";
import { Box } from "@mui/material";
import type { GlobalFilter } from "../../store/dashboardStore";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import DateRangeFilter from "./filters/DateRangeFilter";
import SelectFilter from "./filters/SelectFilter";
import MultiSelectFilter from "./filters/MultiSelectFilter";
import SearchFilter from "./filters/SearchFilter";

interface GlobalFilterBarProps {
  filters: GlobalFilter[];
  db: AsyncDuckDB;
  onFilterChange: (filterId: string, value: unknown) => void;
  onRemoveFilter: (filterId: string) => void;
}

const GlobalFilterBar: React.FC<GlobalFilterBarProps> = ({
  filters,
  db,
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
          db,
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
