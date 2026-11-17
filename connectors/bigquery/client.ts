/**
 * BigQuery's REST API with the connection's own service account, as the
 * in-process connector (`api/src/connectors/bigquery/connector.ts`) calls it:
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

/** `getServiceAccount`: the JSON as a string, or already an object. */
export function serviceAccount(raw: unknown): ServiceAccount {
  const obj = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<
    string,
    string
  >;
  return {
    client_email: obj.client_email,
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
