import { MakoChartSpec } from "../lib/chart-spec";
import { buildChartRenderPlan } from "../lib/chart-render-planner";
import { executeDashboardSql } from "./commands";
import { classifyDuckDBError, type DashboardErrorKind } from "./error-kinds";

type CompileFn = (spec: any) => unknown;
let compileVegaLitePromise: Promise<CompileFn> | null = null;
function getCompileVegaLite(): Promise<CompileFn> {
  if (!compileVegaLitePromise) {
    compileVegaLitePromise = import("vega-lite").then(m => m.compile);
  }
  return compileVegaLitePromise;
}

function stripTrailingSemicolons(sql: string): string {
  return sql.trim().replace(/;+$/, "");
}

export async function validateDuckDBQuery(options: {
  dashboardId?: string;
  sql: string;
  dataSourceId?: string;
  signal?: AbortSignal;
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
      signal: options.signal,
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

export async function validateVegaSpec(spec: unknown): Promise<
  | { valid: true }
  | {
      valid: false;
      errors: string[];
      errorKind: "vega_schema_invalid" | "vega_compile_failed";
    }
> {
  const parsed = MakoChartSpec.safeParse(spec);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues
        .slice(0, 10)
        .map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
      errorKind: "vega_schema_invalid",
    };
  }

  try {
    const compile = await getCompileVegaLite();
    const renderPlan = buildChartRenderPlan({
      spec: parsed.data as Record<string, unknown>,
      data: [],
      enableSelection: false,
      activeSelection: null,
    });
    const fullSpec = {
      ...renderPlan.spec,
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
      data: { values: [] },
    };
    compile(fullSpec as any);
  } catch (e: any) {
    const message = e?.message || "Vega-Lite compilation failed";
    return {
      valid: false,
      errors: [message],
      errorKind: "vega_compile_failed",
    };
  }

  return { valid: true };
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
}): { valid: true } | { valid: false; error: string } {
  if (!options.crossFilterEnabled) {
    return { valid: true };
  }

  const sql = stripTrailingSemicolons(options.sql);
  const selectMatch = sql.match(/select\s+([\s\S]*?)\s+from\s/i);
  if (!selectMatch) {
    return { valid: true };
  }

  const selectExpressions = splitTopLevelCsv(selectMatch[1]);

  for (const expression of selectExpressions) {
    const { source, alias } = parseAliasedExpression(expression);
    if (isAggregateExpression(source)) {
      continue;
    }

    if (alias) {
      const normalizedSource = normalizeIdentifier(source);
      const normalizedAlias = normalizeIdentifier(alias);
      if (
        normalizedSource !== normalizedAlias &&
        isSimpleColumnReference(source)
      ) {
        return {
          valid: false,
          error: `Cross-filtered widget SQL must not rename dimension fields. Found "${source} AS ${alias}". Keep the canonical field name "${source}" and use Vega title/legend.title for presentation.`,
        };
      }
      if (
        normalizedSource !== normalizedAlias &&
        !isSimpleColumnReference(source)
      ) {
        return {
          valid: false,
          error: `Cross-filtered widget SQL must not create calculated dimensions. Found "${source} AS ${alias}". Add this derived field to the data source extraction query instead.`,
        };
      }
      continue;
    }

    if (!isSimpleColumnReference(source)) {
      return {
        valid: false,
        error: `Cross-filtered widget SQL must not create calculated dimensions. Found "${source}". Add derived dimensions to the data source extraction query instead.`,
      };
    }
  }

  return { valid: true };
}
