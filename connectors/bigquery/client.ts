/**
 * BigQuery's REST API with the connection's own service account, as the
 * former in-process connector did:
 *
 * - the service-account JSON from the connection signs a JWT (RS256, scope
 *   `bigquery.readonly`, one hour), which its `token_uri` exchanges for an
 *   access token. Nothing else is read: no `GOOGLE_APPLICATION_CREDENTIALS`,
 *   no metadata server, no gcloud files. A box holds no other credential,
 *   and this code would not use one if it did;
 * - `<api_base_url>/bigquery/v2` with `Authorization: Bearer`;
 * - no retry. A failed request fails the chunk, and the engine retries the
 *   chunk from its last state, as in-process.
 *
 * It uses `fetch` and `node:crypto`: no Google client library, no
 * dependency. The box template has none either.
 */
import crypto from "node:crypto";

export const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
export const DEFAULT_API_BASE_URL = "https://bigquery.googleapis.com";
export const SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ERROR_BODY = 2_000;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

const ACCEPTED_TOKEN_URIS = new Set([
  DEFAULT_TOKEN_URI,
  "https://accounts.google.com/o/oauth2/token",
]);

/** Fields only a non-service-account Google credential carries. */
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
];

/** The message a refused credential carries; never the credential. */
export const CREDENTIAL_TYPE_NOT_ALLOWED = "credential type not allowed";

/** True for a loopback host, the box's own local server. */
function isLoopback(url: unknown): boolean {
  try {
    const { hostname } = new URL(String(url));
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

/**
 * Google's endpoints. A loopback token endpoint passes only when the API
 * base is loopback too: the local server a test or emulator runs, inside a
 * box that holds no other credential.
 */
function tokenUriAccepted(uri: string, apiBaseUrl: unknown): boolean {
  if (ACCEPTED_TOKEN_URIS.has(uri)) return true;
  return isLoopback(uri) && isLoopback(apiBaseUrl);
}

/**
 * Why `raw` (the JSON as a string, or an object) is not a plain
 * service-account key, or null. Mirrors `checkServiceAccount` in
 * `api/src/connections/google-service-account.ts`.
 */
export function serviceAccountRefusal(
  raw: unknown,
  apiBaseUrl?: unknown,
): string | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return "Service account JSON must be valid JSON";
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return "Service account JSON must be a JSON object";
  }
  const key = obj as Record<string, unknown>;
  if (key.type !== "service_account") {
    return `Google ${CREDENTIAL_TYPE_NOT_ALLOWED}: only service_account keys are accepted`;
  }
  if (FORBIDDEN_FIELDS.some(field => field in key)) {
    return `Google ${CREDENTIAL_TYPE_NOT_ALLOWED}: the key has fields a service_account key does not`;
  }
  if (
    key.token_uri !== undefined &&
    (typeof key.token_uri !== "string" ||
      !tokenUriAccepted(key.token_uri, apiBaseUrl))
  ) {
    return `Google ${CREDENTIAL_TYPE_NOT_ALLOWED}: token_uri must be Google's token endpoint`;
  }
  if (
    typeof key.client_email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key.client_email.trim())
  ) {
    return "Service account JSON needs a client_email that is an email address";
  }
  if (
    typeof key.private_key !== "string" ||
    !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key.private_key)
  ) {
    return "Service account JSON needs a private_key in PEM form";
  }
  return null;
}

/**
 * `getServiceAccount`: the JSON as a string, or already an object. Refused
 * with an Error that names no value unless it is a plain service_account key.
 */
export function serviceAccount(
  raw: unknown,
  apiBaseUrl?: unknown,
): ServiceAccount {
  const refusal = serviceAccountRefusal(raw, apiBaseUrl);
  if (refusal) throw new Error(refusal);
  const obj = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<
    string,
    string
  >;
  return {
    client_email: obj.client_email.trim(),
    private_key: obj.private_key,
    token_uri: obj.token_uri || DEFAULT_TOKEN_URI,
  };
}

const base64url = (input: Buffer | string) =>
  (Buffer.isBuffer(input) ? input : Buffer.from(input))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

export class BigQueryHttpError extends Error {
  status: number;
  constructor(status: number, what: string, body: string) {
    super(
      `${what} failed with status code ${status}${body ? `: ${body.slice(0, MAX_ERROR_BODY)}` : ""}`,
    );
    this.name = "BigQueryHttpError";
    this.status = status;
  }
}

async function send(
  url: string,
  init: RequestInit,
  what: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new BigQueryHttpError(response.status, what, text);
  try {
    return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** `getHttpClient`'s base: https:// added, trailing slashes dropped. */
export function apiBase(raw: unknown): string {
  let base = String(raw || DEFAULT_API_BASE_URL).trim();
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return `${base.replace(/\/+$/, "")}/bigquery/v2`;
}

export class BigQueryClient {
  private token: string | null = null;
  private readonly base: string;
  private readonly account: ServiceAccount;

  constructor(account: ServiceAccount, apiBaseUrl: unknown) {
    this.account = account;
    this.base = apiBase(apiBaseUrl);
  }

  /** A JWT signed with the connection's key, exchanged at its token_uri. */
  private async accessToken(): Promise<string> {
    if (this.token) return this.token;
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: this.account.client_email,
      scope: SCOPE,
      aud: this.account.token_uri,
      iat: now,
      exp: now + 3600,
    };
    const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(input);
    signer.end();
    const assertion = `${input}.${base64url(signer.sign(this.account.private_key))}`;
    const data = await send(
      this.account.token_uri,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      },
      "Token request",
    );
    this.token = String(data.access_token);
    return this.token;
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
    };
  }

  async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const headers = await this.headers();
    return send(
      `${this.base}${path}`,
      { method: "POST", headers, body: JSON.stringify(body) },
      `POST ${path}`,
    );
  }

  async get(
    path: string,
    params: Record<string, string | number>,
  ): Promise<Record<string, unknown>> {
    const headers = await this.headers();
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    return send(url.toString(), { method: "GET", headers }, `GET ${path}`);
  }
}

/**
 * `bigQueryJobLabels` (api/src/services/bigquery-labels.ts): `mako_source`,
 * `mako_connector` and `mako_workspace`, made valid for BigQuery. The ids
 * come from Mako as `__connection_id` and `__workspace_id`.
 */
export function jobLabels(
  source: string,
  connectionId: unknown,
  workspaceId: unknown,
): Record<string, string> {
  const merged: Record<string, string> = { mako_source: source };
  if (connectionId) merged.mako_connector = String(connectionId);
  if (workspaceId) merged.mako_workspace = String(workspaceId);
  const part = (raw: string) =>
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .slice(0, 63);
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(merged)) {
    let key = part(rawKey);
    if (!key) continue;
    if (!/^[a-z]/.test(key)) key = `l_${key}`.slice(0, 63);
    const value = part(rawValue);
    if (value) out[key] = value;
  }
  return out;
}
