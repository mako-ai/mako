/**
 * A Custom API connection that signs in as a Google service account: the
 * token each request carries, which token is made for what, how long one is
 * kept, what may be saved, and that neither the key nor the token comes back.
 * No network: the transport and Google's token endpoint are replaced.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import {
  callableFor,
  googleCredentialRefusal,
  isGoogleApiUrl,
} from "./callable";
import { forward, setTransportForTests } from "./forward";
import {
  parseServiceAccountKey,
  setGoogleTokenMinterForTests,
  type GoogleTokenRequest,
  type ServiceAccountKey,
} from "./google-service-account";
import { CustomApiConnector } from "../connectors/custom_api/connector";
import { isSecretField } from "../connectors/source-connection-create.service";
import type { ISourceConnection } from "../database/workspace-schema";

const PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";
const KEY_FILE = JSON.stringify({
  type: "service_account",
  project_id: "acme",
  client_email: "svc@acme.iam.gserviceaccount.com",
  private_key: PRIVATE_KEY,
  token_uri: "http://169.254.169.254/token",
});

const found = callableFor("custom_api");
if (!found) throw new Error("no call profile for custom_api");
const customApi = found;

function connection(
  config: Record<string, unknown>,
): Pick<ISourceConnection, "_id" | "type" | "config" | "settings"> {
  return {
    _id: new Types.ObjectId(),
    type: "custom_api",
    config,
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
  };
}

/** An ID token (a JWT) that expires `inMs` from now. */
function idToken(inMs: number, tag = "a"): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor((Date.now() + inMs) / 1000), tag }),
  ).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
}

let minted: { key: ServiceAccountKey; request: GoogleTokenRequest }[];
let nextToken: () => string;
let sent: { url: string; headers: Record<string, string> }[];

beforeEach(() => {
  minted = [];
  let n = 0;
  nextToken = () => `ya29.token_${++n}`;
  setGoogleTokenMinterForTests(async (key, request) => {
    minted.push({ key, request });
    return nextToken();
  });
  sent = [];
  setTransportForTests(async (url, options) => {
    sent.push({ url, headers: options.headers });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(
        JSON.stringify({ echo: options.headers.authorization, ok: true }),
      ),
    };
  });
});

afterEach(() => {
  setGoogleTokenMinterForTests(null);
  setTransportForTests(null);
});

describe("access token", () => {
  const config = {
    base_url: "https://sheets.googleapis.com/v4",
    auth_type: "google_service_account",
    service_account_json: KEY_FILE,
  };

  it("sends a bearer token made for cloud-platform, and never passes it back", async () => {
    const result = await forward(connection(config), customApi, {
      method: "GET",
      path: "/spreadsheets/abc",
    });
    expect(sent[0].headers.authorization).toBe("Bearer ya29.token_1");
    expect(minted[0].request).toEqual({
      kind: "access",
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    expect(result.body).toEqual({ echo: "[redacted]", ok: true });
  });

  it("takes scopes as entered, and a user to act as", async () => {
    await forward(
      connection({
        ...config,
        scopes:
          "https://www.googleapis.com/auth/drive.readonly,\n https://www.googleapis.com/auth/spreadsheets",
        subject: "ops@acme.com",
      }),
      customApi,
      { method: "GET", path: "/" },
    );
    expect(minted[0].request).toEqual({
      kind: "access",
      scopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/spreadsheets",
      ],
      subject: "ops@acme.com",
    });
  });

  it("reads only the email and private key from the key file, never its token_uri", () => {
    expect(parseServiceAccountKey(KEY_FILE)).toEqual({
      client_email: "svc@acme.iam.gserviceaccount.com",
      private_key: PRIVATE_KEY,
    });
  });

  it("keeps a token for later requests, one per key and scopes", async () => {
    const one = connection(config);
    await forward(one, customApi, { method: "GET", path: "/" });
    await forward(one, customApi, { method: "GET", path: "/" });
    expect(minted).toHaveLength(1);
    await forward(connection({ ...config, scopes: "openid" }), customApi, {
      method: "GET",
      path: "/",
    });
    expect(minted).toHaveLength(2);
  });
});

describe("an access token goes only to a Google API", () => {
  it("knows googleapis.com and its subdomains over https, nothing else", () => {
    expect(isGoogleApiUrl("https://sheets.googleapis.com/v4")).toBe(true);
    expect(isGoogleApiUrl("https://googleapis.com")).toBe(true);
    expect(isGoogleApiUrl("https://evil-googleapis.com")).toBe(false);
    expect(isGoogleApiUrl("https://googleapis.com.evil.io")).toBe(false);
    expect(isGoogleApiUrl("http://sheets.googleapis.com")).toBe(false);
    expect(isGoogleApiUrl("https://api.example.com")).toBe(false);
    expect(isGoogleApiUrl("")).toBe(false);
  });

  it("refuses to save one for any other address", () => {
    expect(
      googleCredentialRefusal({
        base_url: "https://api.example.com",
        auth_type: "google_service_account",
        service_account_json: KEY_FILE,
      }),
    ).toMatch(/googleapis\.com/);
    expect(
      googleCredentialRefusal({
        base_url: "https://billing-abc123-ew.a.run.app",
        auth_type: "google_id_token",
        service_account_json: KEY_FILE,
      }),
    ).toBeNull();
  });

  it("never makes or sends one for another address, saved or not", async () => {
    const error = await forward(
      connection({
        base_url: "https://api.example.com",
        auth_type: "google_service_account",
        service_account_json: KEY_FILE,
      }),
      customApi,
      { method: "GET", path: "/" },
    ).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/googleapis\.com/);
    expect(minted).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe("ID token", () => {
  const config = {
    base_url: "https://billing-abc123-ew.a.run.app/api/v1",
    auth_type: "google_id_token",
    service_account_json: KEY_FILE,
  };

  it("is made for the address's origin unless an audience is set", async () => {
    nextToken = () => idToken(60 * 60_000);
    await forward(connection(config), customApi, { method: "GET", path: "/" });
    expect(minted[0].request).toEqual({
      kind: "id",
      audience: "https://billing-abc123-ew.a.run.app",
    });
    await forward(
      connection({ ...config, audience: "1234.apps.googleusercontent.com" }),
      customApi,
      { method: "GET", path: "/" },
    );
    expect(minted[1].request).toEqual({
      kind: "id",
      audience: "1234.apps.googleusercontent.com",
    });
  });

  it("is made again when it is about to expire", async () => {
    nextToken = () => idToken(2 * 60_000, String(minted.length));
    const one = connection(config);
    await forward(one, customApi, { method: "GET", path: "/" });
    await forward(one, customApi, { method: "GET", path: "/" });
    expect(minted).toHaveLength(2);
    expect(sent[0].headers.authorization).not.toBe(
      sent[1].headers.authorization,
    );
  });
});

describe("the key never comes back", () => {
  it("scrubs the key file and its private key from an answer", async () => {
    setTransportForTests(async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ file: KEY_FILE, pk: PRIVATE_KEY })),
    }));
    const result = await forward(
      connection({
        base_url: "https://x.googleapis.com",
        auth_type: "google_service_account",
        service_account_json: KEY_FILE,
      }),
      customApi,
      { method: "GET", path: "/" },
    );
    expect(JSON.stringify(result)).not.toContain("MIIEvQIBADANBgkqhkiG9w0B");
  });

  it("names the service account, not the key, when Google refuses it", async () => {
    setGoogleTokenMinterForTests(async () => {
      throw new Error("invalid_grant: Invalid JWT Signature.");
    });
    const error = await forward(
      connection({
        base_url: "https://x.googleapis.com",
        auth_type: "google_service_account",
        service_account_json: KEY_FILE,
      }),
      customApi,
      { method: "GET", path: "/" },
    ).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Google refused the service account svc@acme.iam.gserviceaccount.com: invalid_grant: Invalid JWT Signature.",
    );
    expect(sent).toHaveLength(0);
  });
});

describe("what may be saved", () => {
  const base = {
    base_url: "https://x.googleapis.com",
    auth_type: "google_service_account",
  };

  it("refuses a key that is not a service account's JSON key file", () => {
    expect(googleCredentialRefusal(base)).toMatch(/Paste/);
    expect(
      googleCredentialRefusal({ ...base, service_account_json: "not json" }),
    ).toMatch(/JSON key file/);
    expect(
      googleCredentialRefusal({
        ...base,
        service_account_json: JSON.stringify({ client_email: "a@b" }),
      }),
    ).toMatch(/private_key/);
    expect(
      googleCredentialRefusal({ ...base, service_account_json: KEY_FILE }),
    ).toBeNull();
    expect(
      customApi.configRefusal?.({ ...base, service_account_json: "{}" }),
    ).toMatch(/JSON key file/);
  });

  it("refuses an ID token without an audience to make it for", () => {
    expect(
      googleCredentialRefusal({
        auth_type: "google_id_token",
        base_url: "",
        service_account_json: KEY_FILE,
      }),
    ).toMatch(/audience/);
  });

  it("leaves other credential types alone", () => {
    expect(googleCredentialRefusal({ auth_type: "bearer" })).toBeNull();
    expect(googleCredentialRefusal({})).toBeNull();
  });

  it("stores the key encrypted, and only the app changes who the token is for", () => {
    const field = CustomApiConnector.getConfigSchema().fields.find(
      f => f.name === "service_account_json",
    );
    expect(field && isSecretField(field)).toBe(true);
    expect(customApi.appOnlyFields).toEqual(
      expect.arrayContaining(["auth_type", "scopes", "subject", "audience"]),
    );
  });
});
