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
