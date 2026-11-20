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
  isInteractiveJob,
  resolveAgentJobCaps,
} from "../databases/drivers/bigquery/agent-caps";
import { withQueryLabels } from "./bigquery-labels";
import { primeWorkspaceByteCapCache } from "./workspace-byte-cap";
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
      /over the 100 GiB maximumBytesBilled cap on interactive queries/,
    );
    assert.match(readable, /agent_max_bytes_billed_gb/);
    assert.match(readable, /did not run and cost nothing/);
    assert.match(readable, /partition column/);
    assert.match(readable, /workspace byte cap/);

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
    // A workspace without its own cap keeps today's behaviour: a console,
    // CDC and the scheduler get neither cap.
    for (const post of posts.slice(4)) {
      assert.equal("jobTimeoutMs" in post.body, false);
      assert.equal("maximumBytesBilled" in post.body, false);
    }

    // An MCP call gets the platform default (500 GiB); its own maximumBytesBilled wins.
    posts.length = 0;
    await withQueryLabels(
      {
        mako_source: "agent",
        mako_trigger: "mcp",
        mako_tool: "sql_execute_query",
      },
      () => service.executeQuery(database, "SELECT 1", {}),
    );
    assert.equal(
      posts[0].body.maximumBytesBilled,
      String(AGENT_BIGQUERY_MAX_BYTES_BILLED),
    );
    await withQueryLabels(
      {
        mako_source: "agent",
        mako_trigger: "mcp",
        mako_tool: "sql_execute_query",
      },
      () =>
        service.executeQuery(database, "SELECT 1", {
          maximumBytesBilled: 200 * 1024 ** 3,
        }),
    );
    assert.equal(posts[1].body.maximumBytesBilled, String(200 * 1024 ** 3));

    // Without a workspace cap, a notebook and a binding preview are not capped.
    for (const labels of [
      { mako_source: "notebook", mako_trigger: "kernel" },
      { mako_source: "app_binding", mako_trigger: "preview" },
      { mako_source: "console", mako_trigger: "console_ui" },
    ]) {
      posts.length = 0;
      await withQueryLabels(labels, () =>
        service.executeQuery(database, "SELECT 1", {}),
      );
      assert.equal("maximumBytesBilled" in posts[0].body, false);
    }

    // With the workspace set to 20 GiB, a notebook, a console and a binding
    // preview are capped; a published app refresh and a dbt defer build are
    // not, and neither are sync paths.
    primeWorkspaceByteCapCache("ws1", 20);
    for (const labels of [
      { mako_source: "notebook", mako_trigger: "kernel" },
      { mako_source: "app_binding", mako_trigger: "preview" },
      { mako_source: "console", mako_trigger: "console_ui" },
      { mako_source: "agent", mako_trigger: "mcp" },
    ]) {
      posts.length = 0;
      await withQueryLabels(labels, () =>
        service.executeQuery(database, "SELECT 1", {}),
      );
      assert.equal(posts[0].body.maximumBytesBilled, String(20 * 1024 ** 3));
    }
    for (const labels of [
      { mako_source: "app_binding", mako_trigger: "viewer" },
      { mako_source: "dbt_defer" },
      { mako_source: "flow" },
      { mako_source: "cdc" },
      { mako_source: "app_binding", mako_trigger: "scheduler" },
      { mako_source: "console", mako_trigger: "api" },
    ]) {
      posts.length = 0;
      await withQueryLabels(labels, () =>
        service.executeQuery(database, "SELECT 1", {}),
      );
      assert.equal("maximumBytesBilled" in posts[0].body, false);
    }

    // Every job body carries the caller labels, label-safe, no email.
    posts.length = 0;
    await withQueryLabels(
      {
        mako_source: "agent",
        mako_trigger: "mcp",
        mako_tool: "sql_execute_query",
        mako_user: "Joan.R@RealAdvisor.com",
      },
      () => service.executeQuery(database, "SELECT 1", {}),
    );
    const labels = posts[0].body.labels as Record<string, string>;
    assert.equal(labels.mako_caller_kind, "agent");
    assert.equal(labels.mako_surface, "mcp");
    assert.match(labels.mako_caller, /^h_[0-9a-f]{12}$/);
    for (const [key, value] of Object.entries(labels)) {
      assert.match(key, /^[a-z][a-z0-9_-]{0,62}$/);
      assert.match(value, /^[a-z0-9_-]{1,63}$/);
      // mako_user is the caller id the entry point set (never an email).
      if (key !== "mako_user") {
        assert.equal(value.includes("realadvisor"), false);
      }
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
  assert.equal(isInteractiveJob({ mako_source: "console" }), true);
  assert.equal(isInteractiveJob({ mako_source: "cdc" }), false);
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
  // The workspace setting sits between the connection and the default.
  const GIB = 1024 ** 3;
  const agent = { mako_source: "agent" };
  assert.equal(
    resolveAgentJobCaps({ connection: {}, labels: agent, workspaceGb: 50 })
      .maximumBytesBilled,
    50 * GIB,
  );
  assert.equal(
    resolveAgentJobCaps({
      connection: { agent_max_bytes_billed_gb: 5 },
      labels: agent,
      workspaceGb: 50,
    }).maximumBytesBilled,
    5 * GIB,
  );
  assert.equal(
    resolveAgentJobCaps({ connection: {}, labels: agent, workspaceGb: 0 })
      .maximumBytesBilled,
    undefined,
  );
  // With no connection or workspace setting a console is not capped.
  assert.deepEqual(
    resolveAgentJobCaps({ connection: {}, labels: { mako_source: "console" } }),
    {},
  );
  // Sync paths ignore the workspace setting.
  assert.deepEqual(
    resolveAgentJobCaps({
      connection: {},
      labels: { mako_source: "flow" },
      workspaceGb: 1,
    }),
    {},
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
  // The message gives the estimate, the cap and the override to pass.
  const refusal = describeBytesBilledCap(
    "Query exceeded limit for bytes billed: 21474836480. 118979999744 or higher required.",
    20 * 1024 ** 3,
  );
  assert.match(refusal ?? "", /would bill 110\.8 GiB/);
  assert.match(refusal ?? "", /over the 20 GiB maximumBytesBilled cap/);
  assert.match(refusal ?? "", /maxBytesBilled: 119185342464/);
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
