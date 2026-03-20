import React from "react";
import { Box, CircularProgress } from "@mui/material";
import { DataGridPremium } from "@mui/x-data-grid-premium";
import { useMosaicClient } from "../../dashboard-runtime/useMosaicClient";
import type {
  DashboardCrossFilterResolution,
  MosaicInstance,
} from "../../lib/mosaic";

interface MosaicDataTableProps {
  widgetId: string;
  dataSourceId: string;
  localSql: string;
  tableConfig?: {
    columns?: string[];
    pageSize?: number;
  };
  mosaicInstance?: MosaicInstance | null;
  crossFilterEnabled?: boolean;
  crossFilterResolution?: DashboardCrossFilterResolution;
  onError?: (error: string) => void;
}

const MosaicDataTableComponent: React.FC<MosaicDataTableProps> = ({
  widgetId,
  dataSourceId,
  localSql,
  tableConfig,
  mosaicInstance,
  crossFilterEnabled = true,
  crossFilterResolution = "intersect",
  onError,
}) => {
  const {
    rows: resultRows,
    fields: resultFields,
    loading,
  } = useMosaicClient({
    widgetId,
    dataSourceId,
    localSql,
    mosaicInstance,
    crossFilterEnabled,
    crossFilterResolution,
    onError,
  });

  let visibleFields = resultFields;
  if (tableConfig?.columns && tableConfig.columns.length > 0) {
    visibleFields = visibleFields.filter(field =>
      tableConfig.columns!.includes(field.name),
    );
  }

  const columns = visibleFields.map(field => ({
    field: field.name,
    headerName: field.name,
    flex: 1,
    minWidth: 100,
  }));

  const rows = resultRows.map((row, idx) => ({
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

const MosaicDataTable = React.memo(MosaicDataTableComponent);
MosaicDataTable.displayName = "MosaicDataTable";

export default MosaicDataTable;
