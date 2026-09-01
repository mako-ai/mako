/**
 * `applySchemaEncryption` must fail CLOSED.
 *
 * It used to catch the encryption error and store the value as-is, so a
 * missing or malformed ENCRYPTION_KEY stored a customer's API key in
 * plaintext and returned 201 — silently. The census in
 * connectors/credential-encryption.test.ts proves every secret field is
 * MARKED; this proves marking a field cannot end in plaintext.
 *
 * Run: npx tsx src/routes/schema-encryption.test.ts
 */
import assert from "node:assert/strict";

import { isEncryptedValue } from "../services/crypto.service";

async function main(): Promise<void> {
  const { applySchemaEncryption, SecretEncryptionError } = await import(
    "./sources"
  );
  const schema = {
    fields: [
      { name: "account", type: "text" },
      { name: "api_key", type: "password" },
      {
        name: "accounts",
        type: "object_array",
        itemFields: [
          { name: "label", type: "text" },
          { name: "token", type: "text", encrypted: true },
        ],
      },
    ],
  };
  const config = {
    account: "acme",
    api_key: "sk_live_SECRET",
    accounts: [{ label: "eu", token: "tok_SECRET" }],
  };

  // With a key: every marked field is ciphertext, nothing else is touched.
  process.env.ENCRYPTION_KEY = "11".repeat(32);
  const ok = applySchemaEncryption(structuredClone(config), schema);
  assert.equal(ok.account, "acme");
  assert.ok(isEncryptedValue(ok.api_key), "password field must be ciphertext");
  assert.ok(
    isEncryptedValue(ok.accounts[0].token),
    "encrypted: true inside object_array must be ciphertext",
  );
  assert.equal(ok.accounts[0].label, "eu");
  assert.doesNotMatch(JSON.stringify(ok), /SECRET/);

  // Without a key: throws, names the field, never the value. The previous
  // behaviour returned `{ api_key: "sk_live_SECRET" }` here.
  delete process.env.ENCRYPTION_KEY;
  assert.throws(
    () => applySchemaEncryption(structuredClone(config), schema),
    (error: unknown) => {
      assert.ok(error instanceof SecretEncryptionError);
      assert.equal(error.field, "api_key");
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    },
  );

  // A malformed key (wrong length) is the other realistic misconfiguration.
  process.env.ENCRYPTION_KEY = "abcd";
  assert.throws(
    () => applySchemaEncryption(structuredClone(config), schema),
    SecretEncryptionError,
  );

  // The route helper must not have quietly grown a fallback again.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const source = readFileSync(join(__dirname, "sources.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /catch\s*(\([^)]*\))?\s*\{[^}]*target\[key\] = val;/,
    "applySchemaEncryption has a plaintext fallback again",
  );

  console.log("schema-encryption fail-closed tests passed");
}

main().catch((error: unknown) => {
  throw error;
});
