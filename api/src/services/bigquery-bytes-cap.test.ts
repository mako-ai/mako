/**
 * A BigQuery job started for an agent tool or the MCP server carries a
 * `maximumBytesBilled` and a `jobTimeoutMs`; nothing else does. Pins: the
 * engine sends an explicit cap as the REST API's int64 string, sends the
 * agent defaults (or the connection's overrides) when the labels say an
 * agent asked, sends none for consoles, apps, flows, CDC and schedules, and
 * BigQuery's refusal is reworded to name the cap and how to raise it.
 *
 * Run: tsx src/services/bigquery-bytes-cap.test.ts
 */
import assert from "node:assert/strict";
import { bigQueryEngine } from "../databases/drivers/bigquery/engine";
import {
  describeAgentCapError,
  describeBytesBilledCap,
  describeJobTimeoutCap,
} from "../databases/drivers/bigquery/errors";
import {
  isAgentJob,
  resolveAgentJobCaps,
} from "../databases/drivers/bigquery/agent-caps";
import { withQueryLabels } from "./bigquery-labels";
import {
  AGENT_BIGQUERY_JOB_TIMEOUT_MS,
  AGENT_BIGQUERY_MAX_BYTES_BILLED,
} from "../config/long-running-queries";

type Post = { url: string; body: Record<string, unknown> };

async function testRequestBody(): Promise<void> {
  const posts: Post[] = [];
  let refuse = false;
  const fakeClient = {
    post: async (url: string, body: Record<string, unknown>) => {
      posts.push({ url, body });
      if (refuse) {
        throw Object.assign(new Error("Request failed with status code 400"), {
          response: {
            status: 400,
            data: {
              error: {
                code: 400,
                message:
                  "Query exceeded limit for bytes billed: 1000000. 214748364800 or higher required.",
                errors: [{ reason: "bytesBilledLimitExceeded" }],
              },
            },
          },
        });
      }
      return {
        data: {
          jobComplete: true,
          jobReference: { jobId: "job_1", location: "EU" },
          schema: { fields: [{ name: "a", type: "STRING" }] },
          rows: [{ f: [{ v: "x" }] }],
          totalRows: "1",
        },
      };
    },
    get: async () => ({ data: { jobComplete: true, rows: [] } }),
  };
  const service = bigQueryEngine as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const original = service.getHttpClient;
  service.getHttpClient = async () => fakeClient;
  const database = {
    _id: "db1",
    workspaceId: "ws1",
    type: "bigquery",
    connection: {
      project_id: "proj",
      service_account_json: "{}",
      location: "EU",
    },
  };

  try {
    await service.executeQuery(database, "SELECT 1", {
      maximumBytesBilled: 107374182400,
    });
    assert.equal(posts[0].body.maximumBytesBilled, "107374182400");

    // No option, no cap: a console, an app binding, a flow, a dbt build.
    await service.executeQuery(database, "SELECT 1", {});
    assert.equal("maximumBytesBilled" in posts[1].body, false);
    await service.executeQuery(database, "SELECT 1", { maximumBytesBilled: 0 });
    assert.equal("maximumBytesBilled" in posts[2].body, false);

    // BigQuery's refusal reaches the caller, and is reworded.
    refuse = true;
    const refused = (await service.executeQuery(database, "SELECT 1", {
      maximumBytesBilled: 1000000,
    })) as { success: boolean; error?: string };
    assert.equal(refused.success, false);
    // The engine rewords BigQuery's refusal itself.
    assert.match(
      refused.error ?? "",
      /would bill 200 GiB on BigQuery, over the 1 MiB maximumBytesBilled cap/,
    );
    const readable = describeBytesBilledCap(
      "Query exceeded limit for bytes billed: 1000000. 214748364800 or higher required.",
      107374182400,
    );
    assert.ok(readable);
    assert.match(readable, /would bill 200 GiB on BigQuery/);
    assert.match(
      readable,
      /over the 100 GiB maximumBytesBilled cap on agent and MCP queries/,
    );
    assert.match(readable, /agent_max_bytes_billed_gb/);
    assert.match(readable, /did not run and cost nothing/);
    assert.match(readable, /partition column/);
    assert.match(readable, /AGENT_BIGQUERY_MAX_BYTES_BILLED/);

    // An agent or MCP job gets both caps by default; the engine rewords
    // BigQuery's refusal itself.
    refuse = false;
    posts.length = 0;
    await withQueryLabels(
      { mako_source: "agent", mako_trigger: "mcp", mako_tool: "x" },
      () => service.executeQuery(database, "SELECT 1", {}),
    );
    assert.equal(
      posts[0].body.maximumBytesBilled,
      String(AGENT_BIGQUERY_MAX_BYTES_BILLED),
    );
    assert.equal(
      posts[0].body.jobTimeoutMs,
      String(AGENT_BIGQUERY_JOB_TIMEOUT_MS),
    );

    // A console the agent runs keeps the caps: mako_tool survives.
    await withQueryLabels({ mako_tool: "run_console" }, () =>
      withQueryLabels({ mako_source: "console", mako_trigger: "agent" }, () =>
        service.executeStreamingQuery(database, "SELECT 1", {
          onBatch: async () => {},
        }),
      ),
    );
    assert.equal(
      posts[1].body.jobTimeoutMs,
      String(AGENT_BIGQUERY_JOB_TIMEOUT_MS),
    );

    // A connection's own settings win; 0 turns a cap off.
    const tuned = {
      ...database,
      connection: {
        ...database.connection,
        agent_job_timeout_ms: "60000",
        agent_max_bytes_billed_gb: 0,
      },
    };
    await withQueryLabels({ mako_source: "agent" }, () =>
      service.executePreviewQuery(tuned, "SELECT 1", {}),
    );
    assert.equal(posts[2].body.jobTimeoutMs, "60000");
    assert.equal("maximumBytesBilled" in posts[2].body, false);

    // An agent write (maximumBytesBilled: 0) keeps the timeout only.
    await withQueryLabels({ mako_source: "agent" }, () =>
      service.executeQuery(database, "DELETE FROM t WHERE TRUE", {
        maximumBytesBilled: 0,
      }),
    );
    assert.equal("maximumBytesBilled" in posts[3].body, false);
    assert.ok(posts[3].body.jobTimeoutMs);

    // A person's console, CDC and scheduled builds get neither cap.
    await withQueryLabels(
      { mako_source: "console", mako_trigger: "user" },
      () => service.executeQuery(database, "SELECT 1", {}),
    );
    await withQueryLabels({ mako_tool: "x", mako_source: "cdc" }, () =>
      service.executeQuery(database, "SELECT 1", {}),
    );
    await withQueryLabels(
      { mako_source: "app_binding", mako_trigger: "scheduler" },
      () => service.executeQuery(database, "SELECT 1", {}),
    );
    for (const post of posts.slice(4)) {
      assert.equal("jobTimeoutMs" in post.body, false);
      assert.equal("maximumBytesBilled" in post.body, false);
    }

    // A timeout BigQuery enforced comes back naming the cap.
    refuse = true;
    const timedOut = (await withQueryLabels({ mako_source: "agent" }, () =>
      service.executeQuery(
        { ...database, connection: { ...database.connection } },
        "SELECT 1",
        {},
      ),
    )) as { success: boolean; error?: string };
    assert.equal(timedOut.success, false);
    // The fake refuses with the bytes error: the engine reworded it.
    assert.match(timedOut.error ?? "", /maximumBytesBilled cap/);

    const cappedDatabase = {
      ...database,
      connection: { ...database.connection, agent_max_bytes_billed_gb: 2 },
    };
    for (const [ceiling, expectedCap, description] of [
      [
        1024 ** 3,
        "1073741824",
        /1 GiB caller-supplied maximumBytesBilled ceiling/,
      ],
      [
        2 * 1024 ** 3,
        "2147483648",
        /2 GiB caller-supplied maximumBytesBilled ceiling and server cap/,
      ],
      [
        3 * 1024 ** 3,
        "2147483648",
        /2 GiB maximumBytesBilled cap on agent and MCP queries/,
      ],
    ] as const) {
      for (const method of [
        "executeQuery",
        "executePreviewQuery",
        "executeStreamingQuery",
      ]) {
        for (const priority of ["INTERACTIVE", "BATCH"]) {
          posts.length = 0;
          const result = (await withQueryLabels({ mako_trigger: "mcp" }, () =>
            service[method](cappedDatabase, "SELECT 1", {
              maximumBytesBilledCeiling: ceiling,
              priority,
              onBatch: async () => {},
            }),
          )) as { success: boolean; error?: string };
          const body = posts[0].body;
          const query = posts[0].url.endsWith("/jobs")
            ? (body.configuration as { query: Record<string, unknown> }).query
            : body;
          assert.equal(query.maximumBytesBilled, expectedCap);
          assert.equal(result.success, false);
          assert.match(result.error ?? "", description);
          assert.match(result.error ?? "", /Read fewer bytes/);
          assert.doesNotMatch(
            result.error ?? "",
            /To raise the cap|agent_max_bytes_billed_gb/,
          );
        }
      }
    }
  } finally {
    service.getHttpClient = original;
  }
}

function testAgentCaps(): void {
  assert.equal(isAgentJob(undefined), false);
  assert.equal(isAgentJob({ mako_source: "agent" }), true);
  assert.equal(isAgentJob({ mako_trigger: "mcp" }), true);
  assert.equal(isAgentJob({ mako_tool: "run_console" }), true);
  assert.equal(isAgentJob({ mako_source: "console" }), false);
  assert.equal(isAgentJob({ mako_tool: "x", mako_source: "flow" }), false);
  assert.equal(isAgentJob({ mako_tool: "x", mako_trigger: "publish" }), false);
  assert.deepEqual(
    resolveAgentJobCaps({
      connection: { agent_max_bytes_billed_gb: "2" },
      labels: { mako_source: "agent" },
    }),
    {
      jobTimeoutMs: AGENT_BIGQUERY_JOB_TIMEOUT_MS,
      maximumBytesBilled: 2 * 1024 ** 3,
    },
  );
  // An explicit positive cap wins and applies outside agent jobs too.
  assert.deepEqual(
    resolveAgentJobCaps({
      connection: {},
      labels: { mako_source: "console" },
      explicitBytes: 5,
    }),
    { maximumBytesBilled: 5 },
  );
  // An invalid internal ceiling must never disable an existing cap.
  for (const bytesCeiling of [0, -1, 0.5, NaN, Infinity]) {
    assert.throws(
      () =>
        resolveAgentJobCaps({
          connection: { agent_max_bytes_billed_gb: 2 },
          labels: { mako_source: "agent" },
          bytesCeiling,
        }),
      /positive safe integer/,
    );
  }
  const ceilingCaps = resolveAgentJobCaps({
    connection: { agent_max_bytes_billed_gb: 50 },
    labels: { mako_trigger: "mcp" },
    bytesCeiling: 20_000_000_000,
  });
  const refused = describeAgentCapError(
    "Query exceeded limit for bytes billed",
    ceilingCaps,
  );
  assert.equal(ceilingCaps.maximumBytesBilled, 20_000_000_000);
  assert.match(refused ?? "", /caller-supplied maximumBytesBilled ceiling/);
  assert.doesNotMatch(refused ?? "", /agent_max_bytes_billed_gb/);
  const equalCaps = resolveAgentJobCaps({
    connection: { agent_max_bytes_billed_gb: 2 },
    labels: { mako_trigger: "mcp" },
    bytesCeiling: 2 * 1024 ** 3,
  });
  assert.equal(equalCaps.maximumBytesBilled, 2 * 1024 ** 3);
  assert.match(
    describeAgentCapError("Query exceeded limit for bytes billed", equalCaps) ??
      "",
    /caller-supplied maximumBytesBilled ceiling and server cap/,
  );

  // Invalid settings fall back to the defaults.
  assert.equal(
    resolveAgentJobCaps({
      connection: { agent_job_timeout_ms: "soon" },
      labels: { mako_source: "agent" },
    }).jobTimeoutMs,
    AGENT_BIGQUERY_JOB_TIMEOUT_MS,
  );

  const timeout = describeJobTimeoutCap(
    "Job execution was cancelled: Job timed out after 5 min 0 sec",
    300000,
  );
  assert.ok(timeout);
  assert.match(timeout, /after 5 min, the jobTimeoutMs cap/);
  assert.match(timeout, /agent_job_timeout_ms/);
  // Mako's own poll timeout is not BigQuery's cap.
  assert.equal(
    describeJobTimeoutCap("Query timed out after 300 seconds", 300000),
    null,
  );
  assert.equal(
    describeAgentCapError("Query exceeded limit for bytes billed", {
      jobTimeoutMs: 1000,
    }),
    null,
  );
}

function testOtherErrors(): void {
  assert.equal(describeBytesBilledCap(undefined, 1), null);
  assert.equal(
    describeBytesBilledCap("Syntax error: Unexpected keyword FROM", 1),
    null,
  );
  // 500 GiB and 5 minutes unless the operator sets others.
  if (process.env.AGENT_BIGQUERY_MAX_BYTES_BILLED === undefined) {
    assert.equal(AGENT_BIGQUERY_MAX_BYTES_BILLED, 500 * 1024 ** 3);
  }
  if (process.env.AGENT_BIGQUERY_JOB_TIMEOUT_MS === undefined) {
    assert.equal(AGENT_BIGQUERY_JOB_TIMEOUT_MS, 300000);
  }
  assert.match(
    describeBytesBilledCap(
      "Query exceeded limit for bytes billed",
      1024 ** 4,
    ) ?? "",
    /would bill more on BigQuery, over the 1 TiB maximumBytesBilled cap/,
  );
}

async function main(): Promise<void> {
  await testRequestBody();
  testOtherErrors();
  testAgentCaps();
  console.info("bigquery bytes cap tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
