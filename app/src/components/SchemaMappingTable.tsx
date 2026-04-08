import { useMemo } from "react";
import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Select,
  MenuItem,
  FormControl,
  Checkbox,
  Typography,
  Paper,
  Tooltip,
  IconButton,
} from "@mui/material";
import { Warning as WarningIcon } from "@mui/icons-material";

/**
 * Type coercion for schema transformation.
 *
 * This uses the SAME shape as the database/API (typeCoercions).
 * No more ColumnMapping ↔ TypeCoercion conversion!
 *
 * Fields:
 *   column      - Column name
 *   sourceType  - Original type from source database
 *   targetType  - Destination type
 *   nullable    - Whether the column can contain NULL
 *   transformer - Optional transformation function
 */
export interface TypeCoercion {
  column: string;
  sourceType?: string;
  targetType: string;
  nullable?: boolean;
  transformer?: string;
  format?: string;
  nullValue?: unknown;
}

interface SchemaMappingTableProps {
  columns: TypeCoercion[];
  onChange: (columns: TypeCoercion[]) => void;
  destinationType?: "bigquery" | "postgresql" | "clickhouse" | "mysql" | string;
  disabled?: boolean;
}

// BigQuery type options
const BIGQUERY_TYPES = [
  { value: "STRING", label: "STRING", description: "Variable-length text" },
  { value: "INT64", label: "INT64", description: "64-bit integer" },
  { value: "FLOAT64", label: "FLOAT64", description: "64-bit floating point" },
  { value: "BOOL", label: "BOOL", description: "Boolean (true/false)" },
  {
    value: "TIMESTAMP",
    label: "TIMESTAMP",
    description: "Date and time with timezone",
  },
  { value: "DATE", label: "DATE", description: "Calendar date (YYYY-MM-DD)" },
  { value: "JSON", label: "JSON", description: "JSON data" },
  { value: "BYTES", label: "BYTES", description: "Binary data" },
];

// PostgreSQL type options
const POSTGRESQL_TYPES = [
  { value: "TEXT", label: "TEXT", description: "Variable-length text" },
  { value: "VARCHAR", label: "VARCHAR", description: "Variable-length text" },
  { value: "INTEGER", label: "INTEGER", description: "32-bit integer" },
  { value: "BIGINT", label: "BIGINT", description: "64-bit integer" },
  {
    value: "NUMERIC",
    label: "NUMERIC",
    description: "Exact numeric with precision",
  },
  {
    value: "DOUBLE PRECISION",
    label: "DOUBLE PRECISION",
    description: "64-bit floating point",
  },
  { value: "BOOLEAN", label: "BOOLEAN", description: "Boolean (true/false)" },
  {
    value: "TIMESTAMP",
    label: "TIMESTAMP",
    description: "Date and time without timezone",
  },
  {
    value: "TIMESTAMPTZ",
    label: "TIMESTAMPTZ",
    description: "Date and time with timezone",
  },
  { value: "DATE", label: "DATE", description: "Calendar date" },
  { value: "JSONB", label: "JSONB", description: "Binary JSON" },
  { value: "BYTEA", label: "BYTEA", description: "Binary data" },
];

// ClickHouse type options
const CLICKHOUSE_TYPES = [
  { value: "String", label: "String", description: "Variable-length text" },
  { value: "Int64", label: "Int64", description: "64-bit integer" },
  { value: "Int32", label: "Int32", description: "32-bit integer" },
  { value: "Float64", label: "Float64", description: "64-bit floating point" },
  { value: "Bool", label: "Bool", description: "Boolean (true/false)" },
  {
    value: "DateTime64(3)",
    label: "DateTime64(3)",
    description: "Date and time with millisecond precision",
  },
  { value: "Date", label: "Date", description: "Calendar date" },
  { value: "UUID", label: "UUID", description: "UUID value" },
];

// Generic source type options (covers common types across databases)
const SOURCE_TYPES = [
  { value: "", label: "(empty)" },
  { value: "TEXT", label: "TEXT" },
  { value: "VARCHAR", label: "VARCHAR" },
  { value: "STRING", label: "STRING" },
  { value: "INTEGER", label: "INTEGER" },
  { value: "INT", label: "INT" },
  { value: "BIGINT", label: "BIGINT" },
  { value: "INT64", label: "INT64" },
  { value: "REAL", label: "REAL" },
  { value: "FLOAT", label: "FLOAT" },
  { value: "FLOAT64", label: "FLOAT64" },
  { value: "DOUBLE", label: "DOUBLE" },
  { value: "NUMERIC", label: "NUMERIC" },
  { value: "BOOLEAN", label: "BOOLEAN" },
  { value: "BOOL", label: "BOOL" },
  { value: "TIMESTAMP", label: "TIMESTAMP" },
  { value: "DATETIME", label: "DATETIME" },
  { value: "DATE", label: "DATE" },
  { value: "TIME", label: "TIME" },
  { value: "JSON", label: "JSON" },
  { value: "JSONB", label: "JSONB" },
  { value: "BLOB", label: "BLOB" },
  { value: "BYTES", label: "BYTES" },
  { value: "BYTEA", label: "BYTEA" },
];

// Transformer options
const TRANSFORMERS = [
  { value: "", label: "None" },
  { value: "lowercase", label: "Lowercase" },
  { value: "uppercase", label: "Uppercase" },
  { value: "trim", label: "Trim whitespace" },
  { value: "json_parse", label: "Parse JSON" },
  { value: "json_stringify", label: "Stringify to JSON" },
];

/**
 * Detect if a column might have a type mismatch that needs attention
 */
function detectTypeMismatch(
  sourceType: string,
  columnName: string,
): { warning: string; suggestion: string } | null {
  const upperSource = sourceType.toUpperCase();
  const lowerName = columnName.toLowerCase();

  // INTEGER column with timestamp-like name
  if (
    (upperSource === "INTEGER" || upperSource === "INT") &&
    (lowerName.endsWith("_at") ||
      lowerName.endsWith("_time") ||
      lowerName.includes("timestamp") ||
      lowerName.includes("created") ||
      lowerName.includes("updated"))
  ) {
    return {
      warning: "This looks like a Unix timestamp stored as INTEGER",
      suggestion:
        "Consider STRING to preserve value, or TIMESTAMP if converting",
    };
  }

  // TEXT column that might contain JSON
  if (
    (upperSource === "TEXT" || upperSource === "VARCHAR") &&
    (lowerName.includes("json") ||
      lowerName.includes("data") ||
      lowerName.includes("metadata") ||
      lowerName.includes("config") ||
      lowerName.includes("settings"))
  ) {
    return {
      warning: "This column might contain JSON data",
      suggestion: "Consider JSON type with json_parse transformer",
    };
  }

  return null;
}

export function SchemaMappingTable({
  columns,
  onChange,
  destinationType = "bigquery",
  disabled = false,
}: SchemaMappingTableProps) {
  // Get type options based on destination
  const typeOptions = useMemo(() => {
    if (destinationType === "postgresql") {
      return POSTGRESQL_TYPES;
    }
    if (destinationType === "clickhouse") {
      return CLICKHOUSE_TYPES;
    }
    return BIGQUERY_TYPES;
  }, [destinationType]);

  const handleSourceTypeChange = (index: number, newType: string) => {
    if (disabled) return;
    const updated = [...columns];
    updated[index] = { ...updated[index], sourceType: newType };
    onChange(updated);
  };

  const handleTargetTypeChange = (index: number, newType: string) => {
    if (disabled) return;
    const updated = [...columns];
    updated[index] = { ...updated[index], targetType: newType };
    onChange(updated);
  };

  const handleNullableChange = (index: number, nullable: boolean) => {
    if (disabled) return;
    const updated = [...columns];
    updated[index] = { ...updated[index], nullable };
    onChange(updated);
  };

  const handleTransformerChange = (
    index: number,
    transformer: string | undefined,
  ) => {
    if (disabled) return;
    const updated = [...columns];
    updated[index] = {
      ...updated[index],
      transformer: transformer || undefined,
    };
    onChange(updated);
  };

  if (columns.length === 0) {
    return (
      <Box
        sx={{
          p: 3,
          textAlign: "center",
          bgcolor: "action.hover",
          borderRadius: 1,
        }}
      >
        <Typography variant="body2" color="text.secondary">
          No columns to map. Validate your query to detect columns.
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: "bold" }}>Column</TableCell>
              <TableCell sx={{ fontWeight: "bold" }}>Source Type</TableCell>
              <TableCell sx={{ fontWeight: "bold" }}>
                Destination Type
              </TableCell>
              <TableCell sx={{ fontWeight: "bold", textAlign: "center" }}>
                Nullable
              </TableCell>
              <TableCell sx={{ fontWeight: "bold" }}>Transformer</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {columns.map((col, index) => {
              const mismatch = detectTypeMismatch(
                col.sourceType || "",
                col.column,
              );

              return (
                <TableRow
                  key={col.column}
                  sx={{
                    "&:last-child td, &:last-child th": { border: 0 },
                    bgcolor: mismatch ? "warning.50" : undefined,
                  }}
                >
                  <TableCell>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                      <Typography
                        variant="body2"
                        sx={{ fontFamily: "monospace" }}
                      >
                        {col.column}
                      </Typography>
                      {mismatch && (
                        <Tooltip
                          title={
                            <Box>
                              <Typography variant="body2" fontWeight="bold">
                                {mismatch.warning}
                              </Typography>
                              <Typography variant="caption">
                                {mismatch.suggestion}
                              </Typography>
                            </Box>
                          }
                        >
                          <IconButton size="small" sx={{ p: 0 }}>
                            <WarningIcon
                              fontSize="small"
                              sx={{ color: "warning.main" }}
                            />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Box>
                  </TableCell>
                  <TableCell>
                    <FormControl size="small" sx={{ minWidth: 120 }}>
                      <Select
                        value={col.sourceType || ""}
                        onChange={e =>
                          handleSourceTypeChange(index, e.target.value)
                        }
                        disabled={disabled}
                        displayEmpty
                        sx={{ fontSize: "0.8125rem" }}
                      >
                        {SOURCE_TYPES.map(opt => (
                          <MenuItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </TableCell>
                  <TableCell>
                    <FormControl size="small" sx={{ minWidth: 140 }}>
                      <Select
                        value={col.targetType}
                        onChange={e =>
                          handleTargetTypeChange(index, e.target.value)
                        }
                        disabled={disabled}
                        displayEmpty
                        sx={{ fontSize: "0.8125rem" }}
                      >
                        {typeOptions.map(opt => (
                          <MenuItem key={opt.value} value={opt.value}>
                            <Tooltip title={opt.description} placement="right">
                              <Box sx={{ width: "100%" }}>{opt.label}</Box>
                            </Tooltip>
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </TableCell>
                  <TableCell align="center">
                    <Checkbox
                      checked={col.nullable ?? true}
                      onChange={e =>
                        handleNullableChange(index, e.target.checked)
                      }
                      disabled={disabled}
                      size="small"
                    />
                  </TableCell>
                  <TableCell>
                    <FormControl size="small" sx={{ minWidth: 130 }}>
                      <Select
                        value={col.transformer || ""}
                        onChange={e =>
                          handleTransformerChange(index, e.target.value)
                        }
                        disabled={disabled}
                        displayEmpty
                        sx={{ fontSize: "0.8125rem" }}
                      >
                        {TRANSFORMERS.map(opt => (
                          <MenuItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

export default SchemaMappingTable;
