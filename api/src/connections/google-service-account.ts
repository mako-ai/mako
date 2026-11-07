/**
 * Short-lived Google tokens made from a stored service-account key, for a
 * Custom API connection that signs in as a service account
 * (connections/callable.ts).
 *
 * Two kinds: an OAuth access token for Google APIs (scopes, optionally on
 * behalf of a Workspace user), or an ID token for a service behind Google
 * sign-in (Cloud Run, Cloud Functions, IAP), made for one audience.
 *
 * The key's own `token_uri` is never used: tokens always come from Google's
 * token endpoint, so a stored key cannot make Mako post a signed assertion to
 * an address of its choosing. Tokens are kept in memory per key and audience
 * until shortly before they expire.
 */
import { createHash } from "node:crypto";
import { JWT } from "google-auth-library";

/** The fields of a service-account key file Mako reads. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** What a token is for. */
export type GoogleTokenRequest =
  | { kind: "access"; scopes: string[]; subject?: string }
  | { kind: "id"; audience: string };

/** The scope used when a connection lists none. */
export const DEFAULT_GOOGLE_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform";

/** A stored key as JSON, or null when it is not a service-account key. */
export function parseServiceAccountKey(raw: unknown): ServiceAccountKey | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { client_email, private_key } = parsed as Record<string, unknown>;
  if (typeof client_email !== "string" || !client_email.trim()) return null;
  if (typeof private_key !== "string" || !private_key.includes("PRIVATE KEY")) {
    return null;
  }
  return { client_email: client_email.trim(), private_key };
}

/** Why `raw` cannot be saved as a service-account key, or null. */
export function serviceAccountKeyRefusal(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return "Paste the service account's JSON key file.";
  }
  return parseServiceAccountKey(raw)
    ? null
    : "The service account key must be the JSON key file, with client_email and private_key.";
}

type Minter = (
  key: ServiceAccountKey,
  request: GoogleTokenRequest,
) => Promise<string>;

/** Google's token endpoint, through google-auth-library. */
const mintFromGoogle: Minter = async (key, request) => {
  const client = new JWT({
    email: key.client_email,
    key: key.private_key,
    ...(request.kind === "access"
      ? { scopes: request.scopes, subject: request.subject }
      : {}),
  });
  if (request.kind === "id") return client.fetchIdToken(request.audience);
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Google returned no access token");
  return token;
};

let minter: Minter = mintFromGoogle;

/** Tests only: make tokens without a network. */
export function setGoogleTokenMinterForTests(next: Minter | null): void {
  minter = next ?? mintFromGoogle;
  tokens.clear();
}

/** A token is made again when it has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** How long a token without a readable expiry is kept. */
const DEFAULT_LIFETIME_MS = 30 * 60_000;
/** At most this many tokens are kept; the oldest goes first. */
const MAX_CACHED = 200;

const tokens = new Map<string, { token: string; expiresAt: number }>();

function cacheKey(rawKey: string, request: GoogleTokenRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([rawKey, request]))
    .digest("hex");
}

/** A JWT's `exp` in milliseconds; null for an opaque token. */
function jwtExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * A token for `request`, signed with the service account in `rawKey` (the
 * JSON key file). Errors name what Google refused, never the key.
 */
export async function googleToken(
  rawKey: string,
  request: GoogleTokenRequest,
): Promise<string> {
  const key = parseServiceAccountKey(rawKey);
  if (!key) throw new Error(serviceAccountKeyRefusal(rawKey) ?? "Invalid key");
  const id = cacheKey(rawKey, request);
  const now = Date.now();
  const cached = tokens.get(id);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now) return cached.token;

  let token: string;
  try {
    token = await minter(key, request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Google refused the service account ${key.client_email}: ${reason}`,
      { cause: error },
    );
  }
  tokens.delete(id);
  tokens.set(id, {
    token,
    // Access tokens are opaque and last an hour; ID tokens carry their `exp`.
    expiresAt:
      jwtExpiry(token) ??
      now + (request.kind === "access" ? 60 * 60_000 : DEFAULT_LIFETIME_MS),
  });
  while (tokens.size > MAX_CACHED) {
    tokens.delete(tokens.keys().next().value as string);
  }
  return token;
}
