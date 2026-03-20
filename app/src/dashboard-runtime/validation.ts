import { MakoChartSpec } from "../lib/chart-spec";
import { executeDashboardSql } from "./commands";
import { classifyDuckDBError, type DashboardErrorKind } from "./error-kinds";

function stripTrailingSemicolons(sql: string): string {
  return sql.trim().replace(/;+$/, "");
}

export async function validateDuckDBQuery(options: {
  dashboardId?: string;
  sql: string;
  dataSourceId?: string;
}): Promise<
  | { valid: true; fields: string[]; rowCount: number }
  | { valid: false; error: string; errorKind: DashboardErrorKind }
> {
  const trimmed = stripTrailingSemicolons(options.sql);
  if (!trimmed) {
    return {
      valid: false,
      error: "Query is empty",
      errorKind: "duckdb_sql_syntax",
    };
  }

  try {
    const validationSql = `SELECT * FROM (${trimmed}) AS __mako_validation LIMIT 0`;
    const result = await executeDashboardSql({
      dashboardId: options.dashboardId,
      dataSourceId: options.dataSourceId,
      sql: validationSql,
    });

    return {
      valid: true,
      fields: result.fields.map(field => field.name),
      rowCount: 0,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "DuckDB query validation failed";
    return {
      valid: false,
      error: message,
      errorKind: classifyDuckDBError(message),
    };
  }
}

export function validateVegaSpec(spec: unknown):
  | { valid: true }
  | {
      valid: false;
      errors: string[];
      errorKind: "vega_schema_invalid";
    } {
  const parsed = MakoChartSpec.safeParse(spec);
  if (parsed.success) {
    return { valid: true };
  }

  return {
    valid: false,
    errors: parsed.error.issues
      .slice(0, 10)
      .map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    errorKind: "vega_schema_invalid",
  };
}

function splitTopLevelCsv(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (const char of value) {
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (char === "(") depth += 1;
      if (char === ")") depth = Math.max(0, depth - 1);
      if (char === "," && depth === 0) {
        if (current.trim()) parts.push(current.trim());
        current = "";
        continue;
      }
    }
    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function normalizeIdentifier(value: string): string {
  return value.replace(/"/g, "").trim().toLowerCase();
}

function parseAliasedExpression(expression: string): {
  source: string;
  alias: string | null;
} {
  const asMatch = expression.match(/^(.*?)(?:\s+AS\s+)([A-Za-z_][\w$"]*)$/i);
  if (asMatch) {
    return { source: asMatch[1].trim(), alias: asMatch[2].trim() };
  }

  return { source: expression.trim(), alias: null };
}

function isAggregateExpression(expression: string): boolean {
  return /\b(count|sum|avg|mean|min|max|median|variance|stdev|q1|q3)\s*\(/i.test(
    expression,
  );
}

function isSimpleColumnReference(expression: string): boolean {
  return /^"?[A-Za-z_][\w$]*"?(?:\s*\.\s*"?[A-Za-z_][\w$]*"?)*$/.test(
    expression.trim(),
  );
}

export function validateCrossFilterWidgetSql(options: {
  sql: string;
  crossFilterEnabled: boolean;
}): string[] {
  if (!options.crossFilterEnabled) {
    return [];
  }

  const sql = stripTrailingSemicolons(options.sql);
  const selectMatch = sql.match(/select\s+([\s\S]*?)\s+from\s/i);
  if (!selectMatch) {
    return [];
  }

  const warnings: string[] = [];
  const selectExpressions = splitTopLevelCsv(selectMatch[1]);

  for (const expression of selectExpressions) {
    const { source, alias } = parseAliasedExpression(expression);
    const aggregate = isAggregateExpression(source);
    if (aggregate) {
      continue;
    }

    if (alias) {
      const normalizedSource = normalizeIdentifier(source);
      const normalizedAlias = normalizeIdentifier(alias);
      if (
        normalizedSource !== normalizedAlias &&
        isSimpleColumnReference(source)
      ) {
        warnings.push(
          `Cross-filter warning: avoid renaming dimension field "${source}" to "${alias}" in widget SQL. Keep the canonical source field name and use Vega titles/labels for presentation.`,
        );
      } else if (
        normalizedSource !== normalizedAlias &&
        !isSimpleColumnReference(source)
      ) {
        warnings.push(
          `Cross-filter warning: avoid calculated dimension "${source} AS ${alias}" in widget SQL. Move this derived field to the data source extraction layer if the widget needs cross-filtering.`,
        );
      }
      continue;
    }

    if (!isSimpleColumnReference(source)) {
      warnings.push(
        `Cross-filter warning: avoid calculated dimension "${source}" in widget SQL. Move derived dimensions to the data source extraction layer for cross-filtered widgets.`,
      );
    }
  }

  return warnings;
}
