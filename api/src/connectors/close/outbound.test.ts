import assert from "node:assert/strict";
import { CloseConnector } from "./connector";

async function main() {
  const connector = new CloseConnector({
    _id: "connector_1",
    name: "Close",
    type: "close",
    config: { api_key: "test" },
    settings: { rate_limit_delay_ms: 0 },
  } as any);

  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  (connector as any).closeApi = {
    async get(path: string) {
      calls.push({ method: "get", path });
      if (path === "/status/lead/") {
        return { data: { data: [{ id: "stat_1", label: "Qualified" }] } };
      }
      if (path === "/lead/lead_1/") {
        return {
          data: {
            id: "lead_1",
            name: "Existing",
            "custom.cf_arr": null,
            primary_email: { email: "jane@acme.com" },
          },
        };
      }
      return { data: {} };
    },
    async post(path: string, body: unknown) {
      calls.push({ method: "post", path, body });
      return {
        data: {
          data: [
            {
              id: "lead_1",
              name: "Existing",
              "custom.cf_arr": null,
              primary_email: { email: "jane@acme.com" },
            },
          ],
        },
      };
    },
    async put(path: string, body: unknown) {
      calls.push({ method: "put", path, body });
      return { data: { id: "lead_1" } };
    },
  };

  const schema = await connector.resolveOutboundSchema("leads");
  assert.equal(schema.fields.status_id.enumValues?.[0].value, "stat_1");
  assert.equal(schema.fields.id.writable, false);
  assert.equal(schema.fields.name.writable, true);

  const dryRun = await connector.writeBatch({
    entity: "leads",
    records: [
      {
        sourcePk: "jane@acme.com",
        payload: {
          name: "Jane Doe",
          custom: { cf_arr: 1200 },
          email: "jane@acme.com",
        },
      },
    ],
    writeMode: "upsert",
    updateFieldStrategy: "fill_empty",
    match: { lookupColumn: "email", remoteField: "email", onMultiple: "skip" },
    dryRun: true,
  });

  assert.equal(dryRun.results[0].status, "updated");
  assert.equal(dryRun.results[0].remoteId, "lead_1");
  assert.equal(
    calls.some(call => call.method === "put"),
    false,
  );
  assert.equal(
    dryRun.results[0].fieldDiffs?.some(
      diff => diff.field === "name" && diff.willOverwrite === false,
    ),
    true,
  );
  assert.equal(
    dryRun.results[0].fieldDiffs?.some(diff => diff.field === "custom.cf_arr"),
    true,
  );

  (connector as any).closeApi.post = async (path: string, body: unknown) => {
    calls.push({ method: "post", path, body });
    return { data: { data: [{ id: "lead_1" }, { id: "lead_2" }] } };
  };

  const ambiguous = await connector.writeBatch({
    entity: "leads",
    records: [{ sourcePk: "dup", payload: { email: "dup@example.com" } }],
    writeMode: "upsert",
    updateFieldStrategy: "overwrite",
    match: { lookupColumn: "email", remoteField: "email", onMultiple: "skip" },
    dryRun: true,
  });

  assert.equal(ambiguous.results[0].status, "ambiguous");
  assert.equal(ambiguous.results[0].matchCount, 2);
}

void main();
