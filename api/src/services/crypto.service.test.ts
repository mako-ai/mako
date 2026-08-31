import assert from "node:assert/strict";

import {
  decryptEncrypted,
  decryptRecord,
  decryptString,
  encryptRecord,
  encryptString,
  isEncryptedValue,
} from "./crypto.service";

// getEncryptionKey() reads the env lazily at call time, so setting it here
// (module top-level, after the hoisted imports) is sufficient.
process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function testRoundTripWithFreshIv() {
  const a = encryptString("s3cret:with:colons");
  const b = encryptString("s3cret:with:colons");
  assert.notEqual(a, b, "a fresh IV per call");
  assert.ok(isEncryptedValue(a));
  assert.equal(decryptString(a), "s3cret:with:colons");
  assert.equal(decryptString(b), "s3cret:with:colons");
}

function testNeverDoubleEncrypts() {
  const once = encryptString("token");
  assert.equal(encryptString(once), once);
}

function testTolerantDecryptPassesPlaintextThrough() {
  assert.equal(decryptString("plain"), "plain");
  // Legacy plaintext containing ":" must not be mistaken for iv:ciphertext.
  assert.equal(decryptString("user:pass"), "user:pass");
}

function testStrictDecryptRejectsPlaintext() {
  assert.throws(() => decryptEncrypted("user:pass"), /Invalid encrypted value/);
  assert.equal(decryptEncrypted(encryptString("x")), "x");
}

function testRecordHelpers() {
  const enc = encryptRecord({ a: "1", b: "2" });
  assert.ok(isEncryptedValue(enc.a) && isEncryptedValue(enc.b));
  assert.deepEqual(decryptRecord(enc), { a: "1", b: "2" });
}

testRoundTripWithFreshIv();
testNeverDoubleEncrypts();
testTolerantDecryptPassesPlaintextThrough();
testStrictDecryptRejectsPlaintext();
testRecordHelpers();
console.log("crypto.service tests passed");
