import React, { useEffect, useState, useCallback } from "react";
import { Box, CircularProgress } from "@mui/material";
import { DataGridPremium } from "@mui/x-data-grid-premium";
import { queryDuckDB } from "../../lib/duckdb";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

interface DataTableWidgetProps {
  db: AsyncDuckDB;
  localSql: string;
  tableConfig?: {
    columns?: string[];
    pageSize?: number;
  };
  onError?: (error: string) => void;
}

const DataTableWidget: React.FC<DataTableWidgetProps> = ({
  db,
  localSql,
  tableConfig,
  onError,
}) => {
  const [rows, setRows] = useState<any[]>([]);
  const [columns, setColumns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await queryDuckDB(db, localSql);

      let visibleFields = result.fields;
      if (tableConfig?.columns && tableConfig.columns.length > 0) {
        visibleFields = result.fields.filter(f =>
          tableConfig.columns!.includes(f.name),
        );
      }

      setColumns(
        visibleFields.map(f => ({
          field: f.name,
          headerName: f.name,
          flex: 1,
          minWidth: 100,
        })),
      );

      setRows(
        result.rows.map((row, idx) => ({
          ...row,
          _id: idx,
        })),
      );
    } catch (e: any) {
      onError?.(e?.message || "Table query failed");
    } finally {
      setLoading(false);
    }
  }, [db, localSql, tableConfig, onError]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
        }}
      >
        <CircularProgress size={24} />
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", width: "100%" }}>
      <DataGridPremium
        rows={rows}
        columns={columns}
        getRowId={row => row._id}
        density="compact"
        pageSizeOptions={[tableConfig?.pageSize || 25, 50, 100]}
        initialState={{
          pagination: {
            paginationModel: { pageSize: tableConfig?.pageSize || 25 },
          },
        }}
        disableRowSelectionOnClick
        sx={{
          border: "none",
          "& .MuiDataGrid-cell": { fontSize: "0.8rem" },
        }}
      />
    </Box>
  );
};

export default DataTableWidget;
