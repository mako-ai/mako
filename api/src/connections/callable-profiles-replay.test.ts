/**
 * Replays the calls three workspace workflows make through the `type: close`
 * connections (privacy-request, access-offboarding, tam-fr-weekly) and pins
 * the request each one puts on the wire.
 *
 * A stored `close` connection, its api_key encrypted with a test key, goes
 * through connectionRequest. The transport is replaced (the base URL is fixed
 * and the real one refuses private addresses), so the test sees the outgoing
 * method, URL, headers and body byte for byte.
 *
 * fixtures/callable-profiles-replay-expected.json was written on master while the
 * built-in connector folder (api/src/connectors/close) still existed:
 *
 *   CLOSE_REPLAY_WRITE=1 pnpm --filter api exec tsx src/connections/callable-profiles-replay.test.ts
 *
 * The same file must pass with the folder deleted: Close then runs on the
 * profile in connections/callable-profiles, with no connector behind it.
 *
 * Run with: pnpm --filter api exec tsx src/connections/callable-profiles-replay.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { connectionsRepo } from "../repositories/connections";
import { ensureTestWorkspace, setupPgTestDb } from "../test-support/pg-test";

import { databaseConnectionService } from "../services/database-connection.service";
import { encryptString } from "../services/crypto.service";
import { isOrphanConnectorType } from "../connectors/source-connection-create.service";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { setTransportForTests, type ForwardInput } from "./forward";
import { connectionRequest } from "./proxy.service";

const EXPECTED = path.join(
  __dirname,
  "fixtures",
  "callable-profiles-replay-expected.json",
);
const SCHEMAS = path.join(
  __dirname,
  "fixtures",
  "callable-profiles-schemas.json",
);
const KEY = "api_test_close_key_0123456789";

type Case = {
  name: string;
  workflow: string;
  write: boolean;
  /** The connection's name and type; close when left out. */
  conn?: string;
  request?: ForwardInput;
  operation?: { name: string; params?: Record<string, unknown> };
};

// The calls the three workflows make, as their clients build them.
const CASES: Case[] = [
  {
    name: "privacy-request lead lookup",
    workflow: "privacy-request",
    write: false,
    request: {
      method: "GET",
      path: "/lead/",
      query: {
        query: 'email:"jane@example.com"',
        _fields: "id,contacts",
        _limit: "100",
        _skip: "0",
      },
    },
  },
  {
    name: "privacy-request activities read",
    workflow: "privacy-request",
    write: false,
    request: {
      method: "GET",
      path: "/activity/",
      query: {
        lead_id: "lead_abc123",
        date_created__gte: "2026-05-20T00:00:00.000Z",
        _limit: "100",
        _fields: "_type,date_created",
      },
    },
  },
  {
    name: "privacy-request block phone",
    workflow: "privacy-request",
    write: true,
    request: {
      method: "POST",
      path: "/blocked_phone_number/",
      body: { phone: "+41791234567", reason: "privacy request" },
    },
  },
  {
    name: "access-offboarding me",
    workflow: "access-offboarding",
    write: false,
    request: {
      method: "GET",
      path: "/me/",
      query: { _fields: "id,memberships" },
    },
  },
  {
    name: "access-offboarding organization",
    workflow: "access-offboarding",
    write: false,
    request: {
      method: "GET",
      path: "/organization/orga_xyz/",
      query: { _fields: "memberships" },
    },
  },
  {
    name: "access-offboarding delete membership",
    workflow: "access-offboarding",
    write: true,
    request: { method: "DELETE", path: "/membership/memb_123/" },
  },
  {
    name: "tam-fr-weekly read",
    workflow: "tam-fr-weekly",
    write: false,
    request: {
      method: "GET",
      path: "/lead/",
      query: { query: "name:acme", _limit: "50" },
    },
  },
  {
    name: "tam-fr-weekly data search",
    workflow: "tam-fr-weekly",
    write: false,
    request: {
      method: "POST",
      path: "/data/search/",
      body: {
        query: {
          type: "and",
          queries: [{ type: "object_type", object_type: "lead" }],
        },
        _limit: 100,
      },
    },
  },
  {
    name: "tam-fr-weekly create lead",
    workflow: "tam-fr-weekly",
    write: true,
    request: { method: "POST", path: "/lead/", body: { name: "Acme SA" } },
  },
  {
    name: "method override read (POST as GET)",
    workflow: "tam-fr-weekly",
    write: false,
    request: {
      method: "POST",
      path: "/lead/",
      headers: { "X-HTTP-Method-Override": "GET" },
      body: { query: "name:acme" },
    },
  },
  // PostHog: the two named operations, as an agent or a workflow calls them.
  {
    name: "posthog hogql",
    conn: "posthog",
    workflow: "agent",
    write: false,
    operation: {
      name: "hogql",
      params: { query: "select count() from events limit 10" },
    },
  },
  {
    name: "posthog search_persons",
    conn: "posthog",
    workflow: "agent",
    write: false,
    operation: {
      name: "search_persons",
      params: { search: "jane@example.com" },
    },
  },
  {
    name: "posthog raw query body",
    conn: "posthog",
    workflow: "agent",
    write: false,
    request: {
      method: "POST",
      path: "/api/projects/12345/query/",
      body: { query: { kind: "HogQLQuery", query: "select 1" } },
    },
  },
  {
    name: "posthog insight post writes",
    conn: "posthog",
    workflow: "agent",
    write: true,
    request: {
      method: "POST",
      path: "/api/projects/12345/insights/",
      body: {},
    },
  },
  {
    name: "stripe get_customer",
    conn: "stripe",
    workflow: "agent",
    write: false,
    operation: { name: "get_customer", params: { id: "cus_123" } },
  },
  {
    name: "stripe form post with caller header",
    conn: "stripe",
    workflow: "agent",
    write: true,
    request: {
      method: "POST",
      path: "/v1/customers",
      headers: { "Stripe-Account": "acct_1" },
      body: { email: "a@b.c", name: "Jane" },
    },
  },
  {
    name: "custom_api bearer get",
    conn: "custom_api",
    workflow: "agent",
    write: false,
    request: { method: "GET", path: "/things", query: { page: "2" } },
  },
  {
    name: "custom_api post writes",
    conn: "custom_api",
    workflow: "agent",
    write: true,
    request: { method: "POST", path: "/things", body: { a: 1 } },
  },
  {
    name: "wise get profiles",
    conn: "wise",
    workflow: "agent",
    write: false,
    request: { method: "GET", path: "/v2/profiles" },
  },
  {
    name: "wise post writes",
    conn: "wise",
    workflow: "agent",
    write: true,
    request: { method: "POST", path: "/v3/profiles/1/quotes", body: { a: 1 } },
  },
  {
    name: "custom_api api key in a header",
    conn: "custom_api_header",
    workflow: "agent",
    write: false,
    request: { method: "GET", path: "/things" },
  },
  {
    name: "custom_api api key in the query string",
    conn: "custom_api_query",
    workflow: "agent",
    write: false,
    request: { method: "GET", path: "/things", query: { page: "2" } },
  },
  {
    name: "custom_api basic auth",
    conn: "custom_api_basic",
    workflow: "agent",
    write: false,
    request: { method: "GET", path: "/things" },
  },
  {
    name: "posthog project api key",
    conn: "posthog_project_key",
    workflow: "agent",
    write: false,
    operation: {
      name: "search_persons",
      params: { search: "jane@example.com" },
    },
  },
];

type Wire = {
  url: string;
  method: unknown;
  headers: unknown;
  body: unknown;
};

async function main() {
  const h = await setupPgTestDb();
  try {
    process.env.ENCRYPTION_KEY = "ab".repeat(32);

    const sent: Wire[] = [];
    setTransportForTests(async (url, options) => {
      sent.push({
        url,
        method: options.method,
        headers: options.headers,
        body: options.body,
      });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ ok: true })),
      };
    });

    const { id: ws } = await ensureTestWorkspace(h.db, {
      ownerUserId: "deployer",
    });
    const enc = encryptString;
    const stored: Record<
      string,
      { type: string; config: Record<string, unknown> }
    > = {
      close: { type: "close", config: { api_key: enc(KEY) } },
      posthog: {
        type: "posthog",
        config: { api_key: enc(KEY), project_id: "12345" },
      },
      stripe: { type: "stripe", config: { api_key: enc(KEY) } },
      custom_api: {
        type: "custom_api",
        config: {
          base_url: "https://api.example.com/v1",
          auth_type: "bearer",
          token: enc(KEY),
        },
      },
      custom_api_header: {
        type: "custom_api",
        config: {
          base_url: "https://api.example.com/v1",
          auth_type: "api_key_header",
          header_name: "X-Custom-Key",
          token: enc(KEY),
        },
      },
      custom_api_query: {
        type: "custom_api",
        config: {
          base_url: "https://api.example.com/v1",
          auth_type: "api_key_query",
          query_param: "key",
          token: enc(KEY),
        },
      },
      custom_api_basic: {
        type: "custom_api",
        config: {
          base_url: "https://api.example.com/v1",
          auth_type: "basic",
          username: enc("svc-user"),
          password: enc(KEY),
        },
      },
      posthog_project_key: {
        type: "posthog",
        config: {
          api_key: enc(KEY),
          project_id: "12345",
          auth_type: "project_api_key",
        },
      },
      wise: {
        type: "wise",
        config: { api_key: enc(KEY), sca_private_key: enc("pem-test-key") },
      },
    };
    for (const [name, { type, config }] of Object.entries(stored)) {
      const row = await connectionsRepo.createSourceConnection({
        workspaceId: ws,
        name,
        type,
        config,
        settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
        createdBy: "deployer",
        liveReads: true,
        writers: [{ principal: "workflow:*" }],
      });
      // The ciphertext, not the key, is what is stored.
      assert.ok(!JSON.stringify(row.config).includes(KEY));
    }

    const writing = process.env.CLOSE_REPLAY_WRITE === "1";
    const got: Record<string, unknown> = {};
    for (const c of CASES) {
      sent.length = 0;
      try {
        const result = await connectionRequest({
          workspaceId: String(ws),
          connection: c.conn ?? "close",
          request: c.request,
          operation: c.operation,
          actor: `workflow:${c.workflow}`,
          runStarter: async () => ({ starter: "trigger", writes: "send" }),
        });
        assert.equal(sent.length, 1, `${c.name}: one request sent`);
        assert.equal(result.read, !c.write, `${c.name}: read or write`);
        got[c.name] = {
          sent: sent[0],
          read: result.read,
          status: result.status,
        };
      } catch (error) {
        // Writing on a checkout where a type has no profile (wise on master)
        // skips that case; its entry comes from the commit that had one.
        if (!writing) throw error;
      }
    }

    if (writing) {
      const kept = fs.existsSync(EXPECTED)
        ? JSON.parse(fs.readFileSync(EXPECTED, "utf8"))
        : {};
      fs.writeFileSync(
        EXPECTED,
        JSON.stringify({ ...kept, ...got }, null, 2) + "\n",
      );
    } else {
      const expected = JSON.parse(fs.readFileSync(EXPECTED, "utf8"));
      assert.deepEqual(
        JSON.parse(JSON.stringify(got)),
        expected,
        "the outgoing requests match the ones captured before the move",
      );
    }

    // No credential in the stored row's plain form, and the key is on the wire
    // as basic auth with the key as username and an empty password.
    const auth = JSON.stringify(got["privacy-request lead lookup"]);
    assert.ok(
      auth.includes(Buffer.from(`${KEY}:`).toString("base64")),
      "basic auth, api_key as username, empty password",
    );

    // A callable type is known to the proxy and to config edits, and its
    // schema is the one its connector had (fixtures/callable-profiles-schemas.json).
    const schemas = JSON.parse(fs.readFileSync(SCHEMAS, "utf8")) as Record<
      string,
      unknown
    >;
    // Loaded here: master, where the baseline is written, has no registry.
    const { callableProfileSchemaFor } = writing
      ? { callableProfileSchemaFor: () => null }
      : await import("./callable-profiles");
    const types = [...new Set(Object.values(stored).map(c => c.type))];
    for (const type of writing ? [] : types) {
      assert.equal(
        await isOrphanConnectorType(type, String(ws), { callable: true }),
        false,
        `${type} is callable`,
      );
      const schema = await syncConnectorRegistry.getConfigSchemaForType(type);
      assert.deepEqual(
        JSON.parse(JSON.stringify(schema)),
        schemas[type],
        `${type} config schema`,
      );
      // The profile's own schema, which is what stays once the connector
      // folder is gone, is the same one.
      assert.deepEqual(
        JSON.parse(JSON.stringify(callableProfileSchemaFor(type))),
        schemas[type],
        `${type} profile schema`,
      );
    }
  } finally {
    setTransportForTests(null);
    await databaseConnectionService.closeAllConnections();
    await h.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
