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
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { before, test } from "node:test";
import {
  declaredWebhookDelivery,
  declaredWebhookVerification,
  identifyDeclaredEvent,
  keyOf,
  verifyDeclaredWebhook,
} from "./webhook-verification";
import { verifyCloseWebhook } from "../close/webhooks";
import { verifyWiseWebhook, wiseWebhookPublicKeys } from "../wise/webhooks";
import { verifyCalendlyWebhook } from "../calendly/webhooks";
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
  )!;
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

// ---------------------------------------------------------------------------
// rsa-sha256 (Wise), key=value signature headers (Calendly), test pings and
// the delivery's id and type, each against the in-process check.
// ---------------------------------------------------------------------------

const { publicKey: TEST_PUBLIC, privateKey: TEST_PRIVATE } =
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
const { publicKey: OTHER_PUBLIC } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const rsaDeclaration = {
  scheme: "rsa-sha256",
  publicKeys: [OTHER_PUBLIC, TEST_PUBLIC],
  signedPayload: ["body"],
  signatureHeader: "x-signature-sha256",
  signatureEncoding: "base64",
  testNotification: {
    header: "x-test-notification",
    value: "true",
    eventType: "wise#test-notification",
  },
};
const rsaDelivery = { idHeader: "x-delivery-id", typeField: "event_type" };

function wiseDeliveries() {
  const body = JSON.stringify({
    data: {
      resource: { id: 111, profile_id: 222, account_id: 333, type: "transfer" },
      current_state: "outgoing_payment_sent",
      previous_state: "processing",
      occurred_at: "2026-11-16T10:00:00Z",
    },
    subscription_id: "sub-1",
    event_type: "transfers#state-change",
    schema_version: "2.0.0",
    sent_at: "2026-11-16T10:00:01Z",
  });
  const sign = (payload: string) =>
    createSign("RSA-SHA256").update(payload).sign(TEST_PRIVATE, "base64");
  const good = sign(body);
  const headers = { "x-signature-sha256": good, "x-delivery-id": "dlv-1" };
  return [
    { name: "valid", payload: body, headers },
    {
      name: "tampered body",
      payload: body.replace("sub-1", "sub-2"),
      headers,
    },
    { name: "no signature", payload: body, headers: { "x-delivery-id": "d" } },
    {
      name: "garbage signature",
      payload: body,
      headers: { ...headers, "x-signature-sha256": "bm90IGEgc2lnbmF0dXJl" },
    },
    {
      name: "valid, no delivery id",
      payload: body,
      headers: { "x-signature-sha256": good },
    },
    {
      name: "test notification, unsigned",
      payload: "{}",
      headers: { "X-Test-Notification": " TRUE ", "x-delivery-id": "dlv-t" },
    },
  ];
}

void test("rsa-sha256 agrees with the in-process Wise check, with the same event id and type", () => {
  const declaration = declaredWebhookVerification(spec(rsaDeclaration));
  assert.ok(declaration);
  const delivery = declaredWebhookDelivery({
    mako: { webhooks: { delivery: rsaDelivery } },
  });
  let valid = 0;
  for (const d of wiseDeliveries()) {
    const ours = verifyDeclaredWebhook(declaration, { ...d, delivery });
    const theirs = verifyWiseWebhook(
      { payload: d.payload, headers: d.headers, secret: "production" },
      () => [TEST_PUBLIC],
    );
    assert.equal(ours.valid, theirs.valid, d.name);
    if (!ours.valid) continue;
    valid++;
    const a = ours.event as Record<string, unknown>;
    const b = theirs.event as Record<string, unknown>;
    assert.equal(a.type, b.type, d.name);
    if (d.name === "valid, no delivery id") {
      // In-process builds a fallback id from the body; the declaration
      // names only the header, so the route falls back to a random id.
      assert.equal(a.id, undefined);
      continue;
    }
    assert.equal(a.id, b.id, d.name);
    if (d.name === "valid") {
      assert.deepEqual(a, b);
    }
  }
  assert.equal(valid, 3);
});

void test("rsa-sha256 refuses keys it cannot read and declarations with a secret", () => {
  for (const [name, bad] of [
    ["no keys", { ...rsaDeclaration, publicKeys: [] }],
    [
      "junk key",
      {
        ...rsaDeclaration,
        publicKeys: [
          "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
        ],
      },
    ],
    ["private key", { ...rsaDeclaration, publicKeys: [TEST_PRIVATE] }],
    [
      "five keys",
      { ...rsaDeclaration, publicKeys: Array(5).fill(TEST_PUBLIC) },
    ],
    ["secret encoding", { ...rsaDeclaration, secretEncoding: "hex" }],
    [
      "test ping header case",
      {
        ...rsaDeclaration,
        testNotification: { header: "X-Test", value: "true", eventType: "t" },
      },
    ],
  ] as const) {
    assert.equal(declaredWebhookVerification(spec(bad)), null, name);
  }
  // An HMAC declaration never answers a test ping it did not declare.
  const hmac = declaredWebhookVerification(spec(CLOSE_WEBHOOK_VERIFICATION))!;
  assert.equal(
    verifyDeclaredWebhook(hmac, {
      payload: "{}",
      headers: { "x-test-notification": "true" },
      secret: "0f".repeat(32),
    }).valid,
    false,
  );
});

const calendlyDeclaration = {
  scheme: "hmac-sha256",
  secretEncoding: "utf8",
  signedPayload: ["param:t", "literal:.", "body"],
  signatureHeader: "calendly-webhook-signature",
  signatureEncoding: "hex",
  signatureParam: "v1",
  timestampParam: "t",
  toleranceSeconds: 180,
};
const calendlyDelivery = {
  idFields: ["created_at", "payload.uri"],
  typeField: "event",
};
const CALENDLY_KEY = "test-signing-key-0123456789abcdef";

function calendlyDeliveries(t: number) {
  const body = JSON.stringify({
    event: "invitee.created",
    created_at: "2026-11-16T10:00:00.000000Z",
    created_by: "https://api.calendly.com/users/U1",
    payload: {
      uri: "https://api.calendly.com/scheduled_events/E1/invitees/I1",
      email: "a@example.com",
    },
  });
  const sign = (ts: string, payload: string, key = CALENDLY_KEY) =>
    createHmac("sha256", key).update(`${ts}.${payload}`).digest("hex");
  const h = (value: string) => ({ "calendly-webhook-signature": value });
  const good = sign(String(t), body);
  return [
    { name: "valid", payload: body, headers: h(`t=${t},v1=${good}`) },
    { name: "spaces", payload: body, headers: h(` t = ${t} , v1 = ${good} `) },
    {
      name: "tampered",
      payload: body.replace("I1", "I2"),
      headers: h(`t=${t},v1=${good}`),
    },
    {
      name: "wrong key",
      payload: body,
      headers: h(`t=${t},v1=${sign(String(t), body, "x".repeat(32))}`),
    },
    { name: "no v1", payload: body, headers: h(`t=${t}`) },
    { name: "no t", payload: body, headers: h(`v1=${good}`) },
    { name: "no header", payload: body, headers: {} },
    {
      name: "stale",
      payload: body,
      headers: h(`t=${t - 181},v1=${sign(String(t - 181), body)}`),
    },
    {
      name: "timestamp swapped",
      payload: body,
      headers: h(`t=${t - 1},v1=${good}`),
    },
    {
      name: "no secret",
      payload: body,
      headers: h(`t=${t},v1=${good}`),
      secret: null,
    },
  ];
}

void test("a key=value signature header agrees with the in-process Calendly check, with the same event id and type", () => {
  const declaration = declaredWebhookVerification(spec(calendlyDeclaration));
  assert.ok(declaration);
  const delivery = declaredWebhookDelivery({
    mako: { webhooks: { delivery: calendlyDelivery } },
  });
  const t = Math.floor(Date.now() / 1000);
  let valid = 0;
  for (const d of calendlyDeliveries(t)) {
    const secret = d.secret === null ? undefined : CALENDLY_KEY;
    const ours = verifyDeclaredWebhook(declaration, {
      payload: d.payload,
      headers: d.headers,
      secret,
      delivery,
    });
    const theirs = verifyCalendlyWebhook({
      payload: d.payload,
      headers: d.headers,
      secret,
    });
    assert.equal(ours.valid, theirs.valid, d.name);
    if (ours.valid) {
      valid++;
      assert.deepEqual(ours.event, theirs.event, d.name);
    }
  }
  assert.equal(valid, 2);
});

void test("param parts need signatureParam, and a param timestamp must be signed", () => {
  const { signatureParam: _s, ...noParam } = calendlyDeclaration;
  assert.equal(declaredWebhookVerification(spec(noParam)), null);
  assert.equal(
    declaredWebhookVerification(
      spec({ ...calendlyDeclaration, signedPayload: ["literal:.", "body"] }),
    ),
    null,
  );
  assert.equal(
    declaredWebhookVerification(
      spec({ ...calendlyDeclaration, timestampHeader: "x-ts" }),
    ),
    null,
  );
});

void test("a delivery declaration names an id header, id fields and a type field, nothing else", () => {
  assert.deepEqual(
    declaredWebhookDelivery({
      mako: { webhooks: { delivery: calendlyDelivery } },
    }),
    calendlyDelivery,
  );
  for (const bad of [
    { idHeader: "X-Id" },
    { idFields: [] },
    { idFields: ["a..b"] },
    { typeField: "a/b" },
    { idScript: "x" },
  ]) {
    assert.equal(
      declaredWebhookDelivery({ mako: { webhooks: { delivery: bad } } }),
      null,
      JSON.stringify(bad),
    );
  }
  const d = declaredWebhookDelivery({
    mako: { webhooks: { delivery: calendlyDelivery } },
  });
  // A missing field leaves the id to the route; own properties only.
  assert.deepEqual(identifyDeclaredEvent(d, { event: "x", payload: {} }, {}), {
    event: "x",
    payload: {},
    type: "x",
  });
  assert.deepEqual(
    identifyDeclaredEvent(d, { created_at: "c", payload: { uri: 7 } }, {}),
    { created_at: "c", payload: { uri: 7 }, id: "c:7" },
  );
  assert.deepEqual(identifyDeclaredEvent(d, { event: "toString" }, {}), {
    event: "toString",
    type: "toString",
  });
  assert.deepEqual(identifyDeclaredEvent(d, { payload: {} }, {}), {
    payload: {},
  });
  assert.deepEqual(identifyDeclaredEvent(null, { a: 1 }, {}), { a: 1 });
});

void test("the Wise folder's declaration agrees with the in-process check on its fixture deliveries", async () => {
  const harness =
    await import("../../../../connectors/wise/fixtures/harness.mjs");
  const fixtures =
    await import("../../../../connectors/wise/fixtures/webhook-events.mjs");
  harness.ensureFolderInstalled();
  const run = await harness.runFolderCommand("spec");
  const wiseSpec = run.messages.find((m: any) => m.type === "SPEC")?.spec;
  const declared = wiseSpec?.mako?.webhooks;
  assert.ok(declared?.verification, "the Wise folder declares one");
  // The folder ships Wise's own two keys, in the built-in's production order.
  assert.deepEqual(
    declared.verification.publicKeys,
    wiseWebhookPublicKeys(false, "production"),
  );
  // The fixtures are signed by a per-run test key: swap it in on both sides.
  const declaration = declaredWebhookVerification(
    spec({
      ...declared.verification,
      publicKeys: [fixtures.TEST_WEBHOOK_KEYS.publicKey],
    }),
  );
  assert.ok(declaration);
  const delivery = declaredWebhookDelivery(wiseSpec);
  assert.deepEqual(delivery, {
    idHeader: "x-delivery-id",
    typeField: "event_type",
  });
  const deliveries = fixtures.buildDeliveries();
  assert.equal(deliveries.length, 9);
  for (const d of deliveries) {
    const ours = verifyDeclaredWebhook(declaration, { ...d, delivery });
    const theirs = verifyWiseWebhook(
      { payload: d.payload, headers: d.headers, secret: "production" },
      () => [fixtures.TEST_WEBHOOK_KEYS.publicKey],
    );
    assert.equal(ours.valid, theirs.valid, d.name);
    if (ours.valid && d.name !== "valid, no delivery id") {
      const a = ours.event as Record<string, unknown>;
      const b = theirs.event as Record<string, unknown>;
      assert.equal(a.id, b.id, d.name);
      assert.equal(a.type, b.type, d.name);
    }
  }
});

void test("the Calendly folder's declaration agrees with the in-process check on its fixture deliveries", async () => {
  const harness =
    await import("../../../../connectors/calendly/fixtures/harness.mjs");
  const fixtures =
    await import("../../../../connectors/calendly/fixtures/webhook-events.mjs");
  harness.ensureFolderInstalled();
  const run = await harness.runFolderCommand("spec");
  const calendlySpec = run.messages.find((m: any) => m.type === "SPEC")?.spec;
  assert.deepEqual(
    calendlySpec?.mako?.webhooks?.verification,
    calendlyDeclaration,
  );
  const declaration = declaredWebhookVerification(calendlySpec);
  const delivery = declaredWebhookDelivery(calendlySpec);
  assert.ok(declaration);
  assert.deepEqual(delivery, calendlyDelivery);
  const {
    type: _t,
    id: _i,
    ...body
  } = fixtures.buildWebhookEvents()[0].rawPayload as Record<string, unknown>;
  const deliveries = fixtures.buildDeliveries(body);
  assert.equal(deliveries.length, 10);
  // The in-process check reads the clock itself.
  const realNow = Date.now;
  Date.now = () => fixtures.DELIVERY_TIMESTAMP * 1000;
  try {
    let valid = 0;
    for (const d of deliveries) {
      const ours = verifyDeclaredWebhook(declaration, {
        ...d,
        delivery,
        now: new Date(fixtures.DELIVERY_TIMESTAMP * 1000),
      });
      const theirs = verifyCalendlyWebhook(d);
      assert.equal(ours.valid, theirs.valid, d.name);
      if (ours.valid) {
        valid++;
        assert.deepEqual(ours.event, theirs.event, d.name);
      }
    }
    assert.equal(valid, 2);
  } finally {
    Date.now = realNow;
  }
});
