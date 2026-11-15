/**
 * Semantic-layer tools for agents: the metrics a dbt project defines for
 * MetricFlow, and the SQL MetricFlow writes for them.
 *
 *   list_metrics    — which metrics exist; with `metrics`, their definition
 *                     and what they can be grouped by
 *   compile_metric  — the SQL for a metric query (nothing runs)
 *   query_metric    — compile, then run the SELECT read-only
 *
 * Why they exist: an agent that aggregates a business metric by hand has to
 * re-derive the definition, the joins and the grain every time, and gets a
 * different number than the next agent. A metric is defined once in the dbt
 * project; these tools make every surface (the in-product agent, app
 * bindings, external MCP clients) compute it from that one definition.
 *
 * list_metrics and compile_metric read the stored semantic manifest only.
 * query_metric runs the compiled SQL through `executeQueryImpl` — the same
 * path, access checks, timeout, cancellation and query history as
 * sql_execute_query — with read access at most, whatever the caller holds.
 *
 * They are part of `createDbtServerTools`, so the in-product agent and the
 * MCP server get them through the same capability registry as every other
 * dbt tool.
 */
import { tool } from "ai";
import { Types } from "mongoose";
import {
  compileMetricSchema,
  listMetricsSchema,
  queryMetricSchema,
  type CompileMetricInput,
} from "@mako/agent-tools";
import type { QueryAccess } from "../../auth/api-key-scopes";
import type { AgentToolExecutionContext } from "../../agents/types";
import { DatabaseConnection } from "../../database/workspace-schema";
import { capList, truncateText } from "../../dbt/ontology/manifest-index";
import {
  METRICFLOW_CONNECTION_TYPES,
  MetricflowQueryError,
  compileMetricQuery,
  describeMetricGroupBys,
  metricflowDialectFor,
  type MetricflowDialect,
} from "../../dbt/semantic/metricflow.service";
import {
  searchMetrics,
  unknownMetrics,
  type CatalogMetric,
} from "../../dbt/semantic/semantic-manifest";
import {
  loadSemanticProjects,
  type SemanticProject,
} from "../../dbt/semantic/semantic-manifest.service";
import { loggers } from "../../logging";
import { getDialect } from "./shared/sql-dialects";
import { isAgentToolAbortError } from "./shared/truncation";
import { executeQueryImpl } from "./sql-tools";

const logger = loggers.api("dbt-metric-tools");

const MAX_LISTED_METRICS = 100;
const MAX_GROUP_BY_DIMENSIONS = 150;
const MAX_GROUP_BY_ENTITIES = 60;
const LIST_DESCRIPTION_CHARS = 240;
const METRIC_DESCRIPTION_CHARS = 1200;
const GROUP_BY_DESCRIPTION_CHARS = 200;

export const NO_SEMANTIC_MANIFEST =
  "No semantic manifest is stored for this workspace yet: a dbt run has to finish first (dbt_parse is enough). Until then compute the number from the dbt models: lookup_term and find_models.";

const NO_METRICS =
  "This workspace's dbt projects define no metrics yet. A metric is YAML in the dbt project (a semantic model over a dbt model, then a metric over its measures): load the dbt skill and read its semantic-layer reference to add one, then run dbt_parse. Until then compute the number from the dbt models: lookup_term and find_models.";

const TIME_GRAIN_HINT =
  "A time dimension takes any coarser grain by its suffix: metric_time__day, __week, __month, __quarter, __year.";

function toolError(error: unknown, fallback: string) {
  return {
    success: false as const,
    error: error instanceof Error ? error.message : fallback,
  };
}

function projectNote(project: SemanticProject) {
  return {
    project: project.projectName,
    projectId: project.projectId,
    source: project.source,
    environment: project.environmentName,
    ...(project.source === "latest-run"
      ? {
          note: `No production build has stored a semantic manifest yet: this is the project's latest run (environment "${project.environmentName}"), which may be a dev build. Its SQL reads that environment's relations.`,
        }
      : {}),
  };
}

function listedMetric(metric: CatalogMetric, project?: string) {
  return {
    name: metric.name,
    ...(metric.label ? { label: metric.label } : {}),
    type: metric.type,
    ...(metric.description
      ? {
          description: truncateText(metric.description, LIST_DESCRIPTION_CHARS),
        }
      : {}),
    ...(project ? { project } : {}),
  };
}

function describedMetric(metric: CatalogMetric) {
  return {
    name: metric.name,
    ...(metric.label ? { label: metric.label } : {}),
    type: metric.type,
    ...(metric.description
      ? {
          description: truncateText(
            metric.description,
            METRIC_DESCRIPTION_CHARS,
          ),
        }
      : {}),
    ...(metric.measure ? { measure: metric.measure } : {}),
    ...(metric.numerator ? { numerator: metric.numerator } : {}),
    ...(metric.denominator ? { denominator: metric.denominator } : {}),
    ...(metric.expr ? { expr: truncateText(metric.expr, 600) } : {}),
    ...(metric.inputMetrics ? { inputMetrics: metric.inputMetrics } : {}),
    ...(metric.window ? { window: metric.window } : {}),
    ...(metric.grainToDate ? { grainToDate: metric.grainToDate } : {}),
    ...(metric.filtered ? { filtered: true } : {}),
  };
}

/**
 * The one project that defines every metric asked for. Throws with what to
 * do when none or several do.
 */
function projectDefining(
  projects: SemanticProject[],
  metrics: readonly string[],
): SemanticProject {
  const defining = projects.filter(
    project => unknownMetrics(project.catalog, metrics).length === 0,
  );
  if (defining.length === 1) return defining[0];
  if (defining.length > 1) {
    throw new Error(
      `${metrics.join(", ")} ${metrics.length === 1 ? "is" : "are"} defined in several dbt projects (${defining
        .map(project => `${project.projectName}: ${project.projectId}`)
        .join("; ")}). Pass projectId.`,
    );
  }
  const known = [
    ...new Set(
      projects.flatMap(project =>
        project.catalog.metrics.map(metric => metric.name),
      ),
    ),
  ];
  if (known.length === 0) throw new Error(NO_METRICS);
  const missing =
    projects.length === 1
      ? unknownMetrics(projects[0].catalog, metrics)
      : metrics.filter(name => !known.includes(name));
  const shown = capList(known.sort(), 40);
  throw new Error(
    missing.length > 0
      ? `Unknown metric${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Defined metrics: ${shown.items.join(", ")}${shown.truncated ? `, … (${shown.total} in all; list_metrics({ query }) searches them)` : ""}.`
      : `No single dbt project defines all of: ${metrics.join(", ")}. Metrics from different projects cannot be combined in one query.`,
  );
}

export const createDbtMetricTools = (
  workspaceId: string,
  userId?: string,
  options?: {
    /** What the caller may run. query_metric never uses more than read. */
    queryAccess?: QueryAccess;
    toolExecutionContext?: AgentToolExecutionContext;
  },
) => {
  const queryAccess = options?.queryAccess ?? "write";
  const toolExecutionContext = options?.toolExecutionContext;

  /** A metric query compiled for the warehouse its project builds into. */
  const compile = async (input: CompileMetricInput) => {
    const projects = await loadSemanticProjects(workspaceId, {
      projectId: input.projectId,
    });
    if (projects.length === 0) throw new Error(NO_SEMANTIC_MANIFEST);
    const project = projectDefining(projects, input.metrics);
    if (!project.connectionId) {
      throw new Error(
        `The dbt project "${project.projectName}" has no environment "${project.environmentName}" any more, so its metrics have no warehouse to run on. Run a production build to refresh the semantic manifest.`,
      );
    }
    const connection = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(project.connectionId),
      workspaceId: new Types.ObjectId(workspaceId),
    })
      .select("name type")
      .lean();
    if (!connection) {
      throw new Error(
        `The warehouse connection of environment "${project.environmentName}" no longer exists.`,
      );
    }
    const dialect: MetricflowDialect | undefined = metricflowDialectFor(
      connection.type,
    );
    if (!dialect) {
      throw new Error(
        `MetricFlow cannot write SQL for a ${connection.type} connection ("${connection.name}"). Supported: ${METRICFLOW_CONNECTION_TYPES.join(", ")}. Compute the number from the dbt models instead: lookup_term and find_models.`,
      );
    }
    const sql = await compileMetricQuery(
      project.semanticManifestKey,
      dialect,
      {
        metrics: input.metrics,
        groupBy: input.groupBy,
        where: input.where,
        orderBy: input.orderBy,
        limit: input.limit,
        startTime: input.startTime,
        endTime: input.endTime,
      },
      toolExecutionContext?.signal,
    );
    return {
      sql,
      project,
      connectionId: project.connectionId,
      connectionName: connection.name,
      sqlDialect: getDialect(connection.type),
    };
  };

  return {
    list_metrics: tool({
      description: `The metrics the workspace's dbt projects define for MetricFlow (the semantic layer): business numbers such as revenue, active users or churn rate, each defined ONCE in the dbt project. Without \`metrics\`: every metric (or those matching \`query\`) with its label, type and description. With \`metrics\`: each one's definition and the dimensions and entities they can all be grouped by together, through the joins the project declares. Call this BEFORE writing SQL that computes a business number: when a metric exists, use query_metric or compile_metric instead of aggregating by hand. Reads metadata only; never the warehouse.`,
      inputSchema: listMetricsSchema,
      execute: async ({ query, metrics, projectId }) => {
        try {
          const projects = await loadSemanticProjects(workspaceId, {
            projectId,
          });
          if (projects.length === 0) {
            return {
              success: true as const,
              metrics: [],
              message: NO_SEMANTIC_MANIFEST,
            };
          }

          if (metrics && metrics.length > 0) {
            const project = projectDefining(projects, metrics);
            const groupBys = await describeMetricGroupBys(
              project.semanticManifestKey,
              metrics,
            );
            const byName = new Map(
              project.catalog.metrics.map(metric => [metric.name, metric]),
            );
            const dimensions = capList(
              groupBys.dimensions,
              MAX_GROUP_BY_DIMENSIONS,
            );
            const entities = capList(groupBys.entities, MAX_GROUP_BY_ENTITIES);
            return {
              success: true as const,
              ...projectNote(project),
              metrics: metrics.flatMap(name => {
                const metric = byName.get(name);
                return metric ? [describedMetric(metric)] : [];
              }),
              groupBy: {
                dimensions: dimensions.items.map(dimension => ({
                  ...dimension,
                  ...(dimension.description
                    ? {
                        description: truncateText(
                          dimension.description,
                          GROUP_BY_DESCRIPTION_CHARS,
                        ),
                      }
                    : {}),
                })),
                ...(dimensions.truncated
                  ? { dimensionsTotal: dimensions.total }
                  : {}),
                entities: entities.items,
                ...(entities.truncated
                  ? { entitiesTotal: entities.total }
                  : {}),
                timeGrains: TIME_GRAIN_HINT,
              },
              ...(project.catalog.hasTimeSpine
                ? {}
                : {
                    warning:
                      "The project declares no time spine, so cumulative metrics and joins to the time spine do not compile. The dbt skill's semantic-layer reference shows how to add one.",
                  }),
              next: "query_metric({ metrics, groupBy, where }) returns the rows; compile_metric returns the SQL for a binding or a console.",
            };
          }

          const manyProjects = projects.length > 1;
          const matched = projects.flatMap(project =>
            searchMetrics(project.catalog, query).map(metric =>
              listedMetric(
                metric,
                manyProjects ? project.projectName : undefined,
              ),
            ),
          );
          const total = projects.reduce(
            (sum, project) => sum + project.catalog.metrics.length,
            0,
          );
          if (total === 0) {
            return {
              success: true as const,
              metrics: [],
              message: NO_METRICS,
            };
          }
          const listed = capList(matched, MAX_LISTED_METRICS);
          return {
            success: true as const,
            ...(manyProjects ? {} : projectNote(projects[0])),
            metrics: listed.items,
            total: listed.total,
            ...(listed.truncated
              ? {
                  truncated: true,
                  hint: "Pass `query` to narrow the list.",
                }
              : {}),
            ...(matched.length === 0
              ? {
                  message: `No metric matches "${query}". ${total} metric${total === 1 ? " is" : "s are"} defined; call list_metrics() without a query to see them, or lookup_term / find_models to find the data another way.`,
                }
              : {
                  next: "list_metrics({ metrics: [name] }) gives a metric's definition and what it can be grouped by.",
                }),
          };
        } catch (error) {
          if (!(error instanceof MetricflowQueryError)) {
            logger.error("list_metrics failed", { error });
          }
          return toolError(error, "Failed to list metrics");
        }
      },
    }),

    compile_metric: tool({
      description: `The SQL MetricFlow writes for a metric query, in the dialect of the dbt project's warehouse. Nothing runs. Use it when the SQL itself is the deliverable: an app binding, a console, a dbt model built on a metric. Give metric names from list_metrics and, optionally, group-bys, filters, an order, a limit and a metric_time range. Returns the SQL with the connectionId it is written for. Do NOT edit the aggregation or the joins in the result: when the number is wrong, the metric's definition in the dbt project is what changes. To get rows, call query_metric instead.`,
      inputSchema: compileMetricSchema,
      execute: async input => {
        try {
          const compiled = await compile(input);
          return {
            success: true as const,
            ...projectNote(compiled.project),
            metrics: input.metrics,
            connectionId: compiled.connectionId,
            connectionName: compiled.connectionName,
            sqlDialect: compiled.sqlDialect,
            sql: compiled.sql,
            next: "Run it with sql_execute_query({ connectionId, query: sql }), or save it as a binding or console.",
          };
        } catch (error) {
          if (isAgentToolAbortError(error)) {
            return {
              success: false as const,
              error: "Compilation cancelled because the chat stopped.",
            };
          }
          if (!(error instanceof MetricflowQueryError)) {
            logger.error("compile_metric failed", { error });
          }
          return toolError(error, "Failed to compile the metric query");
        }
      },
    }),

    query_metric: tool({
      description: `Compute one or more metrics from their definition in the dbt project and return the rows: MetricFlow compiles the query (aggregation, joins, grain, ratio-of-sums), and the SELECT runs read-only on the project's warehouse connection. This is the way to answer "what was <metric> last month / by region / over time" when the metric exists: prefer it to writing the aggregation in SQL. Give metric names from list_metrics and, optionally, group-bys (e.g. "metric_time__month"), filters, an order, a limit and a metric_time range; list_metrics({ metrics }) names the valid group-bys. Returns the rows as a markdown table, fenced as untrusted data, with the SQL that produced them.`,
      inputSchema: queryMetricSchema,
      execute: async ({ maxRows, ...input }) => {
        let sql: string | undefined;
        try {
          if (queryAccess === "none") {
            return {
              success: false as const,
              error:
                "This API key does not have query access. compile_metric still returns the SQL.",
            };
          }
          const compiled = await compile(input);
          sql = compiled.sql;
          // A metric query is a SELECT: read access is all it ever needs,
          // whatever the caller holds.
          const result = await executeQueryImpl(
            compiled.connectionId,
            undefined,
            compiled.sql,
            workspaceId,
            userId,
            toolExecutionContext,
            "read",
            maxRows,
          );
          return {
            ...result,
            ...projectNote(compiled.project),
            metrics: input.metrics,
            connectionId: compiled.connectionId,
            connectionName: compiled.connectionName,
            sql: compiled.sql,
          };
        } catch (error) {
          if (isAgentToolAbortError(error)) {
            return {
              success: false as const,
              error: "Query cancelled because the chat stopped.",
            };
          }
          if (!(error instanceof MetricflowQueryError)) {
            logger.error("query_metric failed", { error });
          }
          return {
            ...toolError(error, "Failed to query the metric"),
            ...(sql ? { sql } : {}),
          };
        }
      },
    }),
  };
};
