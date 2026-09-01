/**
 * Connection credentials are WRITE-ONLY: they go in, they never come back out.
 *
 * Reading a stored password served no purpose an operator actually needs —
 * rotating one means typing a new one — while every member of the workspace
 * could GET it in plaintext whatever their role, since the route carried no
 * role gate at all. So no role reads a secret back: `GET /databases/{id}`
 * returns {@link SECRET_KEPT} in place of each credential and a
 * password-masked connection string.
 *
 * That response feeds the connection edit dialog, so it has to survive a
 * round-trip: writes put the stored value back wherever they see the sentinel
 * echoed (or the mask inside a connection string), which leaves editing a host
 * or a database name working without the client ever holding the credential.
 *
 * Pure functions, no I/O — the route and its tests both import from here.
 */

/** Matches `scheme://user:password@` — capture 2 is the password. */
export const CONNECTION_STRING_PASSWORD =
  /^([a-z][a-z0-9+.-]*:\/\/[^:]+:)([^@]+)(@)/;

const MASKED_CONNECTION_STRING = /^([a-z][a-z0-9+.-]*:\/\/[^:]+:)\*{5}(@)/;

/** What the client receives instead of a stored credential. */
export const SECRET_KEPT = "__mako_secret_kept__";

/**
 * Key names that hold a credential, across every driver vocabulary in use
 * (`password`, BigQuery's `service_account_json`, API keys, tokens, ...).
 * `connection` is a Mixed subdocument, so this has to match by name.
 */
const SECRET_FIELD =
  /pass(word|wd)?$|secret|token|api[_-]?key|private[_-]?key|service_account|credential/i;

export function maskPasswordInConnectionString(connectionString: string) {
  if (!connectionString) return connectionString;
  // protocol://[username:password@]host[:port][/database][?options] — covers
  // mongodb://, mongodb+srv://, postgresql://, mysql://, clickhouse://, ...
  return connectionString.replace(CONNECTION_STRING_PASSWORD, "$1*****$3");
}

/** Strip every credential from a decrypted connection, keeping its shape. */
export function redactConnectionSecrets(
  connection: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(connection ?? {})) {
    if (key === "connectionString" && typeof value === "string") {
      redacted[key] = maskPasswordInConnectionString(value);
    } else if (SECRET_FIELD.test(key) && typeof value === "string" && value) {
      redacted[key] = SECRET_KEPT;
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/**
 * Put stored credentials back wherever the client echoed a sentinel. A value
 * the user actually retyped wins, so rotation and deliberate clearing both
 * still work.
 */
export function restoreKeptSecrets(
  incoming: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const restored: Record<string, unknown> = { ...incoming };

  for (const [key, value] of Object.entries(restored)) {
    if (value !== SECRET_KEPT) continue;
    if (typeof previous[key] === "string") restored[key] = previous[key];
    // Nothing stored to put back: drop it rather than persist the sentinel.
    else delete restored[key];
  }

  // A masked connection string comes back as `scheme://user:*****@host/db`.
  // Re-inject the stored password so edits to the host or database still save.
  const candidate = restored.connectionString;
  const stored = previous.connectionString;
  if (
    typeof candidate === "string" &&
    typeof stored === "string" &&
    MASKED_CONNECTION_STRING.test(candidate)
  ) {
    const password = stored.match(CONNECTION_STRING_PASSWORD)?.[2];
    restored.connectionString = password
      ? // Replace via callback: a password containing `$` must not be read
        // as a replacement pattern.
        candidate.replace(
          MASKED_CONNECTION_STRING,
          (_match, prefix: string, at: string) => `${prefix}${password}${at}`,
        )
      : stored;
  }

  return restored;
}
