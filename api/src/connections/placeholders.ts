/**
 * Placeholder keys for workspace connectors.
 *
 * A workspace connector (`ws:<slug>`) whose `connector.yaml` says
 * `credentials: proxied` never receives its secret config values. Its
 * sandbox gets `mako-secret:<connectionId>/<field>` in their place, and a
 * short-lived run token. `ctx.http` (packages/connector-sdk) sends each
 * request to Mako's sandbox-fetch route instead of the vendor; Mako swaps
 * the placeholders of THAT connection for the real values (in the URL, the
 * headers, a basic-auth header and the body), sends the request, and strips
 * the values from the answer (connections/forward.ts `clean`).
 *
 * A connector that builds its own client or signs requests cannot use this:
 * it stays `raw` (the default), and today's behaviour is unchanged.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const PLACEHOLDER_PREFIX = "mako-secret:";

/** `mako-secret:<connectionId>/<field>`. */
export function placeholderFor(connectionId: string, field: string): string {
  return `${PLACEHOLDER_PREFIX}${connectionId}/${field}`;
}

const PLACEHOLDER = /mako-secret:([a-f0-9]{24})\/([A-Za-z0-9_.-]{1,128})/g;

/**
 * `config` with every secret field replaced by its placeholder. Nested
 * values are left alone: a workspace connector's secrets are top-level
 * fields of its spec.
 */
export function withPlaceholders(
  config: Record<string, unknown>,
  connectionId: string,
  secretFields: string[],
): Record<string, unknown> {
  const out = { ...config };
  for (const field of secretFields) {
    if (typeof out[field] === "string" && out[field]) {
      out[field] = placeholderFor(connectionId, field);
    }
  }
  return out;
}

export class PlaceholderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceholderError";
  }
}

/**
 * `text` with the placeholders of `connectionId` replaced by `values`. A
 * placeholder of another connection, or of a field that is not a secret of
 * this one, is refused: a connector may only spend its own keys.
 */
export function swapPlaceholders(
  text: string,
  connectionId: string,
  values: Record<string, string>,
): string {
  return text.replace(PLACEHOLDER, (whole, id: string, field: string) => {
    if (id !== connectionId || typeof values[field] !== "string") {
      throw new PlaceholderError(
        `The request carries ${whole}, which is not a key of this connection.`,
      );
    }
    return values[field];
  });
}

/** Whether `text` still holds anything that looks like a placeholder. */
export function hasPlaceholder(text: string): boolean {
  return text.includes(PLACEHOLDER_PREFIX);
}

/**
 * A basic-auth header with the placeholders inside its base64 swapped
 * (Close: `Basic base64("<key>:")`). Any other header value is swapped as
 * text.
 */
export function swapHeader(
  name: string,
  value: string,
  connectionId: string,
  values: Record<string, string>,
): string {
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(value);
  if (name.toLowerCase() === "authorization" && basic) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    if (hasPlaceholder(decoded)) {
      const swapped = swapPlaceholders(decoded, connectionId, values);
      return `Basic ${Buffer.from(swapped, "utf8").toString("base64")}`;
    }
  }
  return swapPlaceholders(value, connectionId, values);
}

// ---------------------------------------------------------------------------
// The run token: which connection a sandbox may spend, until when
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = "mkr_";

function signingKey(): string {
  const key = process.env.ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!key) {
    throw new Error(
      "ENCRYPTION_KEY is not set, so no connector run token can be signed.",
    );
  }
  return key;
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey())
    .update(`connector-run:${payload}`)
    .digest("base64url");
}

export interface RunToken {
  workspaceId: string;
  connectionId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** A token for one connection, for as long as one run may take. */
export function signRunToken(
  token: Omit<RunToken, "expiresAt">,
  ttlMs = 2 * 60 * 60 * 1000,
): string {
  const payload = Buffer.from(
    JSON.stringify({ ...token, expiresAt: Date.now() + ttlMs }),
  ).toString("base64url");
  return `${TOKEN_PREFIX}${payload}.${sign(payload)}`;
}

/** The token's claims, or null when it is forged, malformed or expired. */
export function verifyRunToken(value: string | undefined): RunToken | null {
  if (!value?.startsWith(TOKEN_PREFIX)) return null;
  const [payload, signature] = value.slice(TOKEN_PREFIX.length).split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as RunToken;
    if (
      typeof claims.workspaceId !== "string" ||
      typeof claims.connectionId !== "string" ||
      typeof claims.expiresAt !== "number" ||
      claims.expiresAt < Date.now()
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
