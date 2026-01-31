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
  fields?: Array<{ name?: string; originalName?: string } | string>;
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

  // Returns field info with unique field ID (for DataGrid), data key (for row access), and display name (for headers)
  // Note: When SQL has duplicate column names (e.g., "SELECT id, created_by as id"), the row data
  // only contains one value per key (JavaScript object limitation). Both columns will show the same value.
  // This function creates unique field IDs for DataGrid while preserving the original column names for display.
  const getFieldInfo = (
    fields?: Array<{ name?: string; originalName?: string } | string>,
  ) => {
    if (!Array.isArray(fields)) return [];

    const fieldCounts = new Map<string, number>();
    return fields
      .map(field => {
        let name: string;
        if (typeof field === "string") {
          name = field;
        } else if (field && typeof field === "object" && "name" in field) {
          name = field.name ? String(field.name) : "";
        } else {
          return null;
        }

        if (!name) return null;

        // Create unique field ID for DataGrid (handles duplicate column names)
        const count = fieldCounts.get(name) || 0;
        fieldCounts.set(name, count + 1);
        const uniqueFieldId = count === 0 ? name : `${name}__${count}`;

        return {
          fieldId: uniqueFieldId, // Unique ID for DataGrid's field prop
          dataKey: name, // Key to access row data (same for duplicates - will show same value)
          displayName: name, // Original column name for header display
        };
      })
      .filter(
        (f): f is { fieldId: string; dataKey: string; displayName: string } =>
          f !== null,
      );
  };

  const { columns, rows, hasFieldColumns } = useMemo(() => {
    if (!results || results.results === null || results.results === undefined) {
      return { columns: [], rows: [], hasFieldColumns: false };
    }

    // Get field info with unique IDs for DataGrid, data keys for row access, and display names for headers
    // Note: Duplicate column names (e.g., "SELECT id, id") will show the same value due to JS object limitations
    const fieldInfo = getFieldInfo(results.fields);

    // Normalize results to array format
    const normalizedResults = normalizeToArray(results.results);

    if (normalizedResults.length === 0) {
      if (fieldInfo.length === 0) {
        return { columns: [], rows: [], hasFieldColumns: false };
      }

      // Create columns for empty result set (show headers only)
      const cols: GridColDef[] = fieldInfo.map(({ fieldId, displayName }) => ({
        field: fieldId,
        headerName: displayName,
        width: Math.min(Math.max(displayName.length * 8 + 24, 60), 400),
        align: "left" as const,
        headerAlign: "left" as const,
      }));

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
      });

      return { columns: cols, rows: [], hasFieldColumns: true };
    }

    // Generate columns from the first 100 results (or all if fewer than 100)
    const sampleResults = normalizedResults.slice(0, 100);
    const allKeys = new Set<string>();

    // Collect all unique keys from the sample results
    sampleResults.forEach(result => {
      if (result && typeof result === "object" && !Array.isArray(result)) {
        Object.keys(result).forEach(key => allKeys.add(key));
      }
    });

    // Determine column ordering:
    // 1. If fieldInfo is available, use it as the primary ordering (preserves DB column order)
    // 2. Add any additional keys found in results that aren't in fieldInfo
    // 3. If no fieldInfo, fall back to alphabetical ordering
    let orderedFields: Array<{
      fieldId: string;
      dataKey: string;
      displayName: string;
    }>;

    if (fieldInfo.length > 0) {
      // Use fieldInfo as the base ordering, then append any extra keys from data
      // Note: For duplicates, dataKey is the same, so they'll show the same value
      // Include ALL fields from fieldInfo, even if no row contains that key (e.g., columns with all NULLs)
      // The valueGetter handles missing keys by returning undefined
      const dataKeysSet = new Set(fieldInfo.map(f => f.dataKey));
      const extraKeys = Array.from(allKeys).filter(
        key => !dataKeysSet.has(key),
      );
      orderedFields = [
        ...fieldInfo,
        ...extraKeys.map(key => ({
          fieldId: key,
          dataKey: key,
          displayName: key,
        })),
      ];
    } else {
      // No fieldInfo available - fall back to alphabetical ordering
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
      orderedFields = orderedKeys.map(key => ({
        fieldId: key,
        dataKey: key,
        displayName: key,
      }));
    }

    // Create columns with unique field IDs for DataGrid
    // Note: Duplicate columns will show the same value (JS object limitation)
    const cols: GridColDef[] = orderedFields.map(
      ({ fieldId, dataKey, displayName }) => {
        // Check if this column contains numeric values by sampling the first few rows
        const sampleValues = sampleResults
          .map(row => row?.[dataKey])
          .filter(value => value !== undefined);

        const isNumericColumn =
          sampleValues.length > 0 &&
          sampleValues.every(
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
        const headerLength = displayName.length;
        const maxContentLength = Math.max(headerLength, ...contentLengths, 0);

        // Calculate width: ~8px per character + 24px padding, capped at 400px
        const calculatedWidth = Math.min(
          Math.max(maxContentLength * 8 + 24, 60), // min 60px
          400, // max 400px
        );

        return {
          field: fieldId, // Unique ID for DataGrid (e.g., "id", "id__1" for duplicates)
          headerName: displayName, // Original column name for display
          width: calculatedWidth,
          align: isNumericColumn ? "right" : "left",
          headerAlign: isNumericColumn ? "right" : "left",
          // Use valueGetter to access data by dataKey (handles duplicate column names)
          valueGetter: (_value: unknown, row: Record<string, unknown>) =>
            row[dataKey],
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
      },
    );

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
        const api = (params as GridRenderCellParams).api;
        const i = api.getRowIndexRelativeToVisibleRows(params.id);
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

    return { columns: cols, rows: rowsData, hasFieldColumns: false };
  }, [results]);

  const copyToClipboard = useCallback(async () => {
    if (!results || results.results === null || results.results === undefined) {
      return;
    }

    const normalizedResults = normalizeToArray(results.results);

    // Get column info (excluding row index column)
    // Note: For duplicate columns, both will access the same key in row data (JS object limitation)
    const columnInfo = columns
      .filter(col => col.field !== "__rowIndex")
      .map(col => ({
        headerName: col.headerName as string, // Original column name for display
        dataKey: col.headerName as string, // Original column name for row data access
      }));

    // If no data and no columns, nothing to copy
    if (normalizedResults.length === 0 && columnInfo.length === 0) {
      return;
    }

    try {
      // Create CSV-like format that works well with Google Sheets
      const csvContent = [
        // Header row (use original column names)
        columnInfo.map(c => c.headerName).join("\t"),
        // Data rows (empty array if no results)
        ...normalizedResults.map(row =>
          columnInfo
            .map(({ dataKey }) => {
              const value =
                row && typeof row === "object" && !Array.isArray(row)
                  ? row[dataKey]
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
  if (normalizedForCheck.length === 0 && !hasFieldColumns) {
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
            localeText={{ noRowsLabel: "No rows returned" }}
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
