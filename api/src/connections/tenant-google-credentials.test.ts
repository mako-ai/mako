import assert from "node:assert/strict";
import { requireTenantServiceAccount } from "./tenant-google-credentials";

const key = {
  type: "service_account",
  project_id: "demo",
  client_email: "svc@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
};

// Missing credentials are refused with a clear message.
for (const raw of [undefined, null, "", "   "]) {
  assert.throws(
    () => requireTenantServiceAccount(raw, "Cloud SQL"),
    /requires a Google service account JSON key/,
  );
}

// Anything that is not a service-account key is refused.
assert.throws(
  () => requireTenantServiceAccount("{nope", "X"),
  /not valid JSON/,
);
assert.throws(
  () => requireTenantServiceAccount("[1]", "X"),
  /must be an object/,
);
assert.throws(
  () => requireTenantServiceAccount({ ...key, type: "authorized_user" }, "X"),
  /service_account/,
);
assert.throws(
  () => requireTenantServiceAccount({ ...key, type: undefined }, "X"),
  /service_account/,
);
assert.throws(
  () => requireTenantServiceAccount({ ...key, private_key: "" }, "X"),
  /client_email and private_key/,
);
assert.throws(
  () => requireTenantServiceAccount({ ...key, client_email: undefined }, "X"),
  /client_email and private_key/,
);

// A valid key parses from a string or an object.
for (const raw of [JSON.stringify(key), key]) {
  const sa = requireTenantServiceAccount(raw, "X");
  assert.equal(sa.client_email, key.client_email);
  assert.equal(sa.project_id, "demo");
  assert.equal(sa.credentials.type, "service_account");
}

// eslint-disable-next-line no-console
console.log("tenant google credentials tests passed");
