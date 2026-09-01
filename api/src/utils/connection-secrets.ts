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
import { createHash } from "node:crypto";

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

/**
 * NOT exported: masking is fail-OPEN — it only recognises `scheme://user:pass@`
 * and hands back anything else untouched. Reachable only through
 * {@link redactConnectionString}, which decides when it is safe to trust.
 * Exporting it once already put a live credential in the list response.
 */
function maskPasswordInConnectionString(connectionString: string) {
  if (!connectionString) return connectionString;
  // protocol://[username:password@]host[:port][/database][?options] — covers
  // mongodb://, mongodb+srv://, postgresql://, mysql://, clickhouse://, ...
  return connectionString.replace(CONNECTION_STRING_PASSWORD, "$1*****$3");
}

/** `scheme://host/path` with no `user:pass@` — nothing to hide in the authority. */
const URI_WITHOUT_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^@]*$/i;

/**
 * A credential carried as a parameter rather than in the authority:
 * `...?password=`, `;pwd=`, `&api_key=`. No URI-shaped mask catches these.
 */
const CREDENTIAL_PARAMETER =
  /[?&;]\s*[a-z0-9_.-]*(pass(word|wd)?|pwd|secret|token|auth|api[_-]?key|credential)[a-z0-9_.-]*\s*=/i;

/**
 * Redact a connection string, failing CLOSED.
 *
 * Masking the password inside a URI keeps the host legible in the edit dialog,
 * which is genuinely useful — but it only works on strings shaped like
 * `scheme://user:pass@host`. Production also holds ClickHouse strings in
 * neither that shape nor any other we parse, carrying their credential as a
 * query parameter; a URI mask leaves those untouched and hands back the secret
 * while looking like it did its job. Partial masking is worse than none,
 * because it reads as safe.
 *
 * So: mask what we can prove, return verbatim only what is provably
 * credential-free, and withhold everything else entirely. An unrecognised
 * format is treated as a secret, not as a host.
 */
export function redactConnectionString(connectionString: string): string {
  if (!connectionString) return connectionString;
  if (CONNECTION_STRING_PASSWORD.test(connectionString)) {
    return maskPasswordInConnectionString(connectionString);
  }
  if (
    URI_WITHOUT_USERINFO.test(connectionString) &&
    !CREDENTIAL_PARAMETER.test(connectionString)
  ) {
    return connectionString;
  }
  return SECRET_KEPT;
}

/**
 * A stable, credential-free key identifying the HOST a connection string points
 * at, for grouping connections in the explorer.
 *
 * The list route used to group by `maskPasswordInConnectionString(...)`, which
 * masks only `scheme://user:pass@` and returns everything else verbatim — so a
 * ClickHouse string carrying its credential as a query parameter went into the
 * response in full. That is the same fail-open masking {@link
 * redactConnectionString} was written to replace, and the list route is the
 * worse place for it: `GET /{id}` is gated to roles that may edit connections,
 * while listing is open to every member of the workspace.
 *
 * A grouping key never needed the credential, so it does not get one. A URI
 * yields `scheme://host:port` — userinfo, path and query dropped, which is
 * legible and groups the way the explorer wants. Anything unparseable falls
 * back to a digest: still stable, still groups identical strings together, and
 * reveals nothing about a format we could not prove safe.
 */
export function connectionStringGroupKey(connectionString: string): string {
  if (!connectionString) return "unknown";
  try {
    const url = new URL(connectionString);
    if (url.host) return `${url.protocol}//${url.host}`;
  } catch {
    // Not a parseable URI — fall through to the digest.
  }
  return `opaque:${createHash("sha256").update(connectionString).digest("hex").slice(0, 16)}`;
}

/** Strip every credential from a decrypted connection, keeping its shape. */
export function redactConnectionSecrets(
  connection: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(connection ?? {})) {
    if (key === "connectionString" && typeof value === "string") {
      redacted[key] = redactConnectionString(value);
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
