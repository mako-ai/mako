/**
 * Webhook verification primitives (webhook-signature.ts).
 *
 * Run: npx tsx src/connectors/base/webhook-signature.test.ts
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  hmacHex,
  rawWebhookBody,
  timingSafeEqualHex,
  timingSafeEqualString,
} from "./webhook-signature";

function testRawWebhookBody() {
  assert.equal(rawWebhookBody('{"a":1}'), '{"a":1}');
  assert.equal(rawWebhookBody({ a: 1 }), '{"a":1}');
}

function testHmacHex() {
  const expected = crypto
    .createHmac("sha256", "secret")
    .update("body", "utf8")
    .digest("hex");
  assert.equal(hmacHex("secret", "body"), expected);
  const keyBytes = Buffer.from("00ff", "hex");
  assert.equal(
    hmacHex(keyBytes, "body", "sha1"),
    crypto.createHmac("sha1", keyBytes).update("body").digest("hex"),
  );
}

function testTimingSafeEqualHex() {
  const digest = hmacHex("k", "d");
  assert.equal(timingSafeEqualHex(digest, digest), true);
  assert.equal(timingSafeEqualHex(digest, digest.toUpperCase()), true);
  assert.equal(timingSafeEqualHex(digest, digest.slice(0, -2)), false);
  assert.equal(timingSafeEqualHex(digest, "not-hex"), false);
  assert.equal(timingSafeEqualHex(digest, ""), false);
  assert.equal(timingSafeEqualHex("", ""), false, "empty never matches");
  assert.equal(timingSafeEqualHex(digest, hmacHex("k", "e")), false);
}

function testTimingSafeEqualString() {
  assert.equal(timingSafeEqualString("s3cret", "s3cret"), true);
  assert.equal(timingSafeEqualString("s3cret", "S3cret"), false);
  assert.equal(timingSafeEqualString("s3cret", "s3cre"), false);
  assert.equal(timingSafeEqualString("s3cret", "s3cret!"), false);
  assert.equal(timingSafeEqualString("é", "é"), true);
}

testRawWebhookBody();
testHmacHex();
testTimingSafeEqualHex();
testTimingSafeEqualString();
console.info("webhook-signature tests passed");
