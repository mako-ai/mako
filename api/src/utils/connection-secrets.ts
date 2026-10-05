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
  /[?&;]\s*[a-z0-9_.-]*(?:pass(?:word|wd)?|pwd|secret|token|auth|api[_-]?key|key|signature|sig|credential)[a-z0-9_.-]*\s*=\s*([^&;\s#"']+)/gi;

/** `Bearer X` / `Basic X` / `Token X`: capture 1 is the credential part. */
const AUTH_SCHEME_TOKEN = /^\s*(?:bearer|basic|token|bot)\s+(\S+)\s*$/i;

/**
 * Keys whose VALUE is a credential inside a structured blob (a service
 * account, a headers map, a params map). Matched case-insensitively after
 * dropping an `x-` header prefix and treating `-` as `_`, so `X-API-Key`
 * and `Authorization` count while `client_email`, `project_id`, `type`,
 * `token_uri` or `Content-Type` do not.
 */
const CREDENTIAL_LEAF_KEYS = new Set([
  "private_key",
  "private_key_id",
  "client_secret",
  "token",
  "access_token",
  "refresh_token",
  "auth_token",
  "secret",
  "password",
  "api_key",
  "apikey",
  "key",
  "authorization",
]);

function isCredentialLeafKey(key: string): boolean {
  return CREDENTIAL_LEAF_KEYS.has(
    key.toLowerCase().replace(/^x-/, "").replace(/-/g, "_"),
  );
}

/** The value as written and as it appears inside a URL (percent-encoded). */
function withEncodedForm(value: string): string[] {
  const encoded = encodeURIComponent(value);
  return encoded === value ? [value] : [value, encoded];
}

/**
 * Credentials INSIDE a structured value — an object, or a string that parses
 * as a JSON object: the string leaves under credential-named keys (and the
 * token of a `Bearer X` / `Basic X` value), never the other leaves. A
 * service account's `private_key` is a credential; its `client_email` and
 * `project_id` are not and stay readable.
 */
function credentialLeaves(node: unknown, found: Set<string>): void {
  const walk = (value: unknown, underCredentialKey: boolean): void => {
    if (typeof value === "string") {
      if (underCredentialKey && value) {
        withEncodedForm(value).forEach(form => found.add(form));
        const scheme = value.match(AUTH_SCHEME_TOKEN);
        if (scheme) withEncodedForm(scheme[1]).forEach(f => found.add(f));
      } else {
        const parsed = parseJsonObject(value);
        if (parsed) walk(parsed, false);
      }
    } else if (Array.isArray(value)) {
      value.forEach(item => walk(item, underCredentialKey));
    } else if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(
        value as Record<string, unknown>,
      )) {
        walk(nested, underCredentialKey || isCredentialLeafKey(key));
      }
    }
  };
  walk(node, false);
}

function parseJsonObject(text: string): object | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A secret VALUE and the credentials inside it, each also in its
 * percent-encoded form (a secret echoed inside a URL). A secret field often
 * holds a JSON blob (REST/GraphQL `headers`, a service-account JSON string)
 * and an error echoes the token inside it, not the blob — so besides the
 * whole value this yields the leaves under credential-named keys and the
 * token part of a `Bearer X` / `Basic X` value.
 */
export function credentialFragments(value: string): string[] {
  if (!value) return [];
  const found = new Set<string>(withEncodedForm(value));
  const scheme = value.match(AUTH_SCHEME_TOKEN);
  if (scheme) withEncodedForm(scheme[1]).forEach(form => found.add(form));
  const parsed = parseJsonObject(value);
  if (parsed) credentialLeaves(parsed, found);
  return [...found];
}

/**
 * Credentials embedded in values that are NOT themselves secrets: a
 * `scheme://user:pass@` password, a `?api_key=` / `&token=` / `&signature=`
 * query parameter inside a URL, and credential-named keys inside a JSON
 * string or object (`params`, `headers`). For a source connection's
 * non-secret fields and a database connection alike.
 */
export function embeddedCredentialValues(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(URI_PASSWORD_ANYWHERE)) {
        withEncodedForm(match[2]).forEach(form => found.add(form));
      }
      for (const match of node.matchAll(CREDENTIAL_PARAMETER_VALUE)) {
        found.add(match[1]);
        try {
          found.add(decodeURIComponent(match[1]));
        } catch {
          // Not valid percent-encoding: the raw form is already added.
        }
      }
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      Object.values(node as Record<string, unknown>).forEach(walk);
    }
  };
  walk(value);
  credentialLeaves(value, found);
  return [...found];
}

/**
 * The credential VALUES a decrypted database connection holds, for scrubbing
 * text that may echo them (a driver error quoting its connection string):
 * values of credential-named keys (for a structured value, its credential
 * leaves only), and credentials embedded in any value — see
 * {@link embeddedCredentialValues}.
 */
export function connectionCredentialValues(
  connection: Record<string, unknown> | undefined,
): string[] {
  const found = new Set<string>();
  for (const [key, value] of Object.entries(connection ?? {})) {
    if (SECRET_FIELD.test(key)) {
      if (typeof value === "string") {
        credentialFragments(value).forEach(fragment => found.add(fragment));
      } else {
        credentialLeaves(value, found);
      }
    }
    embeddedCredentialValues(value).forEach(fragment => found.add(fragment));
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
