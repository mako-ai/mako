/**
 * Webhook signatures of workspace connectors, checked in the API from the
 * scheme the connector declares as data.
 *
 * The Close folder's declaration must accept and refuse exactly what the
 * in-process `verifyCloseWebhook` does, on the same deliveries. Declarations
 * the API cannot run fail closed.
 *
 * Run: node --import tsx src/connectors/workspace/webhook-verification.test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { before, test } from "node:test";
import {
  type DeclaredHmacVerification,
  declaredWebhookIdentity,
  declaredWebhookVerification,
  keyOf,
  valueAtPath,
  verifyDeclaredWebhook,
  declaredEventId,
} from "./webhook-verification";
import { verifyCloseWebhook } from "../close/webhooks";
import {
  ensureFolderInstalled,
  runFolderCommand,
} from "../../../../connectors/close/fixtures/harness.mjs";
import {
  buildDeliveries,
  buildWebhookEvents,
} from "../../../../connectors/close/fixtures/webhook-events.mjs";

/** The fixture deliveries' close-sig-timestamp, 1763290800, as a Date. */
const SENT = new Date(1763290800 * 1000);

const spec = (verification: unknown) => ({
  mako: { webhooks: { verification } },
});

/** What the Close folder declares, from its own spec. */
let CLOSE_WEBHOOK_VERIFICATION: Record<string, unknown>;
before(async () => {
  ensureFolderInstalled();
  const result = await runFolderCommand("spec");
  const message = result.messages.find(m => m.type === "SPEC");
  CLOSE_WEBHOOK_VERIFICATION = message?.spec?.mako?.webhooks?.verification;
  assert.ok(CLOSE_WEBHOOK_VERIFICATION, "the Close folder declares one");
});

void test("the Close declaration agrees with the in-process check on every delivery", () => {
  const declaration = declaredWebhookVerification(
    spec(CLOSE_WEBHOOK_VERIFICATION),
  );
  assert.ok(declaration);
  const [event] = buildWebhookEvents(["lead.updated"]);
  const deliveries = buildDeliveries(event.rawPayload);
  assert.ok(deliveries.length >= 6);
  let valid = 0;
  for (const delivery of deliveries) {
    const ours = verifyDeclaredWebhook(declaration, { ...delivery, now: SENT });
    const theirs = verifyCloseWebhook(delivery);
    assert.equal(ours.valid, theirs.valid, delivery.name);
    if (ours.valid) {
      valid++;
      assert.deepEqual(ours.event, theirs.event);
    }
  }
  assert.equal(valid, 1);
});

void test("headers are matched case-insensitively, as a proxy may rewrite them", () => {
  const declaration = declaredWebhookVerification(
    spec(CLOSE_WEBHOOK_VERIFICATION),
  )!;
  const [event] = buildWebhookEvents(["contact.created"]);
  const valid = buildDeliveries(event.rawPayload)[0];
  const shouted = Object.fromEntries(
    Object.entries(valid.headers).map(([k, v]) => [k.toUpperCase(), v]),
  );
  assert.equal(
    verifyDeclaredWebhook(declaration, {
      ...valid,
      headers: shouted,
      now: SENT,
    }).valid,
    true,
  );
});

void test("a base64, prefixed scheme with a literal separator verifies", () => {
  const declaration = declaredWebhookVerification(
    spec({
      scheme: "hmac-sha256",
      secretEncoding: "utf8",
      signedPayload: ["header:x-ts", "literal:.", "body"],
      signatureHeader: "x-sig",
      signatureEncoding: "base64",
      signaturePrefix: "v1=",
    }),
  )!;
  const body = JSON.stringify({ id: "evt_1" });
  const signature = createHmac("sha256", "s3cret-s3cret-s3cret")
    .update(`1700000000.${body}`)
    .digest("base64");
  const headers = { "x-ts": "1700000000", "x-sig": `v1=${signature}` };
  assert.equal(
    verifyDeclaredWebhook(declaration, {
      payload: body,
      headers,
      secret: "s3cret-s3cret-s3cret",
    }).valid,
    true,
  );
  for (const [name, options] of [
    ["no prefix", { headers: { ...headers, "x-sig": signature } }],
    ["other secret", { secret: "other-other-other-other" }],
    ["no secret", { secret: undefined }],
    ["no timestamp", { headers: { "x-sig": headers["x-sig"] } }],
    ["other body", { payload: body.replace("evt_1", "evt_2") }],
  ] as const) {
    const result = verifyDeclaredWebhook(declaration, {
      payload: body,
      headers,
      secret: "s3cret-s3cret-s3cret",
      ...options,
    });
    assert.equal(result.valid, false, name);
  }
});

void test("a declaration the API cannot run is refused, never guessed", () => {
  const base = { ...CLOSE_WEBHOOK_VERIFICATION } as Record<string, unknown>;
  for (const [name, bad] of [
    ["none", undefined],
    ["md5", { ...base, scheme: "md5" }],
    ["no body", { ...base, signedPayload: ["header:close-sig-timestamp"] }],
    ["env part", { ...base, signedPayload: ["body", "env:SECRET"] }],
    ["header case", { ...base, signatureHeader: "Close-Sig-Hash" }],
    ["secret encoding", { ...base, secretEncoding: "rot13" }],
    ["too many parts", { ...base, signedPayload: Array(9).fill("body") }],
  ] as const) {
    assert.equal(declaredWebhookVerification(spec(bad)), null, name);
  }
});

void test("a hex secret that is not hex is malformed, not a key", () => {
  const declaration = declaredWebhookVerification(
    spec(CLOSE_WEBHOOK_VERIFICATION),
  )!;
  const result = verifyDeclaredWebhook(declaration, {
    payload: "{}",
    headers: { "close-sig-hash": "00", "close-sig-timestamp": "1" },
    secret: "not-hex",
  });
  assert.deepEqual(result, {
    valid: false,
    error: "The webhook secret is malformed",
  });
});

void test("the Close declaration refuses a replay: an old, a future, an empty or a missing timestamp", () => {
  const declaration = declaredWebhookVerification(
    spec(CLOSE_WEBHOOK_VERIFICATION),
  ) as DeclaredHmacVerification;
  assert.equal(declaration.timestampHeader, "close-sig-timestamp");
  assert.equal(declaration.toleranceSeconds, 300);
  const [event] = buildWebhookEvents(["lead.updated"]);
  const valid = buildDeliveries(event.rawPayload)[0];
  const at = (seconds: number) => new Date((1763290800 + seconds) * 1000);
  assert.equal(
    verifyDeclaredWebhook(declaration, { ...valid, now: at(299) }).valid,
    true,
  );
  assert.equal(
    verifyDeclaredWebhook(declaration, { ...valid, now: at(-299) }).valid,
    true,
  );
  for (const [name, now] of [
    ["365 days later", at(365 * 86400)],
    ["301 s later", at(301)],
    ["301 s earlier", at(-301)],
  ] as const) {
    assert.equal(
      verifyDeclaredWebhook(declaration, { ...valid, now }).valid,
      false,
      name,
    );
  }
  // An empty timestamp signs as the body alone; it is still refused.
  const sign = (ts: string) =>
    createHmac("sha256", Buffer.from(valid.secret!, "hex"))
      .update(ts + valid.payload)
      .digest("hex");
  for (const ts of ["", "abc", "-1"]) {
    const result = verifyDeclaredWebhook(declaration, {
      ...valid,
      headers: { "close-sig-hash": sign(ts), "close-sig-timestamp": ts },
      now: SENT,
    });
    assert.equal(result.valid, false, JSON.stringify(ts));
  }
  const { ["close-sig-timestamp"]: _drop, ...noTs } = valid.headers;
  assert.equal(
    verifyDeclaredWebhook(declaration, { ...valid, headers: noTs, now: SENT })
      .valid,
    false,
  );
});

void test("a declared window needs both fields, within 1 s to 1 day", () => {
  const base = { ...CLOSE_WEBHOOK_VERIFICATION } as Record<string, unknown>;
  const { toleranceSeconds: _t, ...headerOnly } = base;
  for (const bad of [
    headerOnly,
    { ...base, toleranceSeconds: 0 },
    { ...base, toleranceSeconds: 86_401 },
    { ...base, timestampHeader: "Close-Sig-Timestamp" },
  ]) {
    assert.equal(declaredWebhookVerification(spec(bad)), null);
  }
});

void test("a base64 secret decodes strictly, to at least 16 bytes", () => {
  // Node's lenient decoder reads "ab=" + junk as a 1-byte key.
  assert.equal(keyOf(`ab=${"x".repeat(40)}`, "base64"), null);
  assert.equal(keyOf("YWJj", "base64"), null, "3 bytes is too short");
  assert.equal(keyOf("YWJjZA", "base64"), null, "no padding: not canonical");
  assert.equal(keyOf("YW Jj", "base64"), null);
  const good = Buffer.alloc(32, 7).toString("base64");
  assert.equal(keyOf(good, "base64")?.length, 32);
  assert.equal(keyOf("0f".repeat(16), "hex")?.length, 16);
  assert.equal(keyOf("0f".repeat(15), "hex"), null, "15 bytes is too short");
  assert.equal(keyOf("short", "utf8"), null);
});

void test("a declared timestamp must be signed: an unsigned window is refused", () => {
  // The repro: only the body signed, with a 300 s window on x-ts. A 1-year-old
  // body replayed with a fresh x-ts would pass the window and the signature.
  const unsigned = {
    scheme: "hmac-sha256",
    secretEncoding: "utf8",
    signedPayload: ["body"],
    signatureHeader: "x-sig",
    signatureEncoding: "hex",
    timestampHeader: "x-ts",
    toleranceSeconds: 300,
  };
  assert.equal(declaredWebhookVerification(spec(unsigned)), null);
  assert.equal(
    declaredWebhookVerification(
      spec({ ...unsigned, signedPayload: ["header:x-other", "body"] }),
    ),
    null,
  );
  const signed = declaredWebhookVerification(
    spec({ ...unsigned, signedPayload: ["header:x-ts", "body"] }),
  )!;
  const secret = "s3cret-s3cret-s3cret";
  const body = JSON.stringify({ id: "evt_old" });
  const sentLastYear = String(1763290800 - 365 * 86400);
  const signature = createHmac("sha256", secret)
    .update(sentLastYear + body)
    .digest("hex");
  // The old signature with a fresh timestamp no longer verifies.
  const result = verifyDeclaredWebhook(signed, {
    payload: body,
    headers: { "x-ts": "1763290800", "x-sig": signature },
    secret,
    now: SENT,
  });
  assert.equal(result.valid, false);
});

void test("shared-secret: the header must hold the flow's secret, in constant time", () => {
  const declaration = declaredWebhookVerification(
    spec({ scheme: "shared-secret", secretHeader: "x-claap-webhook-secret" }),
  );
  assert.deepEqual(declaration, {
    scheme: "shared-secret",
    secretHeader: "x-claap-webhook-secret",
  });
  const secret = "s".repeat(24);
  const verify = (
    headers: Record<string, string>,
    s = secret,
    payload = "{}",
  ) => verifyDeclaredWebhook(declaration!, { payload, headers, secret: s });
  assert.equal(verify({ "X-Claap-Webhook-Secret": secret }).valid, true);
  assert.equal(verify({ "x-claap-webhook-secret": `${secret}x` }).valid, false);
  assert.equal(verify({}).valid, false);
  assert.equal(
    verify({ "x-claap-webhook-secret": "short" }, "short").valid,
    false,
  );
  assert.equal(
    verify({ "x-claap-webhook-secret": secret }, secret, "{").valid,
    false,
  );
  assert.equal(
    declaredWebhookVerification(
      spec({ scheme: "shared-secret", secretHeader: "Bad Header" }),
    ),
    null,
  );
});

void test("a signature in a query parameter is read first, the header second", () => {
  const declaration = declaredWebhookVerification(
    spec({
      scheme: "hmac-sha256",
      secretEncoding: "utf8",
      signedPayload: ["body"],
      signatureQuery: "signature",
      signatureHeader: "signature",
      signatureEncoding: "hex",
    }),
  )!;
  const secret = "pandadoc-fixture-shared-key-0001";
  const body = '[{"event":"document_updated","data":{"id":"d1"}}]';
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const verify = (query: Record<string, string>, headers = {}) =>
    verifyDeclaredWebhook(declaration, {
      payload: body,
      headers,
      query,
      secret,
    }).valid;
  assert.equal(verify({ signature }), true);
  assert.equal(verify({}, { signature }), true);
  assert.equal(verify({ signature: signature.toUpperCase() }), true);
  assert.equal(verify({ signature: "00" + signature.slice(2) }), false);
  assert.equal(verify({}), false);
  assert.equal(
    declaredWebhookVerification(
      spec({ ...declaration, signatureQuery: "not a name" }),
    ),
    null,
  );
});

void test("where an event id and type sit is read from the spec, plain paths only", () => {
  assert.deepEqual(
    declaredWebhookIdentity({
      mako: { webhooks: { eventIdPath: "eventId", eventTypePath: "0.event" } },
    }),
    { eventIdPath: "eventId", eventTypePath: "0.event" },
  );
  assert.deepEqual(
    declaredWebhookIdentity({
      mako: { webhooks: { eventIdPath: "a..b", eventTypePath: "$.x" } },
    }),
    {},
  );
  assert.equal(valueAtPath([{ event: "e" }], "0.event"), "e");
  assert.equal(valueAtPath({ event: { type: "t" } }, "event.type"), "t");
  assert.equal(valueAtPath({ id: 7 }, "id"), "7");
  assert.equal(valueAtPath({ id: {} }, "id"), undefined);
  assert.equal(valueAtPath({}, "constructor"), undefined);
});

// ---------------------------------------------------------------------------
// Wise (rsa-sha256) and Calendly (stripe-v1), each against its in-process
// check, on the folders' own fixture deliveries and declarations.
// ---------------------------------------------------------------------------

async function folderSpec(slug: "wise" | "calendly" | "pandadoc") {
  const harness = await import(
    slug === "wise"
      ? "../../../../connectors/wise/fixtures/harness.mjs"
      : slug === "pandadoc"
        ? "../../../../connectors/pandadoc/fixtures/harness.mjs"
        : "../../../../connectors/calendly/fixtures/harness.mjs"
  );
  harness.ensureFolderInstalled();
  const run = await harness.runFolderCommand("spec");
  return run.messages.find((m: any) => m.type === "SPEC")?.spec;
}

void test("the Wise declaration agrees with the in-process check, with Wise's own keys", async () => {
  const { verifyWiseWebhook, wiseWebhookPublicKeys } =
    await import("../wise/webhooks");
  const fixtures =
    await import("../../../../connectors/wise/fixtures/webhook-events.mjs");
  const wise = await folderSpec("wise");
  const declared = wise.mako.webhooks.verification;
  // Wise's production and sandbox keys, in the built-in's order.
  assert.deepEqual(declared.publicKeys, wiseWebhookPublicKeys(false));
  // The fixtures are signed by a per-run key: swap it in on both sides.
  const testKey = fixtures.TEST_WEBHOOK_KEYS.publicKey;
  const declaration = declaredWebhookVerification(
    spec({ ...declared, publicKeys: [testKey] }),
  );
  assert.ok(declaration);
  const deliveries = fixtures.buildDeliveries();
  assert.equal(deliveries.length, 9);
  let valid = 0;
  for (const d of deliveries) {
    const ours = verifyDeclaredWebhook(declaration, d);
    const theirs = verifyWiseWebhook(
      { payload: d.payload, headers: d.headers, secret: "production" },
      () => [testKey],
    );
    assert.equal(ours.valid, theirs.valid, d.name);
    if (ours.valid) valid++;
  }
  assert.equal(valid, 4);
  // A key that is not RSA, or junk, makes the declaration unrunnable.
  for (const publicKeys of [[], ["junk"], Array(5).fill(testKey)]) {
    assert.equal(
      declaredWebhookVerification(spec({ ...declared, publicKeys })),
      null,
    );
  }
});

void test("Calendly's header is Stripe's: stripe-v1 agrees with the in-process check", async () => {
  const { verifyCalendlyWebhook } = await import("../calendly/webhooks");
  const fixtures =
    await import("../../../../connectors/calendly/fixtures/webhook-events.mjs");
  const calendly = await folderSpec("calendly");
  const declaration = declaredWebhookVerification(calendly);
  assert.equal(declaration?.scheme, "stripe-v1");
  const {
    type: _t,
    id: _i,
    ...body
  } = fixtures.buildWebhookEvents()[0].rawPayload as Record<string, unknown>;
  const deliveries = fixtures.buildDeliveries(body);
  assert.equal(deliveries.length, 10);
  const at = fixtures.DELIVERY_TIMESTAMP * 1000;
  const realNow = Date.now;
  Date.now = () => at; // the in-process check reads the clock itself
  try {
    let valid = 0;
    for (const d of deliveries) {
      const ours = verifyDeclaredWebhook(declaration!, {
        ...d,
        now: new Date(at),
      });
      const theirs = verifyCalendlyWebhook(d);
      assert.equal(ours.valid, theirs.valid, d.name);
      if (ours.valid) valid++;
    }
    assert.equal(valid, 2);
  } finally {
    Date.now = realNow;
  }
});

void test("an event id comes from a declared header, one path, or several joined", () => {
  const identity = (webhooks: Record<string, unknown>) =>
    declaredWebhookIdentity({ mako: { webhooks } });
  const body = {
    created_at: "2026-11-16T10:00:00Z",
    payload: { uri: "https://api.calendly.com/x/1" },
    event: "invitee.created",
  };
  assert.equal(
    declaredEventId(
      identity({ eventIdPath: ["created_at", "payload.uri"] }),
      body,
    ),
    "2026-11-16T10:00:00Z:https://api.calendly.com/x/1",
  );
  // One path missing: no declared id, the route's fallbacks apply.
  assert.equal(
    declaredEventId(
      identity({ eventIdPath: ["created_at", "payload.id"] }),
      body,
    ),
    undefined,
  );
  assert.equal(
    declaredEventId(
      identity({ eventIdHeader: "x-delivery-id", eventIdPath: "event" }),
      body,
      { "X-Delivery-Id": "d-1" },
    ),
    "d-1",
  );
  assert.equal(
    declaredEventId(
      identity({ eventIdHeader: "x-delivery-id", eventIdPath: "event" }),
      body,
      {},
    ),
    "invitee.created",
  );
  for (const bad of [
    { eventIdPath: [] },
    { eventIdPath: Array(5).fill("a") },
    { eventIdPath: ["a/b"] },
    { eventIdHeader: "X-Id" },
  ]) {
    const got = identity(bad);
    assert.equal(got.eventIdPath, undefined, JSON.stringify(bad));
    assert.equal(got.eventIdHeader, undefined, JSON.stringify(bad));
  }
});

void test("a forged Wise test ping can not take a real delivery's event id", async () => {
  const { SandboxedConnector } = await import("./SandboxedConnector");
  const fixtures =
    await import("../../../../connectors/wise/fixtures/webhook-events.mjs");
  const wise = await folderSpec("wise");
  const testKey = fixtures.TEST_WEBHOOK_KEYS.publicKey;
  const wiseSpec = {
    ...wise,
    mako: {
      ...wise.mako,
      webhooks: {
        ...wise.mako.webhooks,
        verification: {
          ...wise.mako.webhooks.verification,
          publicKeys: [testKey],
        },
      },
    },
  };
  class SpecWise extends SandboxedConnector {
    constructor() {
      super({
        _id: "665f00000000000000000002",
        workspaceId: "ws1",
        name: "Wise",
        type: "ws:wise",
        config: {},
      } as never);
      this.loaded = { slug: "wise", spec: wiseSpec, entities: [] } as never;
    }
  }
  const connector = new SpecWise();
  const declaration = declaredWebhookVerification(wiseSpec)!;
  const identify = (d: {
    payload: string;
    headers: Record<string, string>;
  }) => {
    const result = verifyDeclaredWebhook(declaration, d);
    assert.ok(result.valid);
    return connector.webhookEventIdentity(result.event, d.payload, d.headers);
  };

  const [real] = fixtures
    .buildDeliveries()
    .filter((d: { name: string }) => d.name === "valid");
  const realId = identify(real).eventId;
  assert.equal(realId, real.headers["x-delivery-id"]);

  // The same delivery id on an unsigned ping: keyed apart, never equal.
  const forged = {
    payload: "{}",
    headers: {
      "x-test-notification": "true",
      "x-delivery-id": real.headers["x-delivery-id"],
    },
  };
  const ping = identify(forged);
  assert.equal(ping.eventId, `test:${real.headers["x-delivery-id"]}`);
  assert.notEqual(ping.eventId, realId);
  // Without a delivery id it is still a `test:` id.
  const bare = identify({
    payload: "{}",
    headers: { "x-test-notification": "TRUE" },
  });
  assert.match(bare.eventId, /^test:/);
  // A delivery that is not a ping keeps its plain header id.
  assert.equal(
    connector.webhookEventIdentity({}, "{}", { "x-delivery-id": "d-2" })
      .eventId,
    "d-2",
  );
});

void test("PandaDoc's declaration accepts the query, header and upper-case signatures and refuses a tampered body or a wrong key", async () => {
  const fixtures =
    await import("../../../../connectors/pandadoc/fixtures/webhook-events.mjs");
  const declaration = declaredWebhookVerification(await folderSpec("pandadoc"));
  assert.equal(declaration?.scheme, "hmac-sha256");
  const deliveries = fixtures.buildWebhookDeliveries();
  assert.ok(deliveries.length >= 15);
  const key = fixtures.TEST_SHARED_KEY;
  const verify = (
    body: string,
    secret: string,
    query: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    verifyDeclaredWebhook(declaration!, {
      payload: body,
      headers,
      query,
      secret,
    }).valid;
  for (const d of deliveries) {
    const signature = fixtures.sign(d.body, key);
    assert.equal(verify(d.body, key, { signature }), true, `${d.name} query`);
    assert.equal(
      verify(d.body, key, {}, { signature }),
      true,
      `${d.name} header`,
    );
    assert.equal(
      verify(d.body, key, { signature: signature.toUpperCase() }),
      true,
      `${d.name} upper-case`,
    );
    assert.equal(
      verify(`${d.body} `, key, { signature }),
      false,
      `${d.name} tampered body`,
    );
    assert.equal(
      verify(d.body, "another-shared-key", { signature }),
      false,
      `${d.name} wrong key`,
    );
  }
});
