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
import {
  compileMetricSchema,
  listMetricsSchema,
  queryMetricSchema,
  type CompileMetricInput,
} from "@mako/agent-tools";
import type { QueryAccess } from "../../auth/api-key-scopes";
import type { AgentToolExecutionContext } from "../../agents/types";
import { connectionsRepo } from "../../repositories/connections";
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
  type CatalogSavedQuery,
} from "../../dbt/semantic/semantic-manifest";
import {
  explainNoSemanticProjects,
  loadSemanticProjects,
  type SemanticProject,
} from "../../dbt/semantic/semantic-manifest.service";
import { loggers } from "../../logging";
import { sqlReadOnlyAccessError } from "../../services/read-only-query.service";
import { getDialect } from "./shared/sql-dialects";
import { isAgentToolAbortError } from "./shared/truncation";
import {
  AGENT_DEFAULT_ROW_LIMIT,
  appendLimitIfMissing,
  executeQueryImpl,
} from "./sql-tools";

const logger = loggers.api("dbt-metric-tools");

const MAX_LISTED_METRICS = 100;
const MAX_LISTED_SAVED_QUERIES = 30;
const MAX_GROUP_BY_DIMENSIONS = 150;
const MAX_GROUP_BY_ENTITIES = 60;
const LIST_DESCRIPTION_CHARS = 240;
const METRIC_DESCRIPTION_CHARS = 1200;
const GROUP_BY_DESCRIPTION_CHARS = 200;

export const NO_SEMANTIC_MANIFEST =
  "No semantic manifest is stored for this workspace yet: a dbt run has to finish first (dbt_parse is enough). Until then compute the number from the dbt models: lookup_term and find_models.";

/** What to say when the named environment has no run with a manifest. */
const noEnvironmentManifest = (environment: string) =>
  `The dbt environment "${environment}" exists, but none of its runs has stored a semantic manifest. Run dbt_parse in that environment (and build the models a metric reads before querying it).`;

/**
 * What to say when nothing was loaded: a name that does not exist is told
 * apart from a real project or environment with no parsed run.
 */
async function noSemanticProjectsMessage(
  workspaceId: string,
  options: { projectId?: string; environment?: string },
): Promise<string> {
  const why = await explainNoSemanticProjects(workspaceId, options);
  if (why.reason === "unknown-project") {
    return why.projects.length > 0
      ? `Unknown projectId "${options.projectId}". dbt projects in this workspace: ${why.projects
          .map(project => `${project.name} (${project.id})`)
          .join(
            ", ",
          )}. Omit projectId unless several projects define the metric.`
      : `Unknown projectId "${options.projectId}": this workspace has no dbt project.`;
  }
  if (why.reason === "unknown-environment") {
    return why.environments.length > 0
      ? `Unknown dbt environment "${options.environment}". Valid: ${why.environments.join(", ")}. Omit environment to read production.`
      : `Unknown dbt environment "${options.environment}": this workspace's dbt projects have no environment.`;
  }
  return options.environment
    ? noEnvironmentManifest(options.environment)
    : NO_SEMANTIC_MANIFEST;
}

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
    ...(project.source === "environment"
      ? {
          note: `Read from the latest run of the environment "${project.environmentName}", not from production: definitions and relations are that environment's.`,
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
    ...(metric.periodAgg ? { periodAgg: metric.periodAgg } : {}),
    ...(metric.inputs ? { inputs: metric.inputs } : {}),
    ...(metric.conversion ? { conversion: metric.conversion } : {}),
    ...(metric.fillNullsWith !== undefined
      ? { fillNullsWith: metric.fillNullsWith }
      : {}),
    ...(metric.joinToTimespine ? { joinToTimespine: true } : {}),
    ...(metric.timeGranularity
      ? { timeGranularity: metric.timeGranularity }
      : {}),
    ...(metric.filters
      ? { filters: metric.filters.map(filter => truncateText(filter, 600)) }
      : {}),
    ...(metric.filtered ? { filtered: true } : {}),
  };
}

/** A saved query as an agent can replay it with query_metric. */
function listedSavedQuery(query: CatalogSavedQuery) {
  return {
    name: query.name,
    ...(query.label ? { label: query.label } : {}),
    ...(query.description
      ? {
          description: truncateText(query.description, LIST_DESCRIPTION_CHARS),
        }
      : {}),
    metrics: query.metrics,
    ...(query.groupBy.length > 0 ? { groupBy: query.groupBy } : {}),
    ...(query.where.length > 0
      ? { where: query.where.map(filter => truncateText(filter, 600)) }
      : {}),
    ...(query.orderBy ? { orderBy: query.orderBy } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  };
}

const SAVED_QUERY_HINT =
  "A saved query is a metric query the project named: pass its metrics, groupBy and where to query_metric or compile_metric.";

/** The saved queries to return, capped, or nothing when there are none. */
function savedQueriesField(queries: CatalogSavedQuery[]) {
  if (queries.length === 0) return {};
  const shown = capList(queries, MAX_LISTED_SAVED_QUERIES);
  return {
    savedQueries: shown.items.map(listedSavedQuery),
    ...(shown.truncated ? { savedQueriesTotal: shown.total } : {}),
    savedQueriesHint: SAVED_QUERY_HINT,
  };
}

const BIGQUERY_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? UTC$/;

/**
 * One cell of a metric result, in one form whatever the column type:
 *  - a BigQuery TIMESTAMP arrives as "2026-10-12 00:00:00.000 UTC" and a
 *    DATETIME as "2026-05-01T00:00:00": the first becomes ISO 8601 too
 *    ("2026-10-12T00:00:00Z"), keeping the Z that tells them apart;
 *  - a float carries binary noise (1574958.9400000046): 15 significant
 *    digits is all a double holds exactly, so rounding to them removes the
 *    noise and nothing else. Integers are left alone.
 * Only metric results are normalised: the driver's own output feeds
 * consoles, exports and app bindings, which keep their format.
 */
export function normalizeMetricCell(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isInteger(value)) return value;
    return Number(value.toPrecision(15));
  }
  if (typeof value === "string") {
    const timestamp = BIGQUERY_TIMESTAMP.exec(value);
    if (!timestamp) return value;
    const fraction = /^\.0+$/.test(timestamp[3] ?? ".0") ? "" : timestamp[3];
    return `${timestamp[1]}T${timestamp[2]}${fraction}Z`;
  }
  return value;
}

export function normalizeMetricRows(rows: unknown[]): unknown[] {
  return rows.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        normalizeMetricCell(value),
      ]),
    );
  });
}

/** A metric_time bound as epoch ms: a date or a naive datetime, read as UTC. */
function metricTimeMs(value: string): number {
  const iso = value.trim().replace(" ", "T");
  return Date.parse(`${iso.length === 10 ? `${iso}T00:00:00` : iso}Z`);
}

/** Refuse a range that can hold no rows, before MetricFlow is started. */
function assertTimeRange(startTime?: string, endTime?: string): void {
  if (!startTime || !endTime) return;
  if (metricTimeMs(startTime) > metricTimeMs(endTime)) {
    throw new Error(
      `startTime (${startTime}) is after endTime (${endTime}): the range holds no rows. Swap them.`,
    );
  }
}

const groupByNames = (items: ReadonlyArray<{ name: string }>, max: number) => {
  const shown = capList(
    items.map(item => item.name),
    max,
  );
  return `${shown.items.join(", ")}${shown.truncated ? `, … (${shown.total} in all)` : ""}`;
};

/**
 * MetricFlow answers a group-by it cannot resolve with six suggestions.
 * This adds every group-by the metrics do take and the smallest grain of
 * metric_time, so the caller can pick without another call. Any other error
 * is returned as it is.
 */
async function withValidGroupBys(
  error: unknown,
  project: SemanticProject,
  metrics: readonly string[],
): Promise<unknown> {
  if (
    !(error instanceof MetricflowQueryError) ||
    !/group-by-item/i.test(error.message)
  ) {
    return error;
  }
  try {
    const { dimensions, entities } = await describeMetricGroupBys(
      project.semanticManifestKey,
      metrics,
    );
    if (dimensions.length === 0 && entities.length === 0) return error;
    const grain = dimensions.find(
      dimension => dimension.base === "metric_time",
    )?.grain;
    return new MetricflowQueryError(
      [
        error.message,
        `Valid group-bys for ${metrics.join(", ")} (${dimensions.length + entities.length}): ${groupByNames([...dimensions, ...entities], MAX_GROUP_BY_DIMENSIONS)}.`,
        ...(grain
          ? [
              `The smallest grain of metric_time is ${grain}: use metric_time__${grain} or a coarser one. A finer grain does not exist for ${metrics.length === 1 ? "this metric" : "these metrics"}.`,
            ]
          : []),
      ].join("\n\n"),
    );
  } catch {
    return error;
  }
}

/**
 * Metrics that share no dimension cannot be grouped together. Names what
 * each one takes alone, so the caller sees where the set splits.
 */
async function sharedNothingMessage(
  project: SemanticProject,
  metrics: readonly string[],
): Promise<string> {
  const each = await Promise.all(
    metrics.map(async name => {
      try {
        const { dimensions } = await describeMetricGroupBys(
          project.semanticManifestKey,
          [name],
        );
        return `${name}: ${dimensions.length > 0 ? groupByNames(dimensions, 8) : "no dimension"}`;
      } catch {
        return `${name}: could not be read`;
      }
    }),
  );
  return `${metrics.join(", ")} share no dimension, so they cannot be grouped in one query. Each alone takes: ${each.join("; ")}. Query them separately, or describe a subset that shares dimensions.`;
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
    /**
     * One budget for compiling AND running a metric query. Over MCP the
     * client gives up at 60s, and compile (60s) then query (60s) could
     * outlast it: the caller then saw a transport timeout, not an answer.
     */
    maxWaitMs?: number;
    toolExecutionContext?: AgentToolExecutionContext;
  },
) => {
  const queryAccess = options?.queryAccess ?? "write";
  const toolExecutionContext = options?.toolExecutionContext;
  const maxWaitMs = options?.maxWaitMs;

  /** A metric query compiled for the warehouse its project builds into. */
  const compile = async (input: CompileMetricInput, deadline?: number) => {
    assertTimeRange(input.startTime, input.endTime);
    const projects = await loadSemanticProjects(workspaceId, {
      projectId: input.projectId,
      environment: input.environment,
    });
    if (projects.length === 0) {
      throw new Error(
        await noSemanticProjectsMessage(workspaceId, {
          projectId: input.projectId,
          environment: input.environment,
        }),
      );
    }
    const project = projectDefining(projects, input.metrics);
    if (!project.connectionId) {
      throw new Error(
        `The dbt project "${project.projectName}" has no environment "${project.environmentName}" any more, so its metrics have no warehouse to run on. Run a production build to refresh the semantic manifest.`,
      );
    }
    const findConnection = (id: string) =>
      connectionsRepo.findDatabaseConnectionSummary(id, workspaceId);
    const buildConnection = await findConnection(project.connectionId);
    if (!buildConnection) {
      throw new Error(
        `The warehouse connection of environment "${project.environmentName}" no longer exists.`,
      );
    }
    // The build connection's credential can write: dbt builds with it. An
    // environment may name a read-only connection to the same warehouse,
    // and a metric query then runs on that one. A read connection that is
    // gone, or that reaches another kind of warehouse than the SQL is
    // written for, is not used.
    const readConnection = project.readConnectionId
      ? await findConnection(project.readConnectionId)
      : null;
    const useRead =
      readConnection !== null && readConnection.type === buildConnection.type;
    const connection = useRead ? readConnection : buildConnection;
    const connectionId =
      useRead && project.readConnectionId
        ? project.readConnectionId
        : project.connectionId;
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
        // MetricFlow parenthesises each filter only when there are several:
        // alone, "a = 1 or 1=1" would reach the WHERE clause bare.
        where: input.where?.map(filter => `(${filter})`),
        orderBy: input.orderBy,
        limit: input.limit,
        startTime: input.startTime,
        endTime: input.endTime,
      },
      toolExecutionContext?.signal,
      deadline === undefined ? undefined : deadline - Date.now(),
    ).catch(async error => {
      throw await withValidGroupBys(error, project, input.metrics);
    });
    // A where filter is raw SQL: the compiled statement gets the same
    // read-only check as a query that runs, so compile_metric never hands
    // back SQL that query_metric would refuse.
    const accessError = sqlReadOnlyAccessError(sql, connection.type);
    if (accessError) throw new Error(accessError);
    return {
      sql,
      project,
      connectionId,
      connectionName: connection.name,
      connectionRole: useRead ? ("read" as const) : ("build" as const),
      sqlDialect: getDialect(connection.type),
      // The database dbt built the metric's relations in: where to run when
      // the connection names no default database (Postgres).
      relationDatabase: project.catalog.semanticModels.find(
        model => model.database,
      )?.database,
    };
  };

  return {
    list_metrics: tool({
      description: `The metrics the dbt project defines (MetricFlow semantic layer): business numbers such as revenue or churn rate, each defined once. Without \`metrics\`: all of them, or those matching \`query\`. With \`metrics\`: their definition and the dimensions and entities they can be grouped by together. Call it BEFORE writing SQL for a business number: when a metric exists, do not aggregate by hand: use query_metric for the rows or compile_metric for the SQL, whichever tool you have. Metadata only.`,
      inputSchema: listMetricsSchema,
      execute: async ({ query, metrics, projectId, environment }) => {
        try {
          const projects = await loadSemanticProjects(workspaceId, {
            projectId,
            environment,
          });
          if (projects.length === 0) {
            return {
              success: true as const,
              metrics: [],
              message: await noSemanticProjectsMessage(workspaceId, {
                projectId,
                environment,
              }),
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
              ...savedQueriesField(
                project.catalog.savedQueries.filter(saved =>
                  saved.metrics.some(name => metrics.includes(name)),
                ),
              ),
              ...(metrics.length > 1 && groupBys.dimensions.length === 0
                ? { message: await sharedNothingMessage(project, metrics) }
                : {}),
              ...(project.catalog.hasTimeSpine
                ? {}
                : {
                    warning:
                      "The project declares no time spine, so cumulative metrics and joins to the time spine do not compile. The dbt skill's semantic-layer reference shows how to add one.",
                  }),
              next: "query_metric({ metrics, groupBy, where }) returns the rows; compile_metric returns the SQL for a binding or a console. Use the one you have.",
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
            ...(query
              ? {}
              : savedQueriesField(
                  projects.flatMap(project => project.catalog.savedQueries),
                )),
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
      description: `The SQL MetricFlow writes for a metric query, in the warehouse's dialect, with the connectionId to run it on. Nothing runs. Use it when the SQL is the deliverable: an app binding, a console, a dbt model. Do NOT edit its aggregation or joins: a wrong number is fixed in the metric's definition. For rows, call query_metric, or run this SQL with sql_execute_query.`,
      inputSchema: compileMetricSchema,
      execute: async input => {
        try {
          const compiled = await compile(
            input,
            maxWaitMs === undefined ? undefined : Date.now() + maxWaitMs,
          );
          return {
            success: true as const,
            ...projectNote(compiled.project),
            metrics: input.metrics,
            connectionId: compiled.connectionId,
            connectionName: compiled.connectionName,
            connectionRole: compiled.connectionRole,
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
      description: `Compute metrics from their definition in the dbt project and return the rows: MetricFlow writes the aggregation, joins and grain, and the SELECT runs read-only on the project's warehouse. The way to answer "what was <metric> last month / by region / over time" when the metric exists. Names come from list_metrics; list_metrics({ metrics }) names the valid group-bys. Returns a markdown table, fenced as untrusted data, with the SQL.`,
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
          const deadline =
            maxWaitMs === undefined ? undefined : Date.now() + maxWaitMs;
          const compiled = await compile(input, deadline);
          // The statement that runs: the agent's default LIMIT is appended
          // here, not inside the executor, so what is returned is what ran.
          const executedSql = appendLimitIfMissing(compiled.sql);
          const limitAppended = executedSql !== compiled.sql;
          sql = executedSql;
          // A metric query is a SELECT: read access is all it ever needs,
          // whatever the caller holds.
          const result = await executeQueryImpl(
            compiled.connectionId,
            undefined,
            executedSql,
            workspaceId,
            userId,
            toolExecutionContext,
            "read",
            maxRows,
            {
              fallbackDatabase: compiled.relationDatabase,
              mapRows: normalizeMetricRows,
              ...(deadline === undefined
                ? {}
                : { timeoutMs: Math.max(1000, deadline - Date.now()) }),
            },
          );
          const rowCount =
            "rowCount" in result && typeof result.rowCount === "number"
              ? result.rowCount
              : undefined;
          // Exactly the cap came back: the result was cut, not complete.
          const limited =
            limitAppended &&
            rowCount !== undefined &&
            rowCount >= AGENT_DEFAULT_ROW_LIMIT;
          const note =
            "note" in result && typeof result.note === "string"
              ? result.note
              : undefined;
          return {
            ...result,
            ...(limited
              ? {
                  limited: true as const,
                  rowLimit: AGENT_DEFAULT_ROW_LIMIT,
                  note: `Capped at ${AGENT_DEFAULT_ROW_LIMIT} rows: the metric has MORE rows than the ${AGENT_DEFAULT_ROW_LIMIT} this query read, because Mako appended LIMIT ${AGENT_DEFAULT_ROW_LIMIT}. Totals over these rows are wrong. Pass limit (up to 10000) with orderBy, or cut the rows with where, startTime/endTime, fewer group-bys or a coarser grain.${note ? ` ${note}` : ""}`,
                }
              : {}),
            ...projectNote(compiled.project),
            metrics: input.metrics,
            connectionId: compiled.connectionId,
            connectionName: compiled.connectionName,
            connectionRole: compiled.connectionRole,
            sql: executedSql,
            ...(limitAppended
              ? {
                  sqlNote: `LIMIT ${AGENT_DEFAULT_ROW_LIMIT} was appended to the SQL MetricFlow compiled; compile_metric returns it without.`,
                }
              : {}),
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
