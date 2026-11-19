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
  project_id?: string;
  /** Google's token endpoint (the key's own only when it names Google's). */
  token_uri: string;
}

/** The only token endpoint a key may use; always the one signed against. */
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const ACCEPTED_TOKEN_URIS = new Set([
  GOOGLE_TOKEN_URI,
  "https://accounts.google.com/o/oauth2/token",
]);

/**
 * Fields only a non-service-account credential carries. google-auth-library
 * follows them (files, URLs, executables, impersonation), so a key holding
 * any of them is refused whatever its `type` says.
 */
const FORBIDDEN_FIELDS = [
  "credential_source",
  "token_url",
  "service_account_impersonation_url",
  "service_account_impersonation",
  "executable",
  "subject_token_type",
  "audience",
  "workforce_pool_user_project",
  "source_credentials",
  "refresh_token",
  "quota_project_id_url",
] as const;

/**
 * Google's endpoints, plus a loopback address under NODE_ENV=test (the
 * BigQuery parity harness signs against a local token server).
 */
function tokenUriAccepted(uri: string): boolean {
  if (ACCEPTED_TOKEN_URIS.has(uri)) return true;
  if (process.env.NODE_ENV !== "test") return false;
  try {
    const { hostname } = new URL(uri);
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

/** The message every refused credential carries; never the credential. */
export const CREDENTIAL_TYPE_NOT_ALLOWED = "credential type not allowed";

export type ServiceAccountCheck =
  { ok: true; key: ServiceAccountKey } | { ok: false; reason: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Checks a stored or pasted Google key (a JSON string or an object) and
 * returns only what Mako signs with. Only `type: "service_account"` passes.
 * The reason never repeats a value from the key.
 */
export function checkServiceAccount(raw: unknown): ServiceAccountCheck {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) {
      return {
        ok: false,
        reason: "Paste the service account's JSON key file.",
      };
    }
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        reason: "The service account key must be the JSON key file.",
      };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "Paste the service account's JSON key file." };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "service_account") {
    return {
      ok: false,
      reason: `Google ${CREDENTIAL_TYPE_NOT_ALLOWED}: only service_account keys are accepted.`,
    };
  }
  if (FORBIDDEN_FIELDS.some(field => field in obj)) {
    return {
      ok: false,
      reason: `Google ${CREDENTIAL_TYPE_NOT_ALLOWED}: the key has fields a service_account key does not.`,
    };
  }
  if (
    obj.token_uri !== undefined &&
    (typeof obj.token_uri !== "string" || !tokenUriAccepted(obj.token_uri))
  ) {
    return {
      ok: false,
      reason: `Google ${CREDENTIAL_TYPE_NOT_ALLOWED}: token_uri must be Google's token endpoint.`,
    };
  }
  const { client_email, private_key, project_id } = obj;
  if (typeof client_email !== "string" || !EMAIL.test(client_email.trim())) {
    return {
      ok: false,
      reason:
        "The service account key needs a client_email that is an email address.",
    };
  }
  if (typeof private_key !== "string" || !PEM.test(private_key)) {
    return {
      ok: false,
      reason: "The service account key needs a private_key in PEM form.",
    };
  }
  return {
    ok: true,
    key: {
      client_email: client_email.trim(),
      private_key,
      token_uri:
        typeof obj.token_uri === "string" ? obj.token_uri : GOOGLE_TOKEN_URI,
      ...(typeof project_id === "string" && project_id ? { project_id } : {}),
    },
  };
}

/** The validated key, or an Error that names the problem and no value. */
export function requireServiceAccount(raw: unknown): ServiceAccountKey {
  const checked = checkServiceAccount(raw);
  if (!checked.ok) throw new Error(checked.reason);
  return checked.key;
}

/**
 * Why a connection config's `service_account_json` cannot be saved, or null
 * when it is empty or a plain service-account key. For the save routes.
 */
export function serviceAccountConfigRefusal(
  config: Record<string, unknown> | null | undefined,
): string | null {
  const raw = config?.service_account_json;
  if (raw === undefined || raw === null || raw === "") return null;
  const checked = checkServiceAccount(raw);
  return checked.ok ? null : checked.reason;
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
  if (typeof raw !== "string") return null;
  const checked = checkServiceAccount(raw);
  return checked.ok ? checked.key : null;
}

/** Why `raw` cannot be saved as a service-account key, or null. */
export function serviceAccountKeyRefusal(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return "Paste the service account's JSON key file.";
  }
  const checked = checkServiceAccount(raw);
  return checked.ok ? null : checked.reason;
}

/**
 * The `credentials` option for Google Cloud client libraries (BigQuery,
 * Storage): the validated email and key, nothing else. The raw JSON never
 * reaches a library, which would follow `type`, `credential_source` and
 * `token_url` from it.
 */
export function googleClientCredentials(raw: unknown): {
  client_email: string;
  private_key: string;
} {
  const { client_email, private_key } = requireServiceAccount(raw);
  return { client_email, private_key };
}

/**
 * Tokens for Google APIs built from a validated key only, never from raw
 * JSON. The one place in the API that constructs a google-auth client from
 * tenant input.
 */
export function googleJwtClient(
  raw: unknown,
  scopes: string[],
  options: { subject?: string } = {},
): JWT {
  const key = requireServiceAccount(raw);
  return new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes,
    ...(key.project_id ? { projectId: key.project_id } : {}),
    ...(options.subject ? { subject: options.subject } : {}),
  });
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
