/**
 * Every BigQuery job Mako starts carries `mako_*` labels, so slot-hours can
 * be attributed per app, console, flow and source. Pins: the sanitizer keeps
 * labels inside BigQuery's rules (an invalid label fails the query), nested
 * contexts merge the way entry points rely on, each request builder in
 * database-connection.service.ts sends them, the emulator gets none, the CDC
 * adapter labels its calls, and the CDC LOAD job's labels land in
 * `configuration.labels` through the real SDK upload path.
 *
 * Run: tsx src/services/bigquery-labels.test.ts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BigQuery } from "@google-cloud/bigquery";
import {
  bigQueryJobLabels,
  bindingActorLabels,
  currentQueryLabels,
  sanitizeBigQueryLabels,
  withDefaultQueryLabels,
  withQueryLabels,
} from "./bigquery-labels";
import { databaseConnectionService } from "./database-connection.service";
import { withToolQueryLabels } from "../agent-lib/tool-query-labels";
import { resolveCdcDestinationAdapter } from "../sync-cdc/adapters/registry";
import { BigQueryDestinationAdapter } from "../sync-cdc/adapters/bigquery";
import {
  canLabelLoadJobs,
  enableLoadJobLabels,
} from "../sync-cdc/adapters/bigquery-load-labels";

function testSanitizer(): void {
  assert.deepEqual(
    sanitizeBigQueryLabels({
      Mako_Source: "App Binding",
      mako_app: "Sales/Weekly Report.v2",
      mako_empty: "",
      mako_null: null,
      mako_undef: undefined,
      "9lives": "x",
      "": "dropped",
    }),
    {
      mako_source: "app_binding",
      mako_app: "sales_weekly_report_v2",
      l_9lives: "x",
    },
  );

  const long = "a".repeat(100);
  const out = sanitizeBigQueryLabels({ [long]: long });
  const [[key, value]] = Object.entries(out);
  assert.equal(key.length, 63);
  assert.equal(value.length, 63);

  // Whitespace is invalid too: it becomes underscores.
  assert.deepEqual(sanitizeBigQueryLabels({ mako_x: "   " }), {
    mako_x: "___",
  });

  const many: Record<string, string> = {};
  for (let i = 0; i < 70; i++) many[`k${i}`] = "v";
  assert.equal(Object.keys(sanitizeBigQueryLabels(many)).length, 64);

  for (const [k, v] of Object.entries(
    sanitizeBigQueryLabels({ "Ünïcode Key": "Émoji 🚀 value" }),
  )) {
    assert.match(k, /^[a-z][a-z0-9_-]{0,62}$/);
    assert.match(v, /^[a-z0-9_-]{1,63}$/);
  }
}

async function testContext(): Promise<void> {
  assert.deepEqual(currentQueryLabels(), {});

  await withQueryLabels(
    { mako_source: "agent", mako_user: "u1", mako_chat: "c1" },
    async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      // The inner context wins a shared key and keeps the outer ones.
      await withQueryLabels(
        { mako_source: "console", mako_console: "k1", mako_user: undefined },
        async () => {
          await Promise.resolve();
          assert.deepEqual(currentQueryLabels(), {
            mako_source: "console",
            mako_user: "u1",
            mako_chat: "c1",
            mako_console: "k1",
          });
        },
      );
      // A default never overrides what the caller already said.
      withDefaultQueryLabels(
        { mako_trigger: "user", mako_user: "fallback" },
        () => {
          assert.equal(currentQueryLabels().mako_user, "u1");
          assert.equal(currentQueryLabels().mako_trigger, "user");
        },
      );
      assert.equal(currentQueryLabels().mako_source, "agent");
    },
  );
  assert.deepEqual(currentQueryLabels(), {});

  // Always a source, the workspace from the connection, explicit wins.
  assert.deepEqual(bigQueryJobLabels({ workspaceId: "WS1" }), {
    mako_source: "other",
    mako_workspace: "ws1",
  });
  withQueryLabels({ mako_source: "agent", mako_workspace: "ctx" }, () => {
    assert.deepEqual(
      bigQueryJobLabels({
        workspaceId: "db",
        explicit: { mako_source: "export" },
      }),
      { mako_source: "export", mako_workspace: "ctx" },
    );
  });

  assert.deepEqual(bindingActorLabels("scheduler"), {
    mako_trigger: "scheduler",
  });
  assert.deepEqual(bindingActorLabels(""), { mako_trigger: "public" });
  assert.deepEqual(bindingActorLabels("abc123"), {
    mako_trigger: "user",
    mako_user: "abc123",
  });

  // Agent tools: the context is entered inside execute.
  const tools = withToolQueryLabels(
    {
      sql_execute_query: {
        execute: async () => currentQueryLabels(),
      },
    } as never,
    { mako_trigger: "chat", mako_chat: "c9" },
  ) as unknown as Record<string, { execute: () => Promise<unknown> }>;
  assert.deepEqual(await tools.sql_execute_query.execute(), {
    mako_source: "agent",
    mako_trigger: "chat",
    mako_chat: "c9",
    mako_tool: "sql_execute_query",
  });
}

type Post = { url: string; body: Record<string, unknown> };

async function testRequestBodies(): Promise<void> {
  const posts: Post[] = [];
  const fakeClient = {
    post: async (url: string, body: Record<string, unknown>) => {
      posts.push({ url, body });
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
  const service = databaseConnectionService as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const original = service.getBigQueryHttpClient;
  service.getBigQueryHttpClient = async () => fakeClient;

  const database = (apiBaseUrl?: string) => ({
    _id: "db1",
    workspaceId: "ws1",
    type: "bigquery",
    connection: {
      project_id: "proj",
      service_account_json: "{}",
      location: "EU",
      ...(apiBaseUrl ? { api_base_url: apiBaseUrl } : {}),
    },
  });

  const expected = {
    mako_source: "app_binding",
    mako_app: "sales",
    mako_workspace: "ws1",
  };

  try {
    await withQueryLabels(
      { mako_source: "app_binding", mako_app: "Sales" },
      async () => {
        await service.executeBigQueryQuery(database(), "SELECT 1", {});
        await service.executeBigQueryPreviewQuery(database(), "SELECT 1", {});
        await service.executeBigQueryStreamingQuery(database(), "SELECT 1", {
          onBatch: async () => undefined,
        });
        await service.getBigQueryQuerySchema(database(), "SELECT 1");
      },
    );
    assert.equal(posts.length, 4);
    for (const post of posts) {
      assert.equal(post.url, "/projects/proj/queries");
      assert.deepEqual(post.body.labels, expected, JSON.stringify(post.body));
    }
    assert.equal(posts[3].body.dryRun, true);

    // Explicit labels on the query win over the context.
    posts.length = 0;
    await withQueryLabels({ mako_source: "agent" }, () =>
      service.executeBigQueryQuery(database(), "SELECT 1", {
        labels: { mako_source: "console", mako_console: "c1" },
      }),
    );
    assert.deepEqual(posts[0].body.labels, {
      mako_source: "console",
      mako_console: "c1",
      mako_workspace: "ws1",
    });

    // No context at all still says where to look.
    posts.length = 0;
    await service.executeBigQueryQuery(database(), "SELECT 1", {});
    assert.deepEqual(posts[0].body.labels, {
      mako_source: "other",
      mako_workspace: "ws1",
    });

    // A local emulator gets no labels: its jobs cost nothing.
    posts.length = 0;
    await service.executeBigQueryQuery(
      database("http://localhost:9050"),
      "SELECT 1",
      {},
    );
    assert.equal("labels" in posts[0].body, false);
  } finally {
    service.getBigQueryHttpClient = original;
  }
}

async function testCdcAdapterLabels(): Promise<void> {
  const proto = BigQueryDestinationAdapter.prototype as unknown as {
    ensureLiveTable: (...args: unknown[]) => Promise<unknown>;
  };
  const original = proto.ensureLiveTable;
  proto.ensureLiveTable = async () => currentQueryLabels();
  try {
    const adapter = resolveCdcDestinationAdapter({
      destinationType: "bigquery",
      destinationDatabaseId: "db1",
      flowId: "flow1",
      tableDestination: {
        connectionId: "db1",
        schema: "raw_stripe",
        tableName: "charges",
      },
    });
    assert.equal(adapter.destinationType, "bigquery");
    assert.deepEqual(await adapter.ensureLiveTable({} as never), {
      mako_source: "cdc",
      mako_flow: "flow1",
      mako_dataset: "raw_stripe",
      mako_table: "charges",
    });
  } finally {
    proto.ensureLiveTable = original;
  }
}

/**
 * The real SDK path: `table.load(localFile, metadata)` uploads a multipart
 * request whose JSON part is the job. Its labels must sit in
 * `configuration.labels`; left in `configuration.load` BigQuery rejects the
 * job. If an SDK upgrade changes this shape, this fails before CDC does.
 */
async function testLoadJobLabels(): Promise<void> {
  const bq = new BigQuery({
    projectId: "proj",
    credentials: { client_email: "x@y.z", private_key: "k" },
  });
  let captured: { multipart?: Array<{ body: unknown }> } | undefined;
  (
    bq as unknown as { makeAuthenticatedRequest: unknown }
  ).makeAuthenticatedRequest = (
    reqOpts: typeof captured,
    callbacks: { onAuthenticated: (err: Error | null) => void },
  ) => {
    captured = reqOpts;
    callbacks.onAuthenticated(new Error("stop before the network"));
  };
  assert.equal(canLabelLoadJobs(bq), false);
  enableLoadJobLabels(bq);
  enableLoadJobLabels(bq);
  assert.equal(canLabelLoadJobs(bq), true);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bq-labels-"));
  const file = path.join(dir, "rows.parquet");
  await fs.writeFile(file, Buffer.from("PAR1 not really"));
  try {
    await bq
      .dataset("raw")
      .table("stg")
      .load(file, {
        sourceFormat: "PARQUET",
        labels: { mako_source: "cdc", mako_flow: "f1" },
      } as never)
      .then(
        () => assert.fail("the fake request must fail"),
        (error: Error) => assert.match(error.message, /stop before/),
      );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  assert.ok(captured?.multipart, "the load must go through the wrapper");
  const job = JSON.parse(String(captured.multipart[0].body));
  assert.deepEqual(job.configuration.labels, {
    mako_source: "cdc",
    mako_flow: "f1",
  });
  assert.equal("labels" in job.configuration.load, false);
  assert.equal(job.configuration.load.sourceFormat, "PARQUET");
}

async function main(): Promise<void> {
  testSanitizer();
  await testContext();
  await testRequestBodies();
  await testCdcAdapterLabels();
  await testLoadJobLabels();
  console.log("bigquery-labels: all assertions passed");
}

void main();
