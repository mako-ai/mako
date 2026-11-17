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
  declaredWebhookVerification,
  verifyDeclaredWebhook,
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
    const ours = verifyDeclaredWebhook(declaration, delivery);
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
    verifyDeclaredWebhook(declaration, { ...valid, headers: shouted }).valid,
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
  const signature = createHmac("sha256", "s3cret")
    .update(`1700000000.${body}`)
    .digest("base64");
  const headers = { "x-ts": "1700000000", "x-sig": `v1=${signature}` };
  assert.equal(
    verifyDeclaredWebhook(declaration, {
      payload: body,
      headers,
      secret: "s3cret",
    }).valid,
    true,
  );
  for (const [name, options] of [
    ["no prefix", { headers: { ...headers, "x-sig": signature } }],
    ["other secret", { secret: "other" }],
    ["no secret", { secret: undefined }],
    ["no timestamp", { headers: { "x-sig": headers["x-sig"] } }],
    ["other body", { payload: body.replace("evt_1", "evt_2") }],
  ] as const) {
    const result = verifyDeclaredWebhook(declaration, {
      payload: body,
      headers,
      secret: "s3cret",
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
