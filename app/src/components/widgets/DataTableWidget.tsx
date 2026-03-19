import React from "react";
import { Box, CircularProgress } from "@mui/material";
import { DataGridPremium } from "@mui/x-data-grid-premium";
import { useDashboardQuery } from "../../dashboard-runtime/useDashboardQuery";
import type { DashboardQueryExecutor } from "../../dashboard-runtime/types";

interface DataTableWidgetProps {
  queryExecutor?: DashboardQueryExecutor;
  dataSourceId?: string;
  localSql: string;
  tableConfig?: {
    columns?: string[];
    pageSize?: number;
  };
  onError?: (error: string) => void;
  filterClause?: string;
}

const DataTableWidgetComponent: React.FC<DataTableWidgetProps> = ({
  queryExecutor,
  dataSourceId,
  localSql,
  tableConfig,
  onError,
  filterClause,
}) => {
  const { result, loading, error } = useDashboardQuery({
    sql: localSql,
    dataSourceId,
    queryExecutor,
    filterClause,
    enabled: Boolean(localSql.trim()),
  });

  React.useEffect(() => {
    if (error) {
      onError?.(error);
    }
  }, [error, onError]);

  let visibleFields = result?.fields || [];
  if (tableConfig?.columns && tableConfig.columns.length > 0) {
    visibleFields = visibleFields.filter(f =>
      tableConfig.columns!.includes(f.name),
    );
  }

  const columns = visibleFields.map(f => ({
    field: f.name,
    headerName: f.name,
    flex: 1,
    minWidth: 100,
  }));

  const rows = (result?.rows || []).map((row, idx) => ({
    ...row,
    _id: idx,
  }));

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

const DataTableWidget = React.memo(DataTableWidgetComponent);
DataTableWidget.displayName = "DataTableWidget";

export default DataTableWidget;
