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

/** `scheme://user:password@` anywhere in a text; capture 2 is the password. */
const URI_PASSWORD_ANYWHERE =
  /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)([^@\s/]+)(@)/gi;

/** `?password=…` / `;pwd=…` / `&api_key=…`; capture 1 is the value. */
const CREDENTIAL_PARAMETER_VALUE =
  /[?&;]\s*[a-z0-9_.-]*(?:pass(?:word|wd)?|pwd|secret|token|auth|api[_-]?key|credential)[a-z0-9_.-]*\s*=\s*([^&;\s]+)/gi;

/** `Bearer X` / `Basic X` / `Token X`: capture 1 is the credential part. */
const AUTH_SCHEME_TOKEN = /^\s*(?:bearer|basic|token|bot)\s+(\S+)\s*$/i;

/** Shortest JSON leaf treated as a credential (a header name is shorter). */
const MIN_JSON_LEAF_CHARS = 8;

/**
 * A secret VALUE and the credentials inside it. A secret field often holds a
 * JSON blob (REST/GraphQL `headers`, a service-account JSON string), and an
 * error echoes the token inside it, not the blob — so besides the whole
 * value this yields every string leaf of 8+ characters when it parses as
 * JSON, and the token part of any `Bearer X` / `Basic X` value.
 */
export function credentialFragments(value: string): string[] {
  const found = new Set<string>();
  if (!value) return [];
  found.add(value);
  const leaf = (text: string): void => {
    const scheme = text.match(AUTH_SCHEME_TOKEN);
    if (scheme) found.add(scheme[1]);
    if (text.length >= MIN_JSON_LEAF_CHARS) found.add(text);
  };
  leaf(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [...found];
  }
  const walk = (node: unknown): void => {
    if (typeof node === "string") leaf(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      Object.values(node as Record<string, unknown>).forEach(walk);
    }
  };
  if (parsed && typeof parsed === "object") walk(parsed);
  return [...found];
}

/**
 * The credential VALUES a decrypted database connection holds, for scrubbing
 * text that may echo them (a driver error quoting its connection string):
 * values of credential-named keys (string leaves of credential-named objects
 * too, e.g. a service-account JSON), and passwords embedded in any string
 * value — `scheme://user:pass@` userinfo and credential query parameters.
 */
export function connectionCredentialValues(
  connection: Record<string, unknown> | undefined,
): string[] {
  const found = new Set<string>();
  const leaves = (value: unknown): void => {
    if (typeof value === "string") {
      credentialFragments(value).forEach(fragment => found.add(fragment));
    } else if (Array.isArray(value)) {
      value.forEach(leaves);
    } else if (value && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(leaves);
    }
  };
  const embedded = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(URI_PASSWORD_ANYWHERE)) {
        found.add(match[2]);
      }
      for (const match of value.matchAll(CREDENTIAL_PARAMETER_VALUE)) {
        found.add(match[1]);
      }
    } else if (Array.isArray(value)) {
      value.forEach(embedded);
    } else if (value && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(embedded);
    }
  };
  for (const [key, value] of Object.entries(connection ?? {})) {
    if (SECRET_FIELD.test(key)) leaves(value);
    embedded(value);
  }
  return [...found];
}

/**
 * Mask `scheme://user:password@` userinfo anywhere in a text, whether or not
 * the password is one we know — the shape alone says it is a credential.
 */
export function maskUriPasswords(text: string): string {
  return text.replace(URI_PASSWORD_ANYWHERE, "$1[redacted]$3");
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
