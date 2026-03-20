/**
 * Auto-spec generator — deterministic heuristics that produce a default
 * MakoChartSpec from column types detected in query results.
 */

import type { MakoChartSpec } from "./chart-spec";

type ColumnType = "temporal" | "quantitative" | "nominal";

interface ColumnInfo {
  name: string;
  type: ColumnType;
}

const TEMPORAL_PATTERNS =
  /^(date|time|timestamp|created|updated|modified|month|year|day|week|quarter|period|_at$|_date$|_time$)/i;

const DATE_ISO_RE = /^\d{4}-\d{2}/;

function looksLikeDate(value: unknown): boolean {
  if (value instanceof Date) return true;
  if (typeof value !== "string") return false;
  if (!DATE_ISO_RE.test(value)) return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

function isNumeric(value: unknown): boolean {
  if (typeof value === "number" && !isNaN(value)) return true;
  if (
    typeof value === "string" &&
    value.trim() !== "" &&
    !isNaN(Number(value))
  ) {
    return true;
  }
  return false;
}

function classifyColumns(
  data: Record<string, unknown>[],
  fields?: Array<{ name?: string; originalName?: string } | string>,
): ColumnInfo[] {
  const sample = data.slice(0, 100);
  if (sample.length === 0) return [];

  const columnNames: string[] = [];
  if (fields && fields.length > 0) {
    for (const f of fields) {
      const name = typeof f === "string" ? f : f?.name;
      if (name) columnNames.push(name);
    }
  }
  if (columnNames.length === 0) {
    const keySet = new Set<string>();
    for (const row of sample) {
      if (row && typeof row === "object") {
        for (const key of Object.keys(row)) keySet.add(key);
      }
    }
    columnNames.push(...keySet);
  }

  return columnNames.map(name => {
    const values = sample
      .map(row => row[name])
      .filter(v => v !== null && v !== undefined);

    if (values.length === 0) return { name, type: "nominal" };

    if (TEMPORAL_PATTERNS.test(name) && values.some(looksLikeDate)) {
      return { name, type: "temporal" };
    }

    if (values.every(looksLikeDate)) {
      return { name, type: "temporal" };
    }

    if (values.every(isNumeric)) {
      return { name, type: "quantitative" };
    }

    return { name, type: "nominal" };
  });
}

/**
 * Generate a default Vega-Lite chart spec from query result data and field metadata.
 */
export function generateAutoSpec(
  data: Record<string, unknown>[],
  fields?: Array<{ name?: string; originalName?: string } | string>,
): MakoChartSpec {
  const columns = classifyColumns(data, fields);

  const temporal = columns.filter(c => c.type === "temporal");
  const quantitative = columns.filter(c => c.type === "quantitative");
  const nominal = columns.filter(c => c.type === "nominal");

  // 1 temporal + N numeric → multi-line chart with fold
  if (temporal.length >= 1 && quantitative.length > 1) {
    const timeCol = temporal[0];
    const numCols = quantitative;

    if (numCols.length === 1) {
      return {
        mark: { type: "line", point: true, tooltip: true },
        encoding: {
          x: { field: timeCol.name, type: "temporal" },
          y: { field: numCols[0].name, type: "quantitative" },
          tooltip: [
            { field: timeCol.name, type: "temporal" },
            { field: numCols[0].name, type: "quantitative" },
          ],
        },
      } as MakoChartSpec;
    }

    return {
      transform: [
        {
          fold: numCols.map(c => c.name),
          as: ["series", "value"],
        },
      ],
      mark: { type: "line", point: true, tooltip: true },
      encoding: {
        x: { field: timeCol.name, type: "temporal" },
        y: { field: "value", type: "quantitative" },
        color: { field: "series", type: "nominal" },
        tooltip: [
          { field: timeCol.name, type: "temporal" },
          { field: "series", type: "nominal" },
          { field: "value", type: "quantitative" },
        ],
      },
    } as MakoChartSpec;
  }

  // 1 temporal + 1 numeric → line chart
  if (temporal.length >= 1 && quantitative.length === 1) {
    return {
      mark: { type: "line", point: true, tooltip: true },
      encoding: {
        x: { field: temporal[0].name, type: "temporal" },
        y: { field: quantitative[0].name, type: "quantitative" },
        tooltip: [
          { field: temporal[0].name, type: "temporal" },
          { field: quantitative[0].name, type: "quantitative" },
        ],
      },
    } as MakoChartSpec;
  }

  // 1 temporal + 1 numeric + 1 nominal → colored line chart
  if (
    temporal.length >= 1 &&
    quantitative.length === 1 &&
    nominal.length >= 1
  ) {
    return {
      mark: { type: "line", point: true, tooltip: true },
      encoding: {
        x: { field: temporal[0].name, type: "temporal" },
        y: { field: quantitative[0].name, type: "quantitative" },
        color: { field: nominal[0].name, type: "nominal" },
        tooltip: [
          { field: temporal[0].name, type: "temporal" },
          { field: quantitative[0].name, type: "quantitative" },
          { field: nominal[0].name, type: "nominal" },
        ],
      },
    } as MakoChartSpec;
  }

  // 1 categorical + 1 numeric + 1 categorical → grouped bar
  if (nominal.length >= 2 && quantitative.length >= 1) {
    return {
      mark: { type: "bar", tooltip: true },
      encoding: {
        x: { field: nominal[0].name, type: "nominal" },
        y: { field: quantitative[0].name, type: "quantitative" },
        color: { field: nominal[1].name, type: "nominal" },
        tooltip: [
          { field: nominal[0].name, type: "nominal" },
          { field: quantitative[0].name, type: "quantitative" },
          { field: nominal[1].name, type: "nominal" },
        ],
      },
    } as MakoChartSpec;
  }

  // 1 categorical + 1 numeric → bar chart
  if (nominal.length >= 1 && quantitative.length >= 1) {
    return {
      mark: { type: "bar", tooltip: true },
      encoding: {
        x: { field: nominal[0].name, type: "nominal" },
        y: { field: quantitative[0].name, type: "quantitative" },
        tooltip: [
          { field: nominal[0].name, type: "nominal" },
          { field: quantitative[0].name, type: "quantitative" },
        ],
      },
    } as MakoChartSpec;
  }

  // 2 numeric → scatter plot
  if (quantitative.length >= 2) {
    return {
      mark: { type: "point", tooltip: true },
      encoding: {
        x: { field: quantitative[0].name, type: "quantitative" },
        y: { field: quantitative[1].name, type: "quantitative" },
        tooltip: [
          { field: quantitative[0].name, type: "quantitative" },
          { field: quantitative[1].name, type: "quantitative" },
        ],
      },
    } as MakoChartSpec;
  }

  // Fallback: bar chart of first column vs count
  const firstCol = columns[0];
  if (firstCol) {
    return {
      mark: { type: "bar", tooltip: true },
      encoding: {
        x: { field: firstCol.name, type: firstCol.type },
        y: { aggregate: "count", type: "quantitative" },
      },
    } as MakoChartSpec;
  }

  // Last resort: empty bar chart
  return { mark: "bar" } as MakoChartSpec;
}
