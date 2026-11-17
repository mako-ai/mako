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
  assert.throws(() => withVerification({ ...closeVerification, scheme: "md5" }), /scheme must be one of hmac-sha256/);
  assert.throws(
    () => withVerification({ ...closeVerification, signedPayload: ["header:close-sig-timestamp"] }),
    /must include "body"/,
  );
  assert.throws(
    () => withVerification({ ...closeVerification, signedPayload: ["body", "env:SECRET"] }),
    /"body", "header:<name>", "param:<key>" or "literal:<text>"/,
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
  signedPayload: ["body"],
  signatureHeader: "x-signature-sha256",
  signatureEncoding: "base64",
};
const paramVerification = {
  scheme: "hmac-sha256",
  secretEncoding: "utf8",
  signedPayload: ["param:t", "literal:.", "body"],
  signatureHeader: "calendly-webhook-signature",
  signatureEncoding: "hex",
  signatureParam: "v1",
  timestampParam: "t",
  toleranceSeconds: 180,
};
const defineHooks = (verification, extra = {}) =>
  defineConnector({ ...webhookBase(), webhooks: { handleBatch: () => [], verification, ...extra } });

test("rsa-sha256 declares public keys and no secret encoding", () => {
  assert.equal(defineHooks(rsaVerification).spec().mako.webhooks.verification.scheme, "rsa-sha256");
  assert.throws(() => defineHooks({ ...rsaVerification, publicKeys: [] }), /1 to 4 PEM public keys/);
  assert.throws(() => defineHooks({ ...rsaVerification, publicKeys: ["not a key"] }), /1 to 4 PEM public keys/);
  assert.throws(
    () => defineHooks({ ...rsaVerification, publicKeys: Array(5).fill(TEST_PUBLIC_KEY) }),
    /1 to 4 PEM public keys/,
  );
  assert.throws(() => defineHooks({ ...rsaVerification, secretEncoding: "hex" }), /hmac-sha256 only/);
  assert.throws(() => defineHooks({ ...closeVerification, publicKeys: [TEST_PUBLIC_KEY] }), /rsa-sha256 only/);
});

test("a key=value signature header names its signature and signed timestamp", () => {
  assert.equal(defineHooks(paramVerification).spec().mako.webhooks.verification.timestampParam, "t");
  assert.throws(
    () => defineHooks({ ...paramVerification, signedPayload: ["literal:.", "body"] }),
    /must include "param:t"/,
  );
  const { signatureParam: _s, ...noSignatureParam } = paramVerification;
  assert.throws(() => defineHooks(noSignatureParam), /timestampParam needs signatureParam/);
  assert.throws(
    () => defineHooks({ ...paramVerification, timestampHeader: "x-ts" }),
    /timestampHeader or timestampParam, not both/,
  );
  const { toleranceSeconds: _t, ...noTolerance } = paramVerification;
  assert.throws(() => defineHooks(noTolerance), /go together/);
  assert.throws(
    () => defineHooks({ ...closeVerification, signedPayload: ["param:t", "body"] }),
    /needs signatureParam/,
  );
});

test("a test notification and the delivery's id and type are declared as data", () => {
  const ok = defineHooks(
    { ...rsaVerification, testNotification: { header: "x-test-notification", value: "true", eventType: "wise#test" } },
    { delivery: { idHeader: "x-delivery-id", typeField: "event_type" } },
  );
  assert.deepEqual(ok.spec().mako.webhooks.delivery, { idHeader: "x-delivery-id", typeField: "event_type" });
  assert.throws(
    () => defineHooks({ ...rsaVerification, testNotification: { header: "X Test", value: "true", eventType: "t" } }),
    /testNotification must be/,
  );
  assert.throws(() => defineHooks(rsaVerification, { delivery: { idFields: [] } }), /idFields must list/);
  assert.throws(() => defineHooks(rsaVerification, { delivery: { typeField: "a/b" } }), /typeField must be/);
  assert.throws(() => defineHooks(rsaVerification, { delivery: { idScript: "x" } }), /not a known key/);
  assert.equal("delivery" in defineHooks(rsaVerification).spec().mako.webhooks, false);
});
