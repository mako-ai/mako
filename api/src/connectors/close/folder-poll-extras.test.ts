/**
 * What the Close folder (`connectors/close/`) reads by polling that the
 * in-process connector gets only from webhooks (the harness's `FOLDER_ONLY`):
 *
 * - `custom_fields` reads all 6 custom-field lists, activity and
 *   custom-object fields included, each typed;
 * - `users` reads the organization's memberships: `is_active` on every
 *   user, and a deactivated user marked deleted with name and email kept.
 *
 * It runs the folder's own modules against the harness's Close emulator
 * over the synthetic dataset (users 6 and 7 deactivated), then the users
 * rows through the box path's schema translation and the engine's payload
 * normalization, to the columns the warehouse writes. Nothing calls Close.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FOLDER,
  FOLDER_ONLY,
  startRecordingServer,
  withoutFolderOnly,
} from "../../../../connectors/close/fixtures/harness.mjs";
import { buildDataset } from "../../../../connectors/close/fixtures/dataset.mjs";
import { jsonSchemaToEntitySchema } from "../workspace/spec-translation";
import { normalizePayloadBySchema } from "../../sync-cdc/normalization";

/** The folder's modules: they import with `.ts` extensions. */
const load = (file: string) =>
  import(pathToFileURL(path.join(FOLDER, file)).href);

type Row = Record<string, unknown>;
interface Client {
  get<T = any>(endpoint: string, params?: Record<string, unknown>): Promise<T>;
}

let createCloseClient: (options: {
  apiKey: string;
  baseUrl: string;
  minDelayMs: number;
}) => Client;
let readMembershipStatus: (
  api: Client,
  log: (message: string) => void,
) => Promise<Map<string, boolean> | null>;
let withMembershipStatus: (
  records: unknown[],
  status: Map<string, boolean> | null,
  readAt: string,
) => Row[];
let readAllCustomFields: (
  api: Client,
  log: (message: string) => void,
) => Promise<Row[]>;
let closeJsonSchema: (entity: string) => Record<string, unknown>;

type Server = Awaited<ReturnType<typeof startRecordingServer>>;
let server: Server;
const dataset = buildDataset() as {
  lists: Record<string, Row[]>;
  organization: {
    memberships: Array<{ user_id: string }>;
    inactive_memberships: Array<{ user_id: string }>;
  };
};

const client = (apiKey: string, baseUrl = server.url) =>
  createCloseClient({ apiKey, baseUrl, minDelayMs: 0 });

before(async () => {
  ({ createCloseClient } = await load("client.ts"));
  ({ readMembershipStatus, withMembershipStatus } =
    await load("memberships.ts"));
  ({ readAllCustomFields } = await load("lists.ts"));
  ({ closeJsonSchema } = await load("schema.ts"));
  server = await startRecordingServer(dataset);
});

after(async () => {
  await server?.close();
});

const READ_AT = "2026-11-16T12:00:00.000Z";

void test("users: is_active from the memberships, deactivated users marked deleted", async () => {
  const api = client("api_test_memberships");
  const status = await readMembershipStatus(api, () => {});
  const users = dataset.lists["/user/"];
  const rows = withMembershipStatus(users, status, READ_AT);

  assert.equal(rows.length, 7);
  const inactive = new Set(
    dataset.organization.inactive_memberships.map(m => m.user_id),
  );
  assert.equal(inactive.size, 2);
  for (const [i, row] of rows.entries()) {
    const deactivated = inactive.has(String(row.id));
    assert.equal(row.is_active, !deactivated, String(row.id));
    assert.equal(row.is_deleted, deactivated ? true : undefined);
    assert.equal(row._mako_deleted_at, deactivated ? READ_AT : undefined);
    // Real data stays: a deactivated user keeps name and email.
    assert.equal(row.first_name, users[i].first_name);
    assert.equal(row.email, users[i].email);
  }
  // `/me/` for the organization, then one organization read.
  assert.deepEqual(server.requests("api_test_memberships"), [
    "GET /me/",
    "GET /organization/orga_fixture000000000000000000000000000000/?_fields=id,memberships,inactive_memberships",
  ]);
  // The input rows are not mutated.
  assert.equal("is_active" in users[0], false);
});

void test("users: a user in neither membership list has is_active null", () => {
  const rows = withMembershipStatus(
    [{ id: "user_other" }, { id: "user_a" }],
    new Map([["user_a", true]]),
    READ_AT,
  );
  assert.deepEqual(rows, [
    { id: "user_other", is_active: null },
    { id: "user_a", is_active: true },
  ]);
  // No membership data at all (a key that may not read the organization).
  assert.deepEqual(withMembershipStatus([{ id: "user_a" }], null, READ_AT), [
    { id: "user_a", is_active: null },
  ]);
});

/** A Close that answers `/me/` and fails `/organization/` with `status`. */
async function failingClose(status: number) {
  const srv = http.createServer((req, res) => {
    const body =
      req.url?.startsWith("/api/v1/me/") === true
        ? { organizations: [{ id: "orga_x" }] }
        : { error: "nope" };
    res.writeHead(req.url?.startsWith("/api/v1/me/") ? 200 : status, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    close: () => new Promise(resolve => srv.close(resolve)),
  };
}

void test("users: a forbidden organization leaves the status unknown, a 401 fails the chunk", async () => {
  const forbidden = await failingClose(403);
  try {
    const logs: string[] = [];
    const status = await readMembershipStatus(
      client("api_test_forbidden", forbidden.url),
      m => logs.push(m),
    );
    assert.equal(status, null);
    assert.match(logs.join("\n"), /403/);
  } finally {
    await forbidden.close();
  }
  const unauthorized = await failingClose(401);
  try {
    await assert.rejects(
      readMembershipStatus(client("api_test_401", unauthorized.url), () => {}),
    );
  } finally {
    await unauthorized.close();
  }
});

void test("users: the deleted mark reaches the warehouse columns through the box path", () => {
  const schema = jsonSchemaToEntitySchema("users", {
    name: "users",
    json_schema: closeJsonSchema("users"),
  } as any);
  assert.equal(schema.fields.is_active?.type, "boolean");
  const [active, deactivated] = withMembershipStatus(
    [{ id: "user_a" }, { id: "user_b", first_name: "B" }],
    new Map([
      ["user_a", true],
      ["user_b", false],
    ]),
    READ_AT,
  ).map(row => normalizePayloadBySchema(row, schema).payload);

  assert.equal(active.is_active, true);
  assert.equal(active.is_deleted, false);
  assert.equal(active._mako_deleted_at ?? null, null);

  assert.equal(deactivated.is_active, false);
  assert.equal(deactivated.is_deleted, true);
  assert.equal(
    new Date(deactivated._mako_deleted_at as string).toISOString(),
    READ_AT,
  );
  assert.equal(
    new Date(deactivated.deleted_at as string).toISOString(),
    READ_AT,
  );
  assert.equal(deactivated.first_name, "B");
});

void test("custom_fields: all 6 lists, activity and custom-object fields typed", async () => {
  const rows = await readAllCustomFields(client("api_test_cf"), () => {});
  const byType = (type: string) =>
    rows.filter(row => row.custom_field_type === type).map(row => row.id);
  for (const [type, route] of [
    ["lead", "/custom_field/lead/"],
    ["contact", "/custom_field/contact/"],
    ["opportunity", "/custom_field/opportunity/"],
    ["shared", "/custom_field/shared/"],
    ["activity", "/custom_field/activity/"],
    ["custom_object", "/custom_field/custom_object_type/"],
  ]) {
    const expected = dataset.lists[route].map(f => f.id);
    assert.ok(expected.length > 0, route);
    assert.deepEqual(byType(type), expected, type);
  }
  assert.deepEqual(server.requests("api_test_cf"), [
    "GET /custom_field/lead/",
    "GET /custom_field/contact/",
    "GET /custom_field/opportunity/",
    "GET /custom_field/shared/",
    "GET /custom_field/activity/",
    "GET /custom_field/custom_object_type/",
  ]);
});

void test("the harness holds the folder's extras apart and requires them", () => {
  assert.deepEqual(Object.keys(FOLDER_ONLY).sort(), ["custom_fields", "users"]);
  const inProcess = {
    rows: [{ id: "u1", first_name: "A" }],
    chunks: [],
    requests: ["GET /user/?_limit=100&_skip=0"],
  };
  const folder = {
    rows: [{ id: "u1", first_name: "A", is_active: true }],
    chunks: [],
    requests: [
      "GET /me/",
      "GET /organization/o/?_fields=x",
      "GET /user/?_limit=100&_skip=0",
    ],
  };
  const { run, folderOnly } = withoutFolderOnly("users", folder);
  assert.deepEqual(run.rows, inProcess.rows);
  assert.deepEqual(run.requests, inProcess.requests);
  assert.deepEqual(folderOnly, {
    rows: 0,
    columns: ["is_active"],
    requests: 2,
    ok: true,
  });
  // Without the membership read, the extras are missing: not ok.
  const bare = withoutFolderOnly("users", {
    ...folder,
    rows: inProcess.rows,
    requests: inProcess.requests,
  });
  assert.equal(bare.folderOnly?.ok, false);
  // Activity fields are dropped from the comparison, and required.
  const cf = withoutFolderOnly("custom_fields", {
    rows: [
      { id: "cf_1", custom_field_type: "lead" },
      { id: "cf_2", custom_field_type: "activity" },
    ],
    chunks: [],
    requests: ["GET /custom_field/lead/", "GET /custom_field/activity/"],
  });
  assert.deepEqual(
    cf.run.rows.map(r => r.id),
    ["cf_1"],
  );
  assert.equal(cf.folderOnly?.ok, true);
  assert.equal(withoutFolderOnly("groups", folder).folderOnly, undefined);
});
