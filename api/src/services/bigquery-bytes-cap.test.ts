/**
 * A read-only BigQuery query from an agent tool or the MCP server carries a
 * `maximumBytesBilled`; nothing else does. Pins: the engine sends the cap it
 * is given as the REST API's int64 string, sends none when not given one
 * (consoles, apps, flows, dbt), and BigQuery's refusal is reworded for the
 * caller who has to change the query.
 *
 * Run: tsx src/services/bigquery-bytes-cap.test.ts
 */
import assert from "node:assert/strict";
import { bigQueryEngine } from "../databases/drivers/bigquery/engine";
import { describeBytesBilledCap } from "../databases/drivers/bigquery/errors";
import { AGENT_BIGQUERY_MAX_BYTES_BILLED } from "../config/long-running-queries";

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
    assert.match(refused.error ?? "", /limit for bytes billed/);
    const readable = describeBytesBilledCap(refused.error, 107374182400);
    assert.ok(readable);
    assert.match(readable, /would bill 200 GiB on BigQuery/);
    assert.match(readable, /over the 100 GiB cap on agent and MCP queries/);
    assert.match(readable, /did not run and cost nothing/);
    assert.match(readable, /partition column/);
    assert.match(readable, /AGENT_BIGQUERY_MAX_BYTES_BILLED/);
  } finally {
    service.getHttpClient = original;
  }
}

function testOtherErrors(): void {
  assert.equal(describeBytesBilledCap(undefined, 1), null);
  assert.equal(
    describeBytesBilledCap("Syntax error: Unexpected keyword FROM", 1),
    null,
  );
  // 1 TiB unless the operator sets another cap.
  if (process.env.AGENT_BIGQUERY_MAX_BYTES_BILLED === undefined) {
    assert.equal(AGENT_BIGQUERY_MAX_BYTES_BILLED, 1024 ** 4);
  }
  assert.match(
    describeBytesBilledCap(
      "Query exceeded limit for bytes billed",
      1024 ** 4,
    ) ?? "",
    /would bill more on BigQuery, over the 1 TiB cap/,
  );
}

async function main(): Promise<void> {
  await testRequestBody();
  testOtherErrors();
  console.info("bigquery bytes cap tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
