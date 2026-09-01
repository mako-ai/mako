import assert from "node:assert/strict";
import {
  SECRET_KEPT,
  connectionStringGroupKey,
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

// --- connection strings fail CLOSED on any shape we cannot parse ------------

// A URI whose credential sits in a query parameter is NOT masked by a
// URI-shaped rule, so it must be withheld wholesale. This is the shape that
// actually shipped past the first version of this fix: two production
// ClickHouse connections were still handing back their credential.
for (const dsn of [
  "clickhouse:https://host.example.com:8443/db?password=hunter2",
  "clickhouse://host.example.com:8443/db?password=hunter2",
  "host=db.example.com;port=9000;user=mako;password=hunter2",
  "https://api.example.com/v1?api_key=sk-live-1",
  "sqlserver://host/db;pwd=hunter2",
  "mongodb://host/db?authSource=admin&secret=shh",
]) {
  assert.equal(
    redactConnectionSecrets({ connectionString: dsn }).connectionString,
    SECRET_KEPT,
    `must withhold: ${dsn}`,
  );
}

// A string in no recognised format at all is withheld rather than guessed at.
assert.equal(
  redactConnectionSecrets({ connectionString: "not a uri at all" })
    .connectionString,
  SECRET_KEPT,
);

// --- the explorer's grouping key never carries a credential -----------------

// GET /databases (the list) is open to EVERY workspace member, unlike
// GET /databases/{id}. It used to group by a password-masked connection
// string, which is fail-open: the query-parameter and DSN shapes above came
// back verbatim, credential included, to anyone who could open the explorer.
// The key is host-only now, so there is no credential left to fail open with.
const SECRET_IN_KEY = "hunter2";
for (const dsn of [
  "clickhouse://mako:hunter2@db.example.com:8443/analytics",
  "clickhouse:https://host.example.com:8443/db?password=hunter2",
  "clickhouse://host.example.com:8443/db?password=hunter2",
  "host=db.example.com;port=9000;user=mako;password=hunter2",
  "sqlserver://host/db;pwd=hunter2",
  "mongodb://host/db?authSource=admin&secret=shh",
  "not a uri at all",
]) {
  assert.ok(
    !connectionStringGroupKey(dsn).includes(SECRET_IN_KEY),
    `group key must not carry the credential: ${dsn}`,
  );
}

// It still groups: the key is stable, and two connections to the same host
// share it however their credentials differ.
assert.equal(
  connectionStringGroupKey("clickhouse://a:pw1@db.example.com:8443/analytics"),
  connectionStringGroupKey("clickhouse://b:pw2@db.example.com:8443/other"),
);
assert.notEqual(
  connectionStringGroupKey("clickhouse://db.example.com:8443/db"),
  connectionStringGroupKey("clickhouse://other.example.com:8443/db"),
);
// Unparseable strings still group with themselves rather than collapsing
// together into one bucket.
assert.equal(
  connectionStringGroupKey("host=a;password=x"),
  connectionStringGroupKey("host=a;password=x"),
);
assert.notEqual(
  connectionStringGroupKey("host=a;password=x"),
  connectionStringGroupKey("host=b;password=x"),
);
assert.equal(connectionStringGroupKey(""), "unknown");

// Provably credential-free URIs stay legible — over-redacting these would cost
// the edit dialog its usefulness for nothing.
for (const safe of [
  "bigquery://realadvisor-prod",
  "clickhouse://db.example.com:8443/analytics",
  "postgres://db.example.com:5432/analytics?sslmode=require",
]) {
  assert.equal(
    redactConnectionSecrets({ connectionString: safe }).connectionString,
    safe,
    `must stay visible: ${safe}`,
  );
}

// A withheld connection string round-trips like any other secret.
{
  const stored = { connectionString: "host=h;user=u;password=hunter2" };
  const shown = redactConnectionSecrets(stored);
  assert.equal(shown.connectionString, SECRET_KEPT);
  assert.equal(
    restoreKeptSecrets(shown, stored).connectionString,
    stored.connectionString,
  );
}

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
