import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConnector } from "./define.js";

const entity = { async *read() {} };

test("entity names may be snake_case, as Airbyte stream names are", () => {
  const connector = defineConnector({
    name: "stripe",
    version: "1.0.0",
    entities: { payment_intents: entity, "web-hooks": entity },
  });
  assert.deepEqual(connector.entityNames(), ["payment_intents", "web-hooks"]);
});

test("a sub-entity is parent:Type, as Close activities are", () => {
  const connector = defineConnector({
    name: "close",
    version: "1.0.0",
    entities: { "activities:Call": entity, "activities:EmailThread": entity },
  });
  assert.deepEqual(connector.entityNames(), [
    "activities:Call",
    "activities:EmailThread",
  ]);
  for (const bad of [
    "Activities:Call",
    "activities:",
    "activities:Call:x",
    ":Call",
  ]) {
    assert.throws(
      () =>
        defineConnector({
          name: "close",
          version: "1",
          entities: { [bad]: entity },
        }),
      /must be lowercase/,
      bad,
    );
  }
});

test("two entities that land on one table are refused", () => {
  for (const pair of [
    ["activities:Call", "call_activities"],
    ["activities:Call", "activities:call"],
    ["x:ABC", "x:Abc"],
  ]) {
    assert.throws(
      () =>
        defineConnector({
          name: "close",
          version: "1",
          entities: Object.fromEntries(pair.map(name => [name, entity])),
        }),
      /would both write to table/,
      pair.join(" + "),
    );
  }
});

test("entity names stay lowercase, and the connector name stays a slug", () => {
  assert.throws(
    () =>
      defineConnector({
        name: "acme",
        version: "1",
        entities: { Rows: entity },
      }),
    /entity "Rows" must be lowercase/,
  );
  assert.throws(
    () =>
      defineConnector({
        name: "acme_crm",
        version: "1",
        entities: { rows: entity },
      }),
    /name must be a lowercase slug/,
  );
});

test("spec carries each entity's layout and incremental mode for Mako to index", () => {
  const layout = { partitionField: "_syncedAt", partitionGranularity: "day", clusterFields: ["_dataSourceId", "id"] };
  const spec = defineConnector({
    name: "acme",
    version: "1",
    entities: {
      rows: { ...entity, label: "Rows", layout, incremental: "created-anchor" },
      plain: { ...entity, label: "Plain" },
    },
  }).spec();
  assert.deepEqual(spec.mako.entities.rows, {
    label: "Rows",
    description: undefined,
    layout,
    incremental: "created-anchor",
  });
  assert.equal("layout" in spec.mako.entities.plain, false);
  assert.equal("incremental" in spec.mako.entities.plain, false);
  assert.throws(
    () => defineConnector({ name: "acme", version: "1", entities: { rows: { ...entity, incremental: "sometimes" } } }),
    /incremental must be one of/,
  );
});

const webhookBase = () => ({
  name: "hooks",
  version: "1.0.0",
  entities: { items: { schema: { id: "string" }, async *read() {} } },
});
const closeVerification = {
  scheme: "hmac-sha256",
  secretEncoding: "hex",
  signedPayload: ["header:close-sig-timestamp", "body"],
  signatureHeader: "close-sig-hash",
  signatureEncoding: "hex",
};

test("webhooks need a handler and a verification Mako can run as data", () => {
  assert.throws(
    () => defineConnector({ ...webhookBase(), webhooks: { verification: closeVerification } }),
    /webhooks.handleBatch/,
  );
  const withVerification = verification =>
    defineConnector({ ...webhookBase(), webhooks: { handleBatch: () => [], verification } });
  assert.throws(() => withVerification({ ...closeVerification, scheme: "md5" }), /scheme must be one of hmac-sha256, stripe-v1/);
  assert.throws(
    () => withVerification({ ...closeVerification, signedPayload: ["header:close-sig-timestamp"] }),
    /must include "body"/,
  );
  assert.throws(
    () => withVerification({ ...closeVerification, signedPayload: ["body", "env:SECRET"] }),
    /"body", "header:<name>" or "literal:<text>"/,
  );
  const ok = withVerification(closeVerification);
  assert.deepEqual(ok.spec().mako.webhooks, { verification: closeVerification });
  assert.equal(ok.hasWebhooks(), true);
  assert.equal(defineConnector(webhookBase()).spec().mako.webhooks, undefined);
});

test("a webhook outcome must name its own event, in order", async () => {
  const connector = defineConnector({
    ...webhookBase(),
    webhooks: {
      verification: closeVerification,
      handleBatch: (_ctx, events) => events.map(e => ({ eventId: `${e.eventId}x`, outcome: "unmapped" })),
    },
  });
  await assert.rejects(
    connector.handleWebhooks({}, [{ eventId: "a", eventType: "t", rawPayload: {} }]),
    /must name event "a"/,
  );
});

test("a replay window needs its header and its tolerance together, within a day", () => {
  const define = verification =>
    defineConnector({ ...webhookBase(), webhooks: { handleBatch: () => [], verification } });
  assert.throws(() => define({ ...closeVerification, timestampHeader: "close-sig-timestamp" }), /go together/);
  assert.throws(
    () => define({ ...closeVerification, timestampHeader: "close-sig-timestamp", toleranceSeconds: 86_401 }),
    /from 1 to 86400/,
  );
  const ok = define({ ...closeVerification, timestampHeader: "close-sig-timestamp", toleranceSeconds: 300 });
  assert.equal(ok.spec().mako.webhooks.verification.toleranceSeconds, 300);
});

test("a declared timestamp must be part of the signed payload", () => {
  assert.throws(
    () =>
      defineConnector({
        ...webhookBase(),
        webhooks: {
          handleBatch: () => [],
          verification: {
            ...closeVerification,
            signedPayload: ["body"],
            timestampHeader: "x-ts",
            toleranceSeconds: 300,
          },
        },
      }),
    /must include "header:x-ts"/,
  );
});

test("stripe-v1 declares a header, a UTF-8 secret and a window, nothing else", () => {
  const define = verification => defineConnector({ ...webhookBase(), webhooks: { handleBatch: () => [], verification } });
  const stripe = {
    scheme: "stripe-v1",
    signatureHeader: "stripe-signature",
    secretEncoding: "utf8",
    toleranceSeconds: 300,
  };
  assert.deepEqual(define(stripe).spec().mako.webhooks.verification, stripe);
  assert.throws(() => define({ ...stripe, toleranceSeconds: undefined }), /from 1 to 86400/);
  assert.throws(() => define({ ...stripe, toleranceSeconds: 86_401 }), /from 1 to 86400/);
  assert.throws(() => define({ ...stripe, secretEncoding: "hex" }), /"utf8" for stripe-v1/);
  assert.throws(() => define({ ...stripe, signatureHeader: "Stripe-Signature" }), /lowercase header name/);
  assert.throws(() => define({ ...stripe, signedPayload: ["body"] }), /signedPayload is not part of the stripe-v1 scheme/);
  assert.throws(() => define({ ...stripe, scheme: "stripe-v2" }), /scheme must be one of hmac-sha256, stripe-v1/);
});

const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvO8vXV+JksBzZAY6GhSO
XdoTCfhXaaiZ+qAbtaDBiu2AGkGVpmEygFmWP4Li9m5+Ni85BhVvZOodM9epgW3F
bA5Q1SexvAF1PPjX4JpMstak/QhAgl1qMSqEevL8cmUeTgcMuVWCJmlge9h7B1CS
D4rtlimGZozG39rUBDg6Qt2K+P4wBfLblL0k4C4YUdLnpGYEDIth+i8XsRpFlogx
CAFyH9+knYsDbR43UJ9shtc42Ybd40Afihj8KnYKXzchyQ42aC8aZ/h5hyZ28yVy
Oj3Vos0VdBIs/gAyJ/4yyQFCXYte64I7ssrlbGRaco4nKF3HmaNhxwyKyJafz19e
HwIDAQAB
-----END PUBLIC KEY-----`;

const rsaVerification = {
  scheme: "rsa-sha256",
  publicKeys: [TEST_PUBLIC_KEY],
  signatureHeader: "x-signature-sha256",
  signatureEncoding: "base64",
};
const defineHooks = (verification, extra = {}) =>
  defineConnector({
    name: "hooks",
    version: "1.0.0",
    entities: { items: { schema: { id: "string" }, async *read() {} } },
    webhooks: { handleBatch: () => [], verification, ...extra },
  });

test("rsa-sha256 declares public keys, no secret, and an optional test ping", () => {
  assert.equal(defineHooks(rsaVerification).spec().mako.webhooks.verification.scheme, "rsa-sha256");
  assert.throws(() => defineHooks({ ...rsaVerification, publicKeys: [] }), /1 to 4 PEM public keys/);
  assert.throws(() => defineHooks({ ...rsaVerification, publicKeys: ["not a key"] }), /1 to 4 PEM public keys/);
  assert.throws(
    () => defineHooks({ ...rsaVerification, publicKeys: Array(5).fill(TEST_PUBLIC_KEY) }),
    /1 to 4 PEM public keys/,
  );
  assert.throws(() => defineHooks({ ...rsaVerification, secretEncoding: "hex" }), /not part of the rsa-sha256 scheme/);
  const ping = { header: "x-test-notification", value: "true", eventType: "wise#test-notification" };
  assert.deepEqual(
    defineHooks({ ...rsaVerification, testNotification: ping }).spec().mako.webhooks.verification.testNotification,
    ping,
  );
  assert.throws(
    () => defineHooks({ ...rsaVerification, testNotification: { ...ping, header: "X Test" } }),
    /testNotification must be/,
  );
});

test("an event id may come from a header or from several body paths", () => {
  const ok = defineHooks(rsaVerification, { eventIdHeader: "x-delivery-id", eventIdPath: ["created_at", "payload.uri"] });
  assert.equal(ok.spec().mako.webhooks.eventIdHeader, "x-delivery-id");
  assert.deepEqual(ok.spec().mako.webhooks.eventIdPath, ["created_at", "payload.uri"]);
  assert.throws(() => defineHooks(rsaVerification, { eventIdPath: [] }), /eventIdPath must be/);
  assert.throws(() => defineHooks(rsaVerification, { eventIdPath: Array(5).fill("a") }), /eventIdPath must be/);
  assert.throws(() => defineHooks(rsaVerification, { eventIdHeader: "X-Id" }), /eventIdHeader must be/);
});

const queryConnector = (source = "flow", extra = {}) =>
  defineConnector({
    name: "gql",
    version: "1.0.0",
    config: {
      properties:
        source === "connection"
          ? {
              queries: {
                type: "array",
                items: { type: "object", properties: { name: { type: "string" } } },
              },
            }
          : {},
    },
    queryEntities: {
      source,
      incremental: "client-filter",
      ...(source === "flow"
        ? { form: { label: "Queries", required: true, items: { required: ["name"], properties: { name: { type: "string" } } } } }
        : {}),
      entity: query => ({
        untyped: true,
        async *read() {
          yield { records: [{ id: query.name }], hasMore: false };
        },
      }),
    },
    ...extra,
  });

test("query entities: one entity per named query in config, after the declared ones", () => {
  const connector = queryConnector("flow", { entities: { fixed: entity } });
  const config = { queries: [{ name: "a" }, { query: "no name" }, { name: "b" }, { name: "" }] };
  assert.deepEqual(connector.entityNames(config), ["fixed", "a", "b"]);
  assert.deepEqual(connector.entityNames(), ["fixed"]);
  assert.equal(connector.entity("fixed", config), entity);
  assert.equal(typeof connector.entity("b", config).read, "function");
  assert.equal(connector.entity("missing", config), undefined);
});

test("query entities: no declared entity is needed, and the spec says where the list lives", () => {
  const connector = queryConnector("flow");
  const spec = connector.spec();
  assert.deepEqual(spec.mako.entities, {});
  assert.equal(spec.mako.queryEntities.source, "flow");
  assert.equal(spec.mako.queryEntities.incremental, "client-filter");
  assert.equal(spec.mako.queryEntities.form.label, "Queries");
});

test("query entities: discover marks an untyped stream so Mako keeps the row types", async () => {
  const connector = queryConnector("connection");
  const streams = await connector.discover({ config: { queries: [{ name: "events" }] } });
  assert.deepEqual(streams, [
    {
      name: "events",
      json_schema: { type: "object", additionalProperties: true },
      supported_sync_modes: ["full_refresh"],
      mako_untyped: true,
    },
  ]);
});

test("query entities: `key` names the config list, and the spec says so", async () => {
  const connector = defineConnector({
    name: "rest",
    version: "1",
    config: {
      properties: {
        entities: { type: "array", items: { type: "object", properties: {} } },
      },
    },
    queryEntities: { source: "connection", key: "entities", entity: () => entity },
  });
  assert.equal(connector.spec().mako.queryEntities.key, "entities");
  assert.deepEqual(
    connector.entityNames({ entities: [{ name: "a" }, { path: "/x" }], queries: [{ name: "b" }] }),
    ["a"],
  );
  assert.throws(
    () =>
      defineConnector({
        name: "rest",
        version: "1",
        config: { properties: {} },
        queryEntities: { source: "connection", key: "entities", entity: () => entity },
      }),
    /needs config.properties.entities/,
  );
  // The default key stays out of the spec.
  assert.equal("key" in queryConnector("connection").spec().mako.queryEntities, false);
});

test("query entities: a bad declaration is refused", () => {
  assert.throws(
    () =>
      defineConnector({
        name: "bq",
        version: "1",
        config: { properties: {} },
        queryEntities: { source: "connection", entity: () => entity },
      }),
    /needs config.properties.queries/,
  );
  assert.throws(
    () => defineConnector({ name: "gql", version: "1", queryEntities: { source: "flow", entity: () => entity } }),
    /needs form.items.properties/,
  );
  assert.throws(
    () => defineConnector({ name: "gql", version: "1", queryEntities: { source: "elsewhere" } }),
    /queryEntities.source must be one of/,
  );
});

test("query entities: a flow query field marked secret is refused, since flows store queries in plaintext", () => {
  for (const flag of [{ airbyte_secret: true }, { secret: true }]) {
    assert.throws(
      () =>
        defineConnector({
          name: "gql",
          version: "1",
          queryEntities: {
            source: "flow",
            form: { items: { properties: { token: { type: "string", ...flag } } } },
            entity: () => entity,
          },
        }),
      /field "token" is marked secret/,
    );
  }
});
