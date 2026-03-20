import React from "react";
import { Box, CircularProgress } from "@mui/material";
import { DataGridPremium } from "@mui/x-data-grid-premium";
import { useMosaicClient } from "../../dashboard-runtime/useMosaicClient";
import type { MosaicInstance } from "../../lib/mosaic";

interface MosaicDataTableProps {
  widgetId: string;
  dataSourceId?: string;
  localSql: string;
  tableConfig?: {
    columns?: string[];
    pageSize?: number;
  };
  mosaicInstance?: MosaicInstance | null;
  crossFilterEnabled?: boolean;
  crossFilterResolution?: "intersect" | "union";
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
  onError: _onError,
}) => {
  const { rows, fields, loading } = useMosaicClient({
    widgetId,
    localSql,
    dataSourceId,
    mosaicInstance: mosaicInstance ?? null,
    crossFilterEnabled,
    crossFilterResolution,
  });

  let visibleFields = fields;
  const configColumns = tableConfig?.columns;
  if (configColumns && configColumns.length > 0) {
    visibleFields = visibleFields.filter(f => configColumns.includes(f.name));
  }

  const columns = visibleFields.map(f => ({
    field: f.name,
    headerName: f.name,
    flex: 1,
    minWidth: 100,
  }));

  const gridRows = rows.map((row, idx) => ({
    ...row,
    _id: idx,
  }));

  if (loading && rows.length === 0) {
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
        rows={gridRows}
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
