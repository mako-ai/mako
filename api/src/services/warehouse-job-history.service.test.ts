/**
 * Warehouse job history: who read a relation, what a dbt model costs.
 *
 * Pins, with no warehouse:
 * - the exact SQL of each query kind, so a change to a filter is a visible diff;
 * - every bound (days, limit, id count) and every identifier check, because the
 *   REST path sends no query parameters and validation is the only barrier;
 * - the fallback from JOBS_BY_PROJECT to JOBS_BY_USER and what the caller is
 *   told when it happens;
 * - the IAM hint a JOBS denial carries, with the service account and project
 *   filled in;
 * - the relation lister the orphan report reads;
 * - engines without the hooks answer `supported: false`.
 *
 * Run: tsx src/services/warehouse-job-history.service.test.ts
 */
import assert from "node:assert/strict";
import type { IDatabaseConnection } from "../database/workspace-schema";
import type { DatabaseDriver } from "../databases/driver";
import { BigQueryDatabaseDriver } from "../databases/drivers/bigquery/driver";
import { PostgreSQLDatabaseDriver } from "../databases/drivers/postgresql/driver";
import { makeCapturingDriver } from "../databases/test-support/capturing-driver";
import {
  FAKE_BIGQUERY_SERVICE_ACCOUNT,
  makeFakeConnection,
} from "../databases/test-support/fake-connection";
import {
  bigQueryGrantTarget,
  bigQueryJobsAccessHint,
  databaseConnectionService,
  isBigQueryJobsAccessDenied,
  withBigQueryJobsAccessHint,
} from "./database-connection.service";
import { checkPreviewQuerySafety } from "./query-pagination.service";
import {
  modelCost,
  tableReaders,
  type JobHistoryDeps,
} from "./warehouse-job-history.service";

const driver = new BigQueryDatabaseDriver();
const connection = makeFakeConnection("bigquery", {
  project_id: "fake-project",
  location: "EU",
  service_account_json: FAKE_BIGQUERY_SERVICE_ACCOUNT,
});
const INVOCATION = "0d1c2b3a-1111-4222-8333-444455556666";
const RUN_ID = "64b0c0ffee0123456789abcd";
const DENIED =
  "Access Denied: Table fake-project:region-eu.INFORMATION_SCHEMA.JOBS_BY_PROJECT: " +
  "User does not have permission to query table " +
  "fake-project:region-eu.INFORMATION_SCHEMA.JOBS_BY_PROJECT, or perhaps it " +
  "does not exist. (HTTP 403)";
const GRANT_COMMAND =
  "gcloud projects add-iam-policy-binding fake-project " +
  '--member="serviceAccount:fake@fake-project.iam.gserviceaccount.com" ' +
  '--role="roles/bigquery.resourceViewer"';

function build(
  kind: "model_cost" | "table_readers",
  params: Parameters<BigQueryDatabaseDriver["buildJobHistoryQuery"]>[2],
  target: IDatabaseConnection = connection,
): string {
  const sql = driver.buildJobHistoryQuery(target, kind, params);
  assert.ok(sql, "the BigQuery driver builds this kind");
  return sql;
}

// ── SQL snapshots ─────────────────────────────────────────────────

const MODEL_COST_SQL = `WITH dbt_jobs AS (
  SELECT
    DATE(creation_time) AS day,
    COALESCE(
      REGEXP_EXTRACT(query, r'"node_id":\\s*"([^"]+)"'),
      (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'node_id' LIMIT 1)
    ) AS node_id,
    IF(
      destination_table.dataset_id IS NOT NULL
        AND NOT STARTS_WITH(destination_table.dataset_id, '_'),
      CONCAT(destination_table.project_id, '.', destination_table.dataset_id, '.', destination_table.table_id),
      NULL
    ) AS relation,
    (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'dbt_invocation_id' LIMIT 1) AS invocation_id,
    total_bytes_billed,
    total_slot_ms,
    TIMESTAMP_DIFF(end_time, start_time, MILLISECOND) AS duration_ms
  FROM \`fake-project\`.\`region-eu\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
  WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
    AND job_type = 'QUERY'
    AND parent_job_id IS NULL
    AND EXISTS (
      SELECT 1 FROM UNNEST(labels) AS l
      WHERE (l.key = 'dbt_invocation_id' AND l.value IN ('${INVOCATION}'))
        OR (l.key = 'mako_dbt_run' AND l.value IN ('${RUN_ID}'))
        OR (l.key = 'mako_dbt_job' AND l.value IN ('nightly'))
    )
)
SELECT
  day,
  node_id,
  MAX(relation) AS relation,
  COUNT(*) AS jobs,
  IFNULL(SUM(total_bytes_billed), 0) AS bytes_billed,
  IFNULL(SUM(total_slot_ms), 0) AS slot_ms,
  COUNT(DISTINCT invocation_id) AS invocations,
  CAST(ROUND(AVG(duration_ms)) AS INT64) AS avg_duration_ms
FROM dbt_jobs
WHERE node_id = 'model.shop.orders'
  OR ENDS_WITH(node_id, '.model.shop.orders')
  OR node_id = 'model_shop_orders'
GROUP BY day, node_id
ORDER BY day DESC, slot_ms DESC
LIMIT 100`;

const MODEL_COST_MINIMAL_SQL = `WITH dbt_jobs AS (
  SELECT
    DATE(creation_time) AS day,
    COALESCE(
      REGEXP_EXTRACT(query, r'"node_id":\\s*"([^"]+)"'),
      (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'node_id' LIMIT 1)
    ) AS node_id,
    IF(
      destination_table.dataset_id IS NOT NULL
        AND NOT STARTS_WITH(destination_table.dataset_id, '_'),
      CONCAT(destination_table.project_id, '.', destination_table.dataset_id, '.', destination_table.table_id),
      NULL
    ) AS relation,
    (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'dbt_invocation_id' LIMIT 1) AS invocation_id,
    total_bytes_billed,
    total_slot_ms,
    TIMESTAMP_DIFF(end_time, start_time, MILLISECOND) AS duration_ms
  FROM \`fake-project\`.\`region-eu\`.INFORMATION_SCHEMA.JOBS_BY_USER
  WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
    AND job_type = 'QUERY'
    AND parent_job_id IS NULL
    AND EXISTS (
      SELECT 1 FROM UNNEST(labels) AS l
      WHERE (l.key = 'dbt_invocation_id' AND l.value IN ('${INVOCATION}', 'second-invocation'))
    )
)
SELECT
  day,
  node_id,
  MAX(relation) AS relation,
  COUNT(*) AS jobs,
  IFNULL(SUM(total_bytes_billed), 0) AS bytes_billed,
  IFNULL(SUM(total_slot_ms), 0) AS slot_ms,
  COUNT(DISTINCT invocation_id) AS invocations,
  CAST(ROUND(AVG(duration_ms)) AS INT64) AS avg_duration_ms
FROM dbt_jobs
GROUP BY day, node_id
ORDER BY day DESC, slot_ms DESC
LIMIT 500`;

const readersSql = (
  view: string,
  days: number,
  project: string,
  limit: number,
) => `WITH reads AS (
  SELECT
    user_email,
    (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'mako_source' LIMIT 1) AS mako_source,
    (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'mako_app' LIMIT 1) AS mako_app,
    total_bytes_billed,
    creation_time,
    EXISTS (
      SELECT 1 FROM UNNEST(referenced_tables) AS r
      WHERE r.project_id = '${project}' AND r.dataset_id = 'analytics' AND r.table_id = 'orders_v'
    ) AS by_reference
  FROM \`fake-project\`.\`region-eu\`.INFORMATION_SCHEMA.${view}
  WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${days} DAY)
    AND job_type = 'QUERY'
    AND (statement_type IS NULL OR statement_type NOT IN ('SCRIPT', 'CREATE_VIEW', 'ALTER_VIEW', 'DROP_VIEW', 'CREATE_MATERIALIZED_VIEW', 'ALTER_MATERIALIZED_VIEW', 'DROP_MATERIALIZED_VIEW', 'ALTER_TABLE', 'DROP_TABLE', 'TRUNCATE_TABLE'))
    AND NOT IFNULL(destination_table.project_id = '${project}' AND destination_table.dataset_id = 'analytics' AND destination_table.table_id = 'orders_v', FALSE)
    AND (
      EXISTS (
        SELECT 1 FROM UNNEST(referenced_tables) AS r
        WHERE r.project_id = '${project}' AND r.dataset_id = 'analytics' AND r.table_id = 'orders_v'
      )
      OR (
        STRPOS(query, 'orders_v') > 0
        AND REGEXP_CONTAINS(query, r'(?i)(^|[^a-z0-9_])\`?analytics\`?\\s*\\.\\s*\`?orders_v\`?([^a-z0-9_]|$)')
      )
    )
    AND NOT IFNULL(REGEXP_CONTAINS(query, r'(?i)information_schema|__tables__'), FALSE)
    AND NOT EXISTS (
      SELECT 1 FROM UNNEST(labels) AS l
      WHERE l.key = 'mako_source' AND l.value = 'metadata'
    )
)
SELECT
  mako_source,
  mako_app,
  user_email,
  COUNT(*) AS jobs,
  IFNULL(SUM(total_bytes_billed), 0) AS bytes_billed,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(creation_time)) AS last_read_at,
  COUNTIF(NOT by_reference) AS jobs_by_text_only
FROM reads
GROUP BY mako_source, mako_app, user_email
ORDER BY jobs DESC, last_read_at DESC
LIMIT ${limit}`;

function testSqlSnapshots(): void {
  assert.equal(
    build("model_cost", {
      scope: "project",
      days: 7,
      invocationIds: [INVOCATION],
      makoRunIds: [RUN_ID],
      makoJobLabels: ["nightly"],
      model: "model.shop.orders",
    }),
    MODEL_COST_SQL,
  );
  assert.equal(
    build("model_cost", {
      scope: "user",
      days: 30,
      limit: 500,
      invocationIds: [INVOCATION, "second-invocation"],
    }),
    MODEL_COST_MINIMAL_SQL,
  );
  // Relation without a database: the connection's project.
  assert.equal(
    build("table_readers", {
      scope: "project",
      days: 7,
      relation: { schema: "analytics", name: "orders_v" },
    }),
    readersSql("JOBS_BY_PROJECT", 7, "fake-project", 100),
  );
  // Relation in another project: the JOBS view stays the connection's.
  assert.equal(
    build("table_readers", {
      scope: "user",
      days: 30,
      limit: 50,
      relation: {
        database: "other-project",
        schema: "analytics",
        name: "orders_v",
      },
    }),
    readersSql("JOBS_BY_USER", 30, "other-project", 50),
  );
}

function testEveryQueryIsBoundedAndReadOnly(): void {
  const queries = [
    build("model_cost", { scope: "project", days: 1, makoRunIds: [RUN_ID] }),
    build("table_readers", {
      scope: "project",
      days: 30,
      relation: { schema: "analytics", name: "orders_v" },
    }),
  ];
  for (const sql of queries) {
    // The partition filter, a row limit, and the lexical read-only check the
    // service runs every query through.
    assert.match(
      sql,
      /WHERE creation_time >= TIMESTAMP_SUB\(CURRENT_TIMESTAMP\(\), INTERVAL \d+ DAY\)/,
    );
    assert.match(sql, /\nLIMIT \d+$/);
    assert.deepEqual(checkPreviewQuerySafety(sql).errors, []);
  }

  // Region: from the connection, lowercased; US when the connection has none.
  const noLocation = makeFakeConnection("bigquery", {
    project_id: "fake-project",
  });
  assert.ok(
    build(
      "model_cost",
      { scope: "project", days: 1, makoRunIds: [RUN_ID] },
      noLocation,
    ).includes("`fake-project`.`region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT"),
  );
  const zurich = makeFakeConnection("bigquery", {
    project_id: "fake-project",
    location: "europe-west6",
  });
  assert.ok(
    build(
      "model_cost",
      { scope: "user", days: 1, makoRunIds: [RUN_ID] },
      zurich,
    ).includes("`region-europe-west6`.INFORMATION_SCHEMA.JOBS_BY_USER"),
  );

  // An unknown kind is not a query.
  assert.equal(
    driver.buildJobHistoryQuery(connection, "other" as "model_cost", {
      scope: "project",
      days: 1,
    }),
    null,
  );
}

function testBounds(): void {
  const cost = (
    extra: Partial<
      Parameters<BigQueryDatabaseDriver["buildJobHistoryQuery"]>[2]
    >,
  ) =>
    build("model_cost", {
      scope: "project",
      days: 7,
      makoRunIds: [RUN_ID],
      ...extra,
    });

  for (const days of [0, 31, -1, 1.5, Number.NaN, Infinity]) {
    assert.throws(() => cost({ days }), RangeError, `days ${days}`);
  }
  assert.throws(() => cost({ days: "7" as unknown as number }), RangeError);
  assert.ok(cost({ days: 30 }).includes("INTERVAL 30 DAY"));

  for (const limit of [0, 501, -5, 2.5]) {
    assert.throws(() => cost({ limit }), RangeError, `limit ${limit}`);
  }
  assert.ok(cost({ limit: 500 }).endsWith("LIMIT 500"));
  assert.ok(cost({}).endsWith("LIMIT 100"));

  assert.throws(
    () => cost({ scope: "everyone" as unknown as "project" }),
    RangeError,
  );

  // No run set: the query would price every job of the project.
  assert.throws(
    () => build("model_cost", { scope: "project", days: 7 }),
    /needs invocationIds, makoRunIds or makoJobLabels/,
  );
  assert.throws(
    () => build("model_cost", { scope: "project", days: 7, invocationIds: [] }),
    RangeError,
  );
  const tooMany = Array.from({ length: 2001 }, (_, i) => `run-${i}`);
  assert.throws(() => cost({ makoRunIds: tooMany }), /more than 2000/);
  assert.ok(cost({ makoRunIds: tooMany.slice(0, 2000) }));

  assert.throws(
    () => build("table_readers", { scope: "project", days: 7 }),
    /needs a relation/,
  );
}

function testIdentifierValidation(): void {
  const hostile = [
    "orders'; DROP TABLE x; --",
    "orders`",
    "orders v",
    'orders"',
    "orders\\",
    "orders)",
    "orders\n",
    "",
    "a.b",
  ];
  for (const value of hostile) {
    const label = JSON.stringify(value);
    assert.throws(
      () =>
        build("table_readers", {
          scope: "project",
          days: 7,
          relation: { schema: "analytics", name: value },
        }),
      RangeError,
      `relation name ${label}`,
    );
    assert.throws(
      () =>
        build("table_readers", {
          scope: "project",
          days: 7,
          relation: { schema: value, name: "orders" },
        }),
      RangeError,
      `relation schema ${label}`,
    );
    assert.throws(
      () =>
        build("table_readers", {
          scope: "project",
          days: 7,
          relation: { database: value, schema: "analytics", name: "orders" },
        }),
      RangeError,
      `relation database ${label}`,
    );
    for (const key of [
      "invocationIds",
      "makoRunIds",
      "makoJobLabels",
    ] as const) {
      assert.throws(
        () =>
          build("model_cost", { scope: "project", days: 7, [key]: [value] }),
        RangeError,
        `${key} ${label}`,
      );
    }
  }
  for (const model of ["orders' OR 1=1 --", "orders`", "a b", "", "x/y"]) {
    assert.throws(
      () =>
        build("model_cost", {
          scope: "project",
          days: 7,
          makoRunIds: [RUN_ID],
          model,
        }),
      RangeError,
      `model ${JSON.stringify(model)}`,
    );
  }
  // Label values are lowercase by rule: an uppercase id is not a label.
  assert.throws(
    () =>
      build("model_cost", {
        scope: "project",
        days: 7,
        invocationIds: ["ABC"],
      }),
    RangeError,
  );

  // The connection's own fields are checked like caller input.
  for (const bad of [
    { project_id: "fake`project", location: "EU" },
    { project_id: "fake-project", location: "eu`; --" },
    { location: "EU" },
  ]) {
    assert.throws(
      () =>
        build(
          "model_cost",
          { scope: "project", days: 7, makoRunIds: [RUN_ID] },
          makeFakeConnection("bigquery", bad),
        ),
      RangeError,
    );
  }
}

// ── The IAM hint ──────────────────────────────────────────────────

async function testAccessHint(): Promise<void> {
  assert.equal(isBigQueryJobsAccessDenied(DENIED), true);
  // A job error carries no HTTP status but says the same thing.
  assert.equal(
    isBigQueryJobsAccessDenied(
      "Access Denied: Table p:region-us.INFORMATION_SCHEMA.JOBS: User does not have permission",
    ),
    true,
  );
  assert.equal(
    isBigQueryJobsAccessDenied("Not found: Dataset p:x (HTTP 404)"),
    false,
  );
  assert.equal(
    isBigQueryJobsAccessDenied(
      "Access Denied: Table p:analytics.orders: User does not have permission (HTTP 403)",
    ),
    false,
  );
  assert.equal(
    isBigQueryJobsAccessDenied(
      "Syntax error near INFORMATION_SCHEMA.JOBS_BY_PROJECT (HTTP 400)",
    ),
    false,
  );
  // JOBS_BY_USER needs no grant: the hint would not fix its denial.
  assert.equal(
    isBigQueryJobsAccessDenied(
      "Access Denied: Table p:region-us.INFORMATION_SCHEMA.JOBS_BY_USER (HTTP 403)",
    ),
    false,
  );
  assert.equal(isBigQueryJobsAccessDenied(undefined), false);

  assert.deepEqual(bigQueryGrantTarget(connection), {
    projectId: "fake-project",
    serviceAccountEmail: "fake@fake-project.iam.gserviceaccount.com",
  });
  assert.deepEqual(
    bigQueryGrantTarget(
      makeFakeConnection("bigquery", { service_account_json: "not json" }),
    ),
    { projectId: undefined, serviceAccountEmail: undefined },
  );

  const hint = bigQueryJobsAccessHint(bigQueryGrantTarget(connection));
  assert.equal(
    hint,
    "The connection's service account fake@fake-project.iam.gserviceaccount.com " +
      "lacks the bigquery.jobs.listAll permission on project fake-project. " +
      "Grant it the role roles/bigquery.resourceViewer: " +
      `${GRANT_COMMAND}. ` +
      "Without the grant, INFORMATION_SCHEMA.JOBS_BY_USER still lists the " +
      "jobs this service account started itself.",
  );
  // Unknown account or project: placeholders, never an empty command.
  assert.ok(
    bigQueryJobsAccessHint({}).includes(
      'gcloud projects add-iam-policy-binding PROJECT_ID --member="serviceAccount:SERVICE_ACCOUNT_EMAIL"',
    ),
  );

  const target = bigQueryGrantTarget(connection);
  const hinted = withBigQueryJobsAccessHint(DENIED, target);
  assert.equal(hinted, `${DENIED} ${hint}`);
  assert.equal(withBigQueryJobsAccessHint(hinted, target), hinted);
  assert.equal(
    withBigQueryJobsAccessHint("Not found: Table x (HTTP 404)", target),
    "Not found: Table x (HTTP 404)",
  );

  // What a user or a tool actually receives: executeQuery's error.
  const service = databaseConnectionService as unknown as {
    executeBigQueryQuery(
      ...args: unknown[]
    ): Promise<{ success: boolean; error?: string; data?: unknown }>;
  };
  const original = service.executeBigQueryQuery;
  try {
    service.executeBigQueryQuery = async () => ({
      success: false,
      error: DENIED,
    });
    const denied = await databaseConnectionService.executeQuery(
      connection,
      "SELECT 1 FROM `fake-project`.`region-eu`.INFORMATION_SCHEMA.JOBS_BY_PROJECT",
      { readOnly: true },
    );
    assert.equal(denied.success, false);
    assert.equal(denied.error, `${DENIED} ${hint}`);

    service.executeBigQueryQuery = async () => ({
      success: false,
      error: "Syntax error (HTTP 400)",
    });
    const other = await databaseConnectionService.executeQuery(
      connection,
      "SELECT 1",
      { readOnly: true },
    );
    assert.equal(other.error, "Syntax error (HTTP 400)");

    service.executeBigQueryQuery = async () => ({ success: true, data: [] });
    const ok = await databaseConnectionService.executeQuery(
      connection,
      "SELECT 1",
      { readOnly: true },
    );
    assert.equal(ok.success, true);
  } finally {
    service.executeBigQueryQuery = original;
  }
}

// ── The services ──────────────────────────────────────────────────

type Outcome = { success: boolean; data?: unknown; error?: string };

function makeDeps(
  overrides: Partial<JobHistoryDeps> & {
    respond?: (sql: string, call: number) => Outcome;
    target?: IDatabaseConnection;
  } = {},
): JobHistoryDeps & { queries: string[]; jobLabelCalls: number } {
  const queries: string[] = [];
  const state = { jobLabelCalls: 0 };
  const { respond, target, ...rest } = overrides;
  return {
    queries,
    get jobLabelCalls() {
      return state.jobLabelCalls;
    },
    resolveTarget: async params => ({
      connection: target ?? connection,
      environment: params.environment ?? "prod",
      prodLike: true,
    }),
    listRuns: async () => [{ id: RUN_ID, invocationIds: [INVOCATION] }],
    jobLabelValues: async () => {
      state.jobLabelCalls++;
      return ["Nightly Build", "64b0c0ffee0123456789beef"];
    },
    getDriver: () => driver,
    runQuery: async (_connection, sql) => {
      queries.push(sql);
      return respond?.(sql, queries.length) ?? { success: true, data: [] };
    },
    now: () => new Date("2026-06-15T12:00:00Z"),
    ...rest,
  };
}

const TARGET = {
  workspaceId: "64b0c0ffee0123456789aaaa",
  projectId: "64b0c0ffee0123456789bbbb",
};

async function testProjectScope(): Promise<void> {
  const deps = makeDeps({
    respond: () => ({
      success: true,
      data: [
        {
          day: "2026-06-14",
          node_id: "model.shop.orders",
          relation: "fake-project.analytics.orders",
          jobs: "3",
          bytes_billed: "1048576",
          slot_ms: 9000,
          invocations: 2,
          avg_duration_ms: "1500",
        },
        {
          day: "2026-06-14",
          node_id: null,
          relation: null,
          jobs: 1,
          bytes_billed: 0,
          slot_ms: 12,
          invocations: 1,
          avg_duration_ms: null,
        },
      ],
    }),
  });
  const result = await modelCost(TARGET, deps);
  assert.deepEqual(result, {
    supported: true,
    scope: "project",
    days: 7,
    rows: [
      {
        day: "2026-06-14",
        nodeId: "model.shop.orders",
        relation: "fake-project.analytics.orders",
        jobs: 3,
        bytesBilled: 1048576,
        slotMs: 9000,
        invocations: 2,
        avgDurationMs: 1500,
      },
      {
        day: "2026-06-14",
        nodeId: undefined,
        relation: undefined,
        jobs: 1,
        bytesBilled: 0,
        slotMs: 12,
        invocations: 1,
        avgDurationMs: undefined,
      },
    ],
  });
  assert.equal(deps.queries.length, 1);
  assert.ok(deps.queries[0].includes("JOBS_BY_PROJECT"));
  assert.ok(deps.queries[0].includes(`'${INVOCATION}'`));
  assert.ok(deps.queries[0].includes(`'${RUN_ID}'`));
  // No job asked for: no job label in the filter, no job lookup.
  assert.ok(!deps.queries[0].includes("mako_dbt_job"));
  assert.equal(deps.jobLabelCalls, 0);
}

async function testFallbackToOwnJobs(): Promise<void> {
  const deps = makeDeps({
    respond: sql =>
      sql.includes("JOBS_BY_PROJECT")
        ? { success: false, error: DENIED }
        : {
            success: true,
            data: [
              {
                mako_source: "app_binding",
                mako_app: "sales",
                user_email: "fake@fake-project.iam.gserviceaccount.com",
                jobs: 12,
                bytes_billed: "2048",
                last_read_at: "2026-06-15T08:00:00Z",
                jobs_by_text_only: 12,
              },
            ],
          },
  });
  const result = await tableReaders(
    { ...TARGET, relation: { schema: "analytics", name: "orders_v" } },
    deps,
  );
  assert.equal(deps.queries.length, 2);
  assert.ok(deps.queries[0].includes("INFORMATION_SCHEMA.JOBS_BY_PROJECT"));
  assert.ok(deps.queries[1].includes("INFORMATION_SCHEMA.JOBS_BY_USER"));
  // Same query, other view.
  assert.equal(
    deps.queries[1],
    deps.queries[0].replace("JOBS_BY_PROJECT", "JOBS_BY_USER"),
  );
  assert.ok(result.supported);
  assert.equal(result.scope, "user");
  assert.equal(
    result.warning,
    "Only jobs started by this connection's own account are listed. " +
      "Jobs run with other credentials (BI tools, analysts, other service " +
      "accounts) are invisible here. " +
      "The connection's service account fake@fake-project.iam.gserviceaccount.com " +
      "lacks the bigquery.jobs.listAll permission on project fake-project. " +
      "Grant it the role roles/bigquery.resourceViewer: " +
      `${GRANT_COMMAND}. ` +
      "Without the grant, INFORMATION_SCHEMA.JOBS_BY_USER still lists the " +
      "jobs this service account started itself.",
  );
  assert.deepEqual(result.rows, [
    {
      makoSource: "app_binding",
      makoApp: "sales",
      userEmail: "fake@fake-project.iam.gserviceaccount.com",
      jobs: 12,
      bytesBilled: 2048,
      lastReadAt: "2026-06-15T08:00:00Z",
      jobsByTextOnly: 12,
    },
  ]);
  assert.equal(result.notes?.length, 2);

  // modelCost falls back the same way.
  const costDeps = makeDeps({
    respond: sql =>
      sql.includes("JOBS_BY_PROJECT")
        ? { success: false, error: DENIED }
        : { success: true, data: [] },
  });
  const cost = await modelCost(TARGET, costDeps);
  assert.ok(cost.supported);
  assert.equal(cost.scope, "user");
  assert.ok(cost.warning?.includes("bigquery.jobs.listAll"));
  assert.ok(cost.warning?.includes(GRANT_COMMAND));
  assert.equal(costDeps.queries.length, 2);

  // Project-wide view granted: no warning.
  const granted = await tableReaders(
    { ...TARGET, relation: { schema: "analytics", name: "orders_v" } },
    makeDeps(),
  );
  assert.ok(granted.supported);
  assert.equal(granted.scope, "project");
  assert.equal(granted.warning, undefined);
}

async function testFailedQueriesThrow(): Promise<void> {
  // Any failure that is not the JOBS denial: no retry, the error surfaces.
  const broken = makeDeps({
    respond: () => ({ success: false, error: "Quota exceeded (HTTP 403)" }),
  });
  await assert.rejects(
    tableReaders(
      { ...TARGET, relation: { schema: "analytics", name: "orders" } },
      broken,
    ),
    /Quota exceeded/,
  );
  assert.equal(broken.queries.length, 1);

  // The fallback fails too: its error surfaces.
  const both = makeDeps({
    respond: sql =>
      sql.includes("JOBS_BY_PROJECT")
        ? { success: false, error: DENIED }
        : { success: false, error: "Query timed out after 300 seconds" },
  });
  await assert.rejects(modelCost(TARGET, both), /timed out/);
  assert.equal(both.queries.length, 2);

  // A hostile relation never reaches the warehouse.
  const hostile = makeDeps();
  await assert.rejects(
    tableReaders(
      { ...TARGET, relation: { schema: "analytics", name: "x'; --" } },
      hostile,
    ),
    RangeError,
  );
  assert.equal(hostile.queries.length, 0);
}

async function testModelCostRunSet(): Promise<void> {
  // No run in the window: an empty answer, and no warehouse query.
  const empty = makeDeps({ listRuns: async () => [] });
  const none = await modelCost({ ...TARGET, days: 3 }, empty);
  assert.deepEqual(none, {
    supported: true,
    scope: "project",
    days: 3,
    rows: [],
    notes: ['No Mako dbt run in environment "prod" in the last 3 days.'],
  });
  assert.equal(empty.queries.length, 0);

  // Runs without invocation ids (before they were stored) still match
  // through the mako_dbt_run label.
  const unlabelled = makeDeps({
    listRuns: async () => [{ id: RUN_ID, invocationIds: [] }],
  });
  await modelCost(TARGET, unlabelled);
  assert.ok(!unlabelled.queries[0].includes("dbt_invocation_id' AND"));
  assert.ok(unlabelled.queries[0].includes("l.key = 'mako_dbt_run'"));

  // A job narrows the run list and adds its label, sanitized like a label.
  const seen: Array<Record<string, unknown>> = [];
  const forJob = makeDeps({
    listRuns: async params => {
      seen.push(params);
      return [{ id: RUN_ID, invocationIds: [INVOCATION] }];
    },
  });
  await modelCost(
    {
      ...TARGET,
      environment: "staging",
      jobId: "64b0c0ffee0123456789beef",
      days: 90,
      limit: 9999,
      model: "orders",
    },
    forJob,
  );
  assert.equal(seen[0].jobId, "64b0c0ffee0123456789beef");
  assert.equal(seen[0].environment, "staging");
  // 30 days back from the injected clock: the window is clamped, not refused.
  assert.equal(
    (seen[0].since as Date).toISOString(),
    "2026-05-16T12:00:00.000Z",
  );
  assert.ok(
    forJob.queries[0].includes(
      "(l.key = 'mako_dbt_job' AND l.value IN ('nightly_build', '64b0c0ffee0123456789beef'))",
    ),
  );
  assert.ok(forJob.queries[0].includes("INTERVAL 30 DAY"));
  assert.ok(forJob.queries[0].endsWith("LIMIT 500"));
  assert.ok(forJob.queries[0].includes("ENDS_WITH(node_id, '.orders')"));

  // One run: the job label would widen it to every run of the job.
  const forRun = makeDeps();
  await modelCost(
    { ...TARGET, jobId: "64b0c0ffee0123456789beef", runId: RUN_ID },
    forRun,
  );
  assert.equal(forRun.jobLabelCalls, 0);
  assert.ok(!forRun.queries[0].includes("mako_dbt_job"));

  // Ids that are not label values are dropped, never sent.
  const odd = makeDeps({
    listRuns: async () => [
      { id: RUN_ID, invocationIds: ["x'; DROP", INVOCATION.toUpperCase()] },
    ],
  });
  await modelCost(TARGET, odd);
  assert.ok(odd.queries[0].includes(`'${INVOCATION}'`));
  assert.ok(odd.queries[0].includes("'x___drop'"));
  assert.ok(!odd.queries[0].includes("DROP"));
}

async function testUnsupportedEngines(): Promise<void> {
  // The hooks are BigQuery's alone.
  const postgres = new PostgreSQLDatabaseDriver() as DatabaseDriver;
  assert.equal(postgres.buildJobHistoryQuery, undefined);
  assert.equal(postgres.listRelations, undefined);

  const postgresConnection = makeFakeConnection("postgresql", {});
  const deps = makeDeps({
    target: postgresConnection,
    getDriver: () => postgres,
  });
  const expected = {
    supported: false,
    reason: "Job history is not available on postgresql connections.",
  };
  assert.deepEqual(await modelCost(TARGET, deps), expected);
  assert.deepEqual(
    await tableReaders(
      { ...TARGET, relation: { schema: "public", name: "orders" } },
      deps,
    ),
    expected,
  );
  // No driver at all for the connection's type.
  assert.deepEqual(
    await modelCost(TARGET, makeDeps({ getDriver: () => undefined })),
    {
      supported: false,
      reason: "Job history is not available on bigquery connections.",
    },
  );
  // A driver that has the hook but no query for this connection.
  const nullDriver = {
    buildJobHistoryQuery: () => null,
  } as unknown as DatabaseDriver;
  assert.deepEqual(
    await modelCost(TARGET, makeDeps({ getDriver: () => nullDriver })),
    {
      supported: false,
      reason: "Job history is not available on bigquery connections.",
    },
  );
  assert.equal(deps.queries.length, 0);
}

// ── The relation lister ───────────────────────────────────────────

async function testListRelations(): Promise<void> {
  const capturing = makeCapturingDriver(new BigQueryDatabaseDriver(), () => ({
    success: true,
    data: [
      {
        table_name: "orders",
        table_type: "BASE TABLE",
        size_bytes: "4096",
        row_count: "10",
        last_modified_time: "1750000000000",
      },
      {
        table_name: "orders_v",
        table_type: "VIEW",
        size_bytes: 0,
        row_count: 0,
        last_modified_time: 1750000001000,
      },
      {
        table_name: "landing",
        table_type: "EXTERNAL",
        size_bytes: null,
        row_count: null,
        last_modified_time: null,
      },
      { table_name: "daily", table_type: "MATERIALIZED VIEW" },
      { table_name: "backup", table_type: "SNAPSHOT" },
      { table_name: 42 },
    ],
  }));
  try {
    const relations = await capturing.driver.listRelations(
      connection,
      "analytics",
    );
    assert.equal(
      capturing.lastSql(),
      "SELECT t.table_name, t.table_type, s.size_bytes, s.row_count, s.last_modified_time " +
        "FROM `fake-project.analytics`.INFORMATION_SCHEMA.TABLES AS t " +
        "LEFT JOIN `fake-project.analytics.__TABLES__` AS s ON s.table_id = t.table_name " +
        "ORDER BY t.table_name LIMIT 50000",
    );
    assert.deepEqual(capturing.calls[0].options, {
      readOnly: true,
      labels: { mako_source: "metadata" },
    });
    assert.deepEqual(relations, [
      {
        database: "fake-project",
        schema: "analytics",
        name: "orders",
        type: "table",
        sizeBytes: 4096,
        rowCount: 10,
        lastModified: new Date(1750000000000),
      },
      {
        database: "fake-project",
        schema: "analytics",
        name: "orders_v",
        type: "view",
        // A view stores nothing: 0 would read as a measurement.
        sizeBytes: undefined,
        rowCount: undefined,
        lastModified: new Date(1750000001000),
      },
      {
        database: "fake-project",
        schema: "analytics",
        name: "landing",
        type: "external",
        sizeBytes: undefined,
        rowCount: undefined,
        lastModified: undefined,
      },
      {
        database: "fake-project",
        schema: "analytics",
        name: "daily",
        type: "materialized_view",
        sizeBytes: undefined,
        rowCount: undefined,
        lastModified: undefined,
      },
      {
        database: "fake-project",
        schema: "analytics",
        name: "backup",
        type: "other",
        sizeBytes: undefined,
        rowCount: undefined,
        lastModified: undefined,
      },
    ]);

    // Another project's dataset.
    await capturing.driver.listRelations(connection, "marts", {
      projectId: "other-project",
    });
    assert.ok(
      capturing
        .lastSql()
        ?.includes("FROM `other-project.marts`.INFORMATION_SCHEMA.TABLES"),
    );

    // Hostile names never reach the warehouse.
    capturing.reset();
    await assert.rejects(
      capturing.driver.listRelations(connection, "analytics`; DROP"),
      RangeError,
    );
    await assert.rejects(
      capturing.driver.listRelations(connection, "analytics", {
        projectId: "p`.x",
      }),
      RangeError,
    );
    assert.equal(capturing.calls.length, 0);
  } finally {
    capturing.restore();
  }

  // A dataset that does not exist is null; any other failure throws.
  const missing = makeCapturingDriver(new BigQueryDatabaseDriver(), () => ({
    success: false,
    error: "Not found: Dataset fake-project:gone was not found (HTTP 404)",
  }));
  assert.equal(await missing.driver.listRelations(connection, "gone"), null);
  const denied = makeCapturingDriver(new BigQueryDatabaseDriver(), () => ({
    success: false,
    error: "Access Denied: Dataset fake-project:analytics (HTTP 403)",
  }));
  await assert.rejects(
    denied.driver.listRelations(connection, "analytics"),
    /Could not list relations of fake-project\.analytics: Access Denied/,
  );
}

async function main(): Promise<void> {
  testSqlSnapshots();
  testEveryQueryIsBoundedAndReadOnly();
  testBounds();
  testIdentifierValidation();
  await testAccessHint();
  await testProjectScope();
  await testFallbackToOwnJobs();
  await testFailedQueriesThrow();
  await testModelCostRunSet();
  await testUnsupportedEngines();
  await testListRelations();
  process.stdout.write("warehouse-job-history.service.test.ts: ok\n");
}

// An unhandled rejection exits non-zero, which fails the `test` chain.
void main();
