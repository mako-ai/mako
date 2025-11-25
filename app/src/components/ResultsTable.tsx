import React, { useMemo, useCallback, useEffect } from "react";
import {
  Box,
  Typography,
  Snackbar,
  Alert,
  ToggleButtonGroup,
  ToggleButton,
  Tooltip,
  IconButton,
} from "@mui/material";
import {
  DataGridPremium,
  GridColDef,
  GridRenderCellParams,
} from "@mui/x-data-grid-premium";
import {
  Sheet as TableIcon,
  Braces as JsonIcon,
  ClipboardCopy as CopyIcon,
} from "lucide-react";
import Editor from "@monaco-editor/react";
import { useTheme } from "../contexts/ThemeContext";

interface QueryResult {
  results?: any; // Can be anything: array, object, primitive, etc.
  executedAt: string;
  resultCount: number;
  executionTime?: number; // Execution time in milliseconds
}

interface ResultsTableProps {
  results?: QueryResult | null;
}

const ResultsTable: React.FC<ResultsTableProps> = ({ results }) => {
  const [snackbarOpen, setSnackbarOpen] = React.useState(false);
  const [viewMode, setViewMode] = React.useState<"table" | "json">("table");
  const { effectiveMode } = useTheme();

  // Reset to table view whenever new results are received
  const executedAt = results?.executedAt;
  useEffect(() => {
    if (executedAt) {
      setViewMode("table");
    }
  }, [executedAt]); // Use executedAt as dependency to detect new query executions

  // Helper function to normalize any data into an array format
  const normalizeToArray = (data: any): any[] => {
    if (data === null || data === undefined) {
      return [];
    }

    if (Array.isArray(data)) {
      return data;
    }

    // If it's a primitive value (string, number, boolean), wrap it in an object
    if (typeof data !== "object") {
      return [{ value: data }];
    }

    // If it's a single object, wrap it in an array
    return [data];
  };

  const { columns, rows } = useMemo(() => {
    if (!results || results.results === null || results.results === undefined) {
      return { columns: [], rows: [] };
    }

    // Normalize results to array format
    const normalizedResults = normalizeToArray(results.results);

    if (normalizedResults.length === 0) {
      return { columns: [], rows: [] };
    }

    // Generate columns from the first 10 results (or all if fewer than 10)
    const sampleResults = normalizedResults.slice(0, 100);
    const allKeys = new Set<string>();

    // Collect all unique keys from the sample results
    sampleResults.forEach(result => {
      if (result && typeof result === "object" && !Array.isArray(result)) {
        Object.keys(result).forEach(key => allKeys.add(key));
      }
    });

    // Function to check if a key starts with a number
    const startsWithNumber = (key: string): boolean => {
      return /^\d/.test(key.trim());
    };

    // Separate keys that start with numbers from those that don't
    const allKeysArray = Array.from(allKeys);
    const numericKeys = allKeysArray.filter(startsWithNumber);
    const sortedNumericKeys = numericKeys.sort();
    const alphabeticKeys = allKeysArray.filter(key => !startsWithNumber(key));

    // Combine alphabetic keys first, then numeric keys
    const orderedKeys = [...alphabeticKeys, ...sortedNumericKeys];

    const cols: GridColDef[] = orderedKeys.map(key => {
      // Check if this column contains numeric values by sampling the first few rows
      const sampleValues = sampleResults
        .map(row => row?.[key])
        .filter(value => value !== undefined);

      const isNumericColumn = sampleValues.every(
        value =>
          value === null ||
          (typeof value === "number" && !isNaN(value)) ||
          (typeof value === "string" &&
            !isNaN(Number(value)) &&
            value.trim() !== ""),
      );

      // Calculate column width based on content length
      const getDisplayLength = (value: unknown): number => {
        if (value === null || value === undefined) return 4; // "null"
        if (typeof value === "object") return JSON.stringify(value).length;
        return String(value).length;
      };

      // Get max content length from sample (header included)
      const contentLengths = sampleValues.map(getDisplayLength);
      const headerLength = key.length;
      const maxContentLength = Math.max(headerLength, ...contentLengths, 0);

      // Calculate width: ~8px per character + 24px padding, capped at 400px
      const calculatedWidth = Math.min(
        Math.max(maxContentLength * 8 + 24, 60), // min 60px
        400, // max 400px
      );

      return {
        field: key,
        headerName: key,
        width: calculatedWidth,
        align: isNumericColumn ? "right" : "left",
        headerAlign: isNumericColumn ? "right" : "left",
        renderCell: params => {
          const value = params.value;
          if (typeof value === "undefined") {
            return undefined;
          }
          if (value === null) {
            return null;
          }
          if (typeof value === "object" && value !== null) {
            return JSON.stringify(value);
          }
          return String(value);
        },
      };
    });

    // Prepend index column on the far left
    cols.unshift({
      field: "__rowIndex",
      headerName: "#",
      width: 50,
      minWidth: 50,
      maxWidth: 50,
      sortable: false,
      filterable: false,
      disableColumnMenu: true,
      disableReorder: true,
      resizable: false,
      align: "right",
      headerAlign: "right",
      renderCell: (params: GridRenderCellParams<any, any>) => {
        const api: any = (params as any).api;
        const i = api.getRowIndexRelativeToVisibleRows(params.id as any);
        return typeof i === "number" ? i + 1 : "";
      },
    });

    // Generate rows with unique IDs
    const idMap = new Map<string, number>();
    const rowsData = normalizedResults.map((result, index) => {
      const rowData: any = {
        ...(result && typeof result === "object" && !Array.isArray(result)
          ? result
          : { value: result }),
      };

      // Handle row ID generation
      let rowId: string | number;

      // Check if the row already has an id
      if ("id" in rowData) {
        const existingId = rowData.id;

        // Convert null/undefined to string
        if (existingId === null || existingId === undefined) {
          rowId = String(existingId); // "null" or "undefined"
        } else {
          rowId = existingId;
        }

        // Make the ID unique if we've seen it before
        const idStr = String(rowId);
        const count = idMap.get(idStr) || 0;
        if (count > 0) {
          // Append the index to make it unique
          rowId = `${idStr}_${index}`;
        }
        idMap.set(idStr, count + 1);
      } else {
        // No existing ID, use index
        rowId = index;
      }

      return {
        ...rowData,
        id: rowId,
      };
    });

    return { columns: cols, rows: rowsData };
  }, [results]);

  const copyToClipboard = useCallback(async () => {
    if (!results || results.results === null || results.results === undefined) {
      return;
    }

    const normalizedResults = normalizeToArray(results.results);
    if (normalizedResults.length === 0) {
      return;
    }

    try {
      // Get column headers
      const headers = columns
        .map(col => col.field)
        .filter(field => field !== "__rowIndex");

      // Create CSV-like format that works well with Google Sheets
      const csvContent = [
        // Header row
        headers.join("\t"),
        // Data rows
        ...normalizedResults.map(row =>
          headers
            .map(header => {
              const value =
                row && typeof row === "object" && !Array.isArray(row)
                  ? row[header]
                  : row;
              if (value === null || value === undefined) {
                return "";
              }
              if (typeof value === "object") {
                return JSON.stringify(value);
              }
              // Escape tabs and newlines for CSV compatibility
              return String(value).replace(/\t/g, " ").replace(/\n/g, " ");
            })
            .join("\t"),
        ),
      ].join("\n");

      await navigator.clipboard.writeText(csvContent);
      setSnackbarOpen(true);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
    }
  }, [results, columns]);

  const handleViewModeChange = useCallback(
    (_event: React.MouseEvent<HTMLElement>, newViewMode: "table" | "json") => {
      if (newViewMode !== null) {
        setViewMode(newViewMode);
      }
    },
    [],
  );

  const jsonContent = JSON.stringify(results, null, 2);

  if (!results) {
    return (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "text.secondary",
        }}
      >
        <Typography>Execute a query to see results here</Typography>
      </Box>
    );
  }

  // Check if results are empty using the normalizeToArray helper
  const normalizedForCheck = normalizeToArray(results.results);
  if (normalizedForCheck.length === 0) {
    return (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "text.secondary",
        }}
      >
        <Typography>No results found</Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        height: "100%",
        width: "100%",
        maxWidth: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Toolbar */}
      <Box
        sx={{
          p: 0.5,
          gap: 1,
          display: "flex",
          justifyContent: "flex-start",
          alignItems: "center",
          borderBottom: "1px solid",
          borderColor: "divider",
          backgroundColor: "background.default",
        }}
      >
        <ToggleButtonGroup
          value={viewMode}
          exclusive
          onChange={handleViewModeChange}
          size="small"
          aria-label="view mode"
        >
          <Tooltip title="Table view">
            <ToggleButton value="table" aria-label="table view">
              <TableIcon strokeWidth={1.5} size={22} />
            </ToggleButton>
          </Tooltip>
          <Tooltip title="JSON view">
            <ToggleButton value="json" aria-label="json view">
              <JsonIcon strokeWidth={1.5} size={22} />
            </ToggleButton>
          </Tooltip>
        </ToggleButtonGroup>
        <Tooltip title="Copy to clipboard">
          <IconButton
            size="small"
            onClick={copyToClipboard}
            sx={{
              minWidth: "32px",
              width: "32px",
              height: "32px",
              p: 0,
            }}
          >
            <CopyIcon strokeWidth={1.5} size={22} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Results content */}
      <Box
        sx={{
          flexGrow: 1,
          overflow: "hidden",
          width: "100%",
          maxWidth: "100%",
        }}
      >
        {viewMode === "table" ? (
          <DataGridPremium
            key={results.executedAt}
            rows={rows}
            columns={columns}
            pinnedColumns={{ left: ["__rowIndex"], right: [] }}
            density="compact"
            disableRowSelectionOnClick
            hideFooter
            columnHeaderHeight={40}
            rowHeight={40}
            style={{
              height: "100%",
              width: "auto",
            }}
            sx={{
              "& .MuiDataGrid-cell": {
                fontSize: "12px",
                fontFamily:
                  'Monaco, Menlo, "Ubuntu Mono", Consolas, "Courier New", monospace',
                overflow: "hidden",
                textOverflow: "ellipsis",
                borderRight: "1px solid",
                borderColor: "divider",
              },
              "& .MuiDataGrid-columnHeaders": {
                backgroundColor: "background.default",
                fontFamily:
                  'Monaco, Menlo, "Ubuntu Mono", Consolas, "Courier New", monospace',
              },
              "& .MuiDataGrid-columnHeader": {
                backgroundColor: "background.default",
                fontFamily:
                  'Monaco, Menlo, "Ubuntu Mono", Consolas, "Courier New", monospace',
              },
              "& .MuiDataGrid-root": {
                overflow: "hidden",
              },
              "& .MuiDataGrid-row:first-of-type .MuiDataGrid-cell": {
                borderTop: "none",
              },
              "& .MuiDataGrid-main": {
                overflow: "hidden",
                backgroundColor: "background.default",
              },
              "& .MuiDataGrid-virtualScroller": {
                overflow: "auto",
              },
              "& .MuiDataGrid-virtualScrollerContent": {
                backgroundColor: "background.paper",
              },
              borderRadius: 0,
              border: "none",
            }}
          />
        ) : (
          <Box
            sx={{
              height: "100%",
              width: "100%",
              maxWidth: "100%",
              overflow: "hidden",
            }}
          >
            <Editor
              height="100%"
              defaultLanguage="json"
              value={jsonContent}
              theme={effectiveMode === "dark" ? "vs-dark" : "vs"}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: 14,
                wordWrap: "on",
                automaticLayout: true,
              }}
            />
          </Box>
        )}
      </Box>

      {/* Footer with results info */}
      <Box
        sx={{
          p: 1,
          display: "flex",
          justifyContent: "flex-start",
          alignItems: "center",
          borderTop: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography variant="body2" color="text.secondary">
          {results.resultCount} result(s) •{" "}
          {results.executionTime !== undefined &&
            `executed in ${results.executionTime} ms at `}
          {results.executionTime === undefined && "Executed at "}
          {new Date(results.executedAt).toLocaleString()}
        </Typography>
      </Box>
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={3000}
        onClose={() => setSnackbarOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          onClose={() => setSnackbarOpen(false)}
          severity="success"
          sx={{ width: "100%" }}
        >
          Table copied to clipboard! You can now paste it in Google Sheets.
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default ResultsTable;
