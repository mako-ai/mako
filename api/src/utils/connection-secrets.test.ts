import assert from "node:assert/strict";
import {
  SECRET_KEPT,
  redactConnectionSecrets,
  restoreKeptSecrets,
} from "./connection-secrets";

// A stored Postgres connection, as the getter decrypts it.
const stored = {
  host: "db.example.com",
  port: 5432,
  database: "analytics",
  username: "mako",
  password: "hunter2",
  ssl: true,
};

// --- redaction: no secret ever leaves the API -------------------------------

const redacted = redactConnectionSecrets(stored);
assert.equal(redacted.password, SECRET_KEPT);
// Everything a person needs to recognise the connection still comes back.
assert.equal(redacted.host, "db.example.com");
assert.equal(redacted.username, "mako");
assert.equal(redacted.port, 5432);
assert.equal(redacted.ssl, true);

// Secret-shaped keys across driver vocabularies, not just `password`.
const wide = redactConnectionSecrets({
  service_account_json: '{"private_key":"..."}',
  apiKey: "sk-live-1",
  api_key: "sk-live-2",
  accessToken: "tok",
  clientSecret: "shh",
  private_key: "-----BEGIN-----",
  credentials: "blob",
  project_id: "realadvisor-prod",
});
for (const key of [
  "service_account_json",
  "apiKey",
  "api_key",
  "accessToken",
  "clientSecret",
  "private_key",
  "credentials",
]) {
  assert.equal(wide[key], SECRET_KEPT, `${key} must be redacted`);
}
assert.equal(wide.project_id, "realadvisor-prod");

// An absent or empty secret stays absent — no sentinel invented for it.
assert.equal(redactConnectionSecrets({ host: "h" }).password, undefined);
assert.equal(redactConnectionSecrets({ password: "" }).password, "");

// A connection string keeps its shape but loses the password.
const withUri = redactConnectionSecrets({
  connectionString: "clickhouse://mako:hunter2@db.example.com:8443/analytics",
});
assert.equal(
  withUri.connectionString,
  "clickhouse://mako:*****@db.example.com:8443/analytics",
);

// --- restore: a round-trip must never clobber the stored secret -------------

// The dialog echoes back exactly what it was given.
const roundTripped = restoreKeptSecrets(
  redactConnectionSecrets(stored),
  stored,
);
assert.equal(roundTripped.password, "hunter2");

// Editing a non-secret field leaves the secret intact.
const edited = restoreKeptSecrets(
  { ...redactConnectionSecrets(stored), host: "replica.example.com" },
  stored,
);
assert.equal(edited.password, "hunter2");
assert.equal(edited.host, "replica.example.com");

// A genuinely new password wins — that is how rotation works.
const rotated = restoreKeptSecrets({ password: "new-secret" }, stored);
assert.equal(rotated.password, "new-secret");

// Deliberately clearing a password is honoured, not silently reverted.
assert.equal(restoreKeptSecrets({ password: "" }, stored).password, "");

// The sentinel must never reach storage when there is nothing to restore.
assert.equal(
  Object.prototype.hasOwnProperty.call(
    restoreKeptSecrets({ password: SECRET_KEPT }, { host: "h" }),
    "password",
  ),
  false,
);

// A masked connection string re-acquires its stored password, and edits to the
// host survive the round-trip.
const storedUri = {
  connectionString: "clickhouse://mako:hunter2@db.example.com:8443/analytics",
};
assert.equal(
  restoreKeptSecrets(
    {
      connectionString: "clickhouse://mako:*****@db.example.com:8443/analytics",
    },
    storedUri,
  ).connectionString,
  storedUri.connectionString,
);
assert.equal(
  restoreKeptSecrets(
    {
      connectionString:
        "clickhouse://mako:*****@replica.example.com:8443/analytics",
    },
    storedUri,
  ).connectionString,
  "clickhouse://mako:hunter2@replica.example.com:8443/analytics",
);

// A password containing regex-replacement syntax must survive verbatim.
assert.equal(
  restoreKeptSecrets(
    { connectionString: "postgres://mako:*****@h/db" },
    { connectionString: "postgres://mako:pa$$&`w'd@h/db" },
  ).connectionString,
  "postgres://mako:pa$$&`w'd@h/db",
);

// A wholly retyped connection string is taken as written.
assert.equal(
  restoreKeptSecrets(
    { connectionString: "clickhouse://mako:typed@db.example.com/analytics" },
    storedUri,
  ).connectionString,
  "clickhouse://mako:typed@db.example.com/analytics",
);

console.log("connection-secrets tests passed");
