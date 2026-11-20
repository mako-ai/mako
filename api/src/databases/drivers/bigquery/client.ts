/**
 * BigQuery REST clients: one axios instance per service account and API
 * base URL, carrying an OAuth access token minted from the service
 * account's key (a signed JWT exchanged at the token endpoint) and renewed
 * shortly before it expires. A local emulator needs no token.
 */
import { requireServiceAccount } from "../../../connections/google-service-account";
import axios, { type AxiosInstance } from "axios";
import crypto from "crypto";
import { loggers } from "../../../logging";
import {
  assertBigQueryApiBaseUrl,
  isLocalBigQueryEmulator,
} from "../../../utils/bigquery-emulator";
import { describeGoogleApiError } from "./errors";

const logger = loggers.db("bigquery");

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export class BigQueryClients {
  private readonly clients = new Map<
    string,
    { client: AxiosInstance; token: string; expiresAtMs: number }
  >();
  private readonly tokensInFlight = new Map<
    string,
    Promise<{ token: string; expiresAtMs: number }>
  >();

  async getHttpClient(
    serviceAccountJson: string | object,
    apiBaseUrl?: string,
  ): Promise<AxiosInstance> {
    // Refused before the key is read or any request is built.
    assertBigQueryApiBaseUrl(apiBaseUrl);
    const sa = this.parseServiceAccount(serviceAccountJson);
    const base = (apiBaseUrl || "https://bigquery.googleapis.com").trim();
    const normalized = /^https?:\/\//i.test(base) ? base : `https://${base}`;
    const baseURL = normalized.replace(/\/+$/, "") + "/bigquery/v2";

    const cacheKey = crypto
      .createHash("sha256")
      .update(`${sa.client_email}|${sa.token_uri}|${baseURL}`)
      .digest("hex");

    const cached = this.clients.get(cacheKey);
    const now = Date.now();

    // Local emulator (e.g. goccy/bigquery-emulator): no auth. Skip the JWT/OAuth
    // token exchange entirely and send a dummy bearer the emulator ignores. This
    // lets local dev / integration tests run fully offline with fake credentials.
    if (isLocalBigQueryEmulator(apiBaseUrl)) {
      const emulatorClient = cached?.client || axios.create({ baseURL });
      emulatorClient.defaults.headers.common["Authorization"] =
        "Bearer emulator";
      emulatorClient.defaults.headers.common["Content-Type"] =
        "application/json";
      const expiresAtMs = now + 365 * 24 * 60 * 60 * 1000;
      this.clients.set(cacheKey, {
        client: emulatorClient,
        token: "emulator",
        expiresAtMs,
      });
      return emulatorClient;
    }

    // Refresh token if expiring soon (within 2 minutes)
    const needsRefresh = !cached || cached.expiresAtMs - now < 2 * 60 * 1000;

    if (!needsRefresh && cached) {
      return cached.client;
    }

    const inFlight = this.tokensInFlight.get(cacheKey);
    const tokenPromise =
      inFlight ||
      (async () => {
        try {
          return await this.createGoogleAccessTokenWithExpiry(sa);
        } finally {
          this.tokensInFlight.delete(cacheKey);
        }
      })();

    if (!inFlight) {
      this.tokensInFlight.set(cacheKey, tokenPromise);
    }

    const { token, expiresAtMs } = await tokenPromise;

    const client = cached?.client || axios.create({ baseURL });
    client.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    client.defaults.headers.common["Content-Type"] = "application/json";
    this.clients.set(cacheKey, { client, token, expiresAtMs });
    return client;
  }

  private parseServiceAccount(sa: string | object): ServiceAccount {
    let obj: Partial<ServiceAccount> | null;
    try {
      obj = typeof sa === "string" ? JSON.parse(sa) : sa;
    } catch (e) {
      logger.error("Failed to parse service_account_json", { error: e });
      throw new Error("Invalid service_account_json: Not a valid JSON string", {
        cause: e,
      });
    }

    if (!obj || typeof obj !== "object") {
      throw new Error("Invalid service_account_json: Content is not an object");
    }

    // Validated before anything is signed or sent: only service_account
    // keys pass, and the token endpoint is Google's.
    const { client_email, private_key, token_uri } = requireServiceAccount(obj);
    return { client_email, private_key, token_uri };
  }

  private async createGoogleAccessTokenWithExpiry(
    sa: ServiceAccount,
  ): Promise<{ token: string; expiresAtMs: number }> {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/bigquery",
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    };
    const base64url = (input: Buffer | string) =>
      (Buffer.isBuffer(input) ? input : Buffer.from(input))
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(sa.private_key);
    const assertion = `${signingInput}.${base64url(signature)}`;
    let res: { data: { access_token?: string; expires_in?: number } };
    try {
      res = await axios.post(
        sa.token_uri,
        new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );
    } catch (error) {
      const detail = describeGoogleApiError(
        error,
        "Failed to obtain Google access token",
      );
      logger.error("Google access token request failed", {
        clientEmail: sa.client_email,
        tokenUri: sa.token_uri,
        status: (error as { response?: { status?: number } })?.response?.status,
        detail,
      });
      // invalid_grant / invalid_client almost always means the service-account
      // key was rotated, disabled, or deleted. Surface that explicitly instead
      // of the opaque "Request failed with status code 400".
      throw new Error(
        `Google authentication failed for service account "${sa.client_email}": ${detail}. ` +
          `The service-account key may have been rotated, disabled, or deleted — update this connection's service_account_json with a current key.`,
        { cause: error },
      );
    }
    const token = res.data.access_token as string;
    const expiresInSec = Number(res.data.expires_in || 3600);
    // Refresh a bit early by setting the stored expiry slightly before real expiry
    const expiresAtMs = Date.now() + Math.max(60, expiresInSec - 60) * 1000;
    return { token, expiresAtMs };
  }
}
