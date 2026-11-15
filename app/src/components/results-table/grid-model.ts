import type {
  GridColDef,
  GridRenderCellParams,
} from "@mui/x-data-grid-premium";

export interface QueryResult {
  results?: any; // Can be anything: array, object, primitive, etc.
  executedAt: string;
  resultCount: number;
  executionTime?: number; // Execution time in milliseconds
  fields?: Array<{ name?: string; originalName?: string } | string>;
  pageInfo?: {
    pageSize: number;
    hasMore: boolean;
    nextCursor: string | null;
    returnedRows: number;
    capApplied: boolean;
  } | null;
  currentPage?: number;
}

type FieldList = QueryResult["fields"];

interface FieldInfo {
  fieldId: string;
  dataKey: string;
  displayName: string;
}

export const MONO_FONT_FAMILY =
  'Monaco, Menlo, "Ubuntu Mono", Consolas, "Courier New", monospace';

/** Normalize any result payload into an array of rows. */
export function normalizeToArray(data: any): any[] {
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
}

// Returns field info with unique field ID (for DataGrid), data key (for row access), and display name (for headers)
// Note: When SQL has duplicate column names (e.g., "SELECT id, created_by as id"), the row data
// only contains one value per key (JavaScript object limitation). Both columns will show the same value.
// This function creates unique field IDs for DataGrid while preserving the original column names for display.
export function getFieldInfo(fields?: FieldList): FieldInfo[] {
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
    .filter((f): f is FieldInfo => f !== null);
}

const ROW_INDEX_COLUMN: GridColDef = {
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
};

/** ~8px per character + 24px padding, between 60px and 400px. */
const widthForLength = (length: number) =>
  Math.min(Math.max(length * 8 + 24, 60), 400);

const displayLength = (value: unknown): number => {
  if (value === null || value === undefined) return 4; // "null"
  if (typeof value === "object") return JSON.stringify(value).length;
  return String(value).length;
};

/**
 * Column ordering: declared fields first (preserves DB column order) plus any
 * extra keys found in the data; with no declared fields, alphabetical-ish
 * (keys starting with a digit sorted last).
 */
function orderFields(fieldInfo: FieldInfo[], allKeys: Set<string>) {
  if (fieldInfo.length > 0) {
    // Include ALL declared fields, even if no row contains that key (e.g.
    // columns with all NULLs) — the valueGetter returns undefined for them.
    const dataKeysSet = new Set(fieldInfo.map(f => f.dataKey));
    const extraKeys = Array.from(allKeys).filter(key => !dataKeysSet.has(key));
    return [
      ...fieldInfo,
      ...extraKeys.map(key => ({
        fieldId: key,
        dataKey: key,
        displayName: key,
      })),
    ];
  }
  const startsWithNumber = (key: string): boolean => /^\d/.test(key.trim());
  const allKeysArray = Array.from(allKeys);
  const sortedNumericKeys = allKeysArray.filter(startsWithNumber).sort();
  const alphabeticKeys = allKeysArray.filter(key => !startsWithNumber(key));
  return [...alphabeticKeys, ...sortedNumericKeys].map(key => ({
    fieldId: key,
    dataKey: key,
    displayName: key,
  }));
}

const isNumericSample = (values: unknown[]) =>
  values.length > 0 &&
  values.every(
    value =>
      value === null ||
      (typeof value === "number" && !isNaN(value)) ||
      (typeof value === "string" &&
        !isNaN(Number(value)) &&
        value.trim() !== ""),
  );

/** Unique row ids: an existing `id` (de-duplicated with the index), else the index. */
function withRowIds(normalizedResults: any[]) {
  const idMap = new Map<string, number>();
  return normalizedResults.map((result, index) => {
    const rowData: any = {
      ...(result && typeof result === "object" && !Array.isArray(result)
        ? result
        : { value: result }),
    };

    let rowId: string | number;
    if ("id" in rowData) {
      const existingId = rowData.id;
      // Convert null/undefined to string ("null" or "undefined")
      rowId =
        existingId === null || existingId === undefined
          ? String(existingId)
          : existingId;

      // Make the ID unique if we've seen it before
      const idStr = String(rowId);
      const count = idMap.get(idStr) || 0;
      if (count > 0) {
        rowId = `${idStr}_${index}`;
      }
      idMap.set(idStr, count + 1);
    } else {
      rowId = index;
    }

    return { ...rowData, id: rowId };
  });
}

export interface GridModel {
  columns: GridColDef[];
  rows: any[];
  /** Headers known from `fields` although no row came back. */
  hasFieldColumns: boolean;
}

/** DataGrid columns + rows for a query result. */
export function buildGridModel(
  results: QueryResult | null | undefined,
): GridModel {
  if (!results || results.results === null || results.results === undefined) {
    return { columns: [], rows: [], hasFieldColumns: false };
  }

  // Note: Duplicate column names (e.g., "SELECT id, id") will show the same value due to JS object limitations
  const fieldInfo = getFieldInfo(results.fields);
  const normalizedResults = normalizeToArray(results.results);

  if (normalizedResults.length === 0) {
    if (fieldInfo.length === 0) {
      return { columns: [], rows: [], hasFieldColumns: false };
    }

    // Create columns for empty result set (show headers only)
    const cols: GridColDef[] = fieldInfo.map(({ fieldId, displayName }) => ({
      field: fieldId,
      headerName: displayName,
      width: widthForLength(displayName.length),
      align: "left" as const,
      headerAlign: "left" as const,
    }));
    cols.unshift({ ...ROW_INDEX_COLUMN });
    return { columns: cols, rows: [], hasFieldColumns: true };
  }

  // Generate columns from the first 100 results (or all if fewer than 100)
  const sampleResults = normalizedResults.slice(0, 100);
  const allKeys = new Set<string>();
  sampleResults.forEach(result => {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      Object.keys(result).forEach(key => allKeys.add(key));
    }
  });

  const cols: GridColDef[] = orderFields(fieldInfo, allKeys).map(
    ({ fieldId, dataKey, displayName }) => {
      const sampleValues = sampleResults
        .map(row => row?.[dataKey])
        .filter(value => value !== undefined);
      const isNumericColumn = isNumericSample(sampleValues);
      // Max content length from the sample (header included)
      const maxContentLength = Math.max(
        displayName.length,
        ...sampleValues.map(displayLength),
        0,
      );

      return {
        field: fieldId, // Unique ID for DataGrid (e.g., "id", "id__1" for duplicates)
        headerName: displayName, // Original column name for display
        width: widthForLength(maxContentLength),
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
    ...ROW_INDEX_COLUMN,
    renderCell: (params: GridRenderCellParams<any, any>) => {
      const api = (params as GridRenderCellParams).api;
      const i = api.getRowIndexRelativeToVisibleRows(params.id);
      return typeof i === "number" ? i + 1 : "";
    },
  });

  return {
    columns: cols,
    rows: withRowIds(normalizedResults),
    hasFieldColumns: false,
  };
}

/**
 * Tab-separated copy of the results (pastes cleanly into Google Sheets), or
 * null when there is nothing to copy.
 */
export function resultsToTsv(
  results: QueryResult | null | undefined,
  columns: GridColDef[],
): string | null {
  if (!results || results.results === null || results.results === undefined) {
    return null;
  }
  const normalizedResults = normalizeToArray(results.results);

  // Column info excluding the row index column. For duplicate columns, both
  // read the same key in row data (JS object limitation).
  const columnInfo = columns
    .filter(col => col.field !== "__rowIndex")
    .map(col => ({
      headerName: col.headerName as string,
      dataKey: col.headerName as string,
    }));

  if (normalizedResults.length === 0 && columnInfo.length === 0) {
    return null;
  }

  return [
    columnInfo.map(c => c.headerName).join("\t"),
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
}

// Map common status-like cell values to a Chip color so mobile cards read at a
// glance. Returns null for non-status values (rendered as plain text).
const STATUS_CHIP_COLORS: Record<
  string,
  "success" | "error" | "warning" | "info"
> = {
  success: "success",
  succeeded: "success",
  active: "success",
  completed: "success",
  complete: "success",
  done: "success",
  enabled: "success",
  paid: "success",
  ok: "success",
  passed: "success",
  error: "error",
  failed: "error",
  failure: "error",
  cancelled: "error",
  canceled: "error",
  rejected: "error",
  disabled: "error",
  inactive: "error",
  pending: "warning",
  processing: "warning",
  running: "warning",
  queued: "warning",
  waiting: "warning",
  draft: "info",
  new: "info",
};

export function statusChipColor(
  value: string,
): "success" | "error" | "warning" | "info" | null {
  const key = value.trim().toLowerCase();
  if (!key || key.length > 24) return null;
  return STATUS_CHIP_COLORS[key] ?? null;
}

/** A card's heading: its first column's value, else "Row N". */
export function cardTitle(titleRaw: unknown, index: number): string {
  if (titleRaw === null || titleRaw === undefined || titleRaw === "") {
    return `Row ${index + 1}`;
  }
  return typeof titleRaw === "object"
    ? JSON.stringify(titleRaw)
    : String(titleRaw);
}

/** A single scalar cell (1 row × 1 column) reads as a KPI on mobile. */
export function singleValueKpi(
  rows: any[],
  dataColumns: GridColDef[],
): { label: string; value: string } | null {
  if (rows.length !== 1 || dataColumns.length !== 1) return null;
  const col = dataColumns[0];
  const v = rows[0][col.field];
  if (v === null || v === undefined || typeof v === "object") return null;
  return { label: col.headerName ?? col.field, value: String(v) };
}
