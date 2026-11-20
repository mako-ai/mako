/**
 * Google credential type validation, at save and at every use path.
 *
 * Only `type: "service_account"` keys reach a Google client. A key of another
 * type (external_account, impersonated_service_account, authorized_user, ...)
 * makes google-auth-library follow files, URLs and executables the key names,
 * so every use path validates the decrypted config first and refuses with
 * "credential type not allowed". A stored config that bypassed save
 * validation is the case each use-path test builds.
 *
 * The libraries are replaced here: a test fails the moment any of them is
 * constructed (or any token request is made) from a refused key.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => ({
  BigQuery: vi.fn(),
  Storage: vi.fn(),
  JWT: vi.fn(),
  GoogleAuth: vi.fn(),
}));

vi.mock("@google-cloud/bigquery", () => ({ BigQuery: constructed.BigQuery }));
vi.mock("@google-cloud/storage", () => ({ Storage: constructed.Storage }));
vi.mock("google-auth-library", async importOriginal => ({
  ...(await importOriginal<typeof import("google-auth-library")>()),
  JWT: constructed.JWT,
  GoogleAuth: constructed.GoogleAuth,
}));

import {
  checkServiceAccount,
  CREDENTIAL_TYPE_NOT_ALLOWED,
  googleClientCredentials,
  googleToken,
  parseServiceAccountKey,
  serviceAccountConfigRefusal,
} from "./google-service-account";
import { googleCredentialRefusal } from "./callable";
import { BigQueryClients } from "../databases/drivers/bigquery/client";
import { BigQueryConnector } from "../connectors/bigquery/connector";
import { BigQueryDestinationAdapter } from "../sync-cdc/adapters/bigquery";
import { cancelBigQueryJobs } from "../dbt/bigquery-cancel.service";
import { renderDbtProfile } from "../dbt/adapter-map";
import { DatabaseConnection } from "../database/workspace-schema";
import { CloudSQLPostgresDatabaseDriver } from "../databases/drivers/cloudsql-postgres/driver";

// The boxed folder is its own package (no @makoai/connector-sdk here and
// outside this tsconfig's rootDir): load its client by path.
const boxedClient: {
  serviceAccount(raw: unknown): unknown;
  serviceAccountRefusal(raw: unknown): string | null;
} = await import(
  /* @vite-ignore */ path.resolve(
    __dirname,
    "../../../connectors/bigquery/client.ts",
  )
);
const boxedServiceAccount = boxedClient.serviceAccount;
const boxedRefusal = boxedClient.serviceAccountRefusal;

const PEM =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";

const GOOD = {
  type: "service_account",
  project_id: "acme",
  private_key_id: "abc",
  client_email: "svc@acme.iam.gserviceaccount.com",
  private_key: PEM,
  token_uri: "https://oauth2.googleapis.com/token",
};

/** The shape of the audit's proof of concept. */
const EXTERNAL = {
  type: "external_account",
  audience: "//iam.googleapis.com/x",
  subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  token_url: "http://127.0.0.1:9/steal",
  credential_source: { file: "/proc/self/environ" },
  client_email: "a@b.c",
  private_key: "-----BEGIN PRIVATE KEY-----x",
};
const EXTERNAL_JSON = JSON.stringify(EXTERNAL);

const NOT_ALLOWED = new RegExp(CREDENTIAL_TYPE_NOT_ALLOWED);

function neverConstructed() {
  expect(constructed.BigQuery).not.toHaveBeenCalled();
  expect(constructed.Storage).not.toHaveBeenCalled();
  expect(constructed.JWT).not.toHaveBeenCalled();
  expect(constructed.GoogleAuth).not.toHaveBeenCalled();
}

let axiosPost: ReturnType<typeof vi.spyOn>;
let axiosCreate: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  axiosPost = vi.spyOn(axios, "post");
  axiosCreate = vi.spyOn(axios, "create");
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  vi.restoreAllMocks();
});

function noRequestMade() {
  expect(axiosPost).not.toHaveBeenCalled();
  expect(axiosCreate).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
}

describe("the validator", () => {
  it("accepts a normal service-account key and returns only the safe fields", () => {
    const checked = checkServiceAccount(JSON.stringify(GOOD));
    expect(checked).toEqual({
      ok: true,
      key: {
        client_email: GOOD.client_email,
        private_key: PEM,
        project_id: "acme",
        token_uri: GOOD.token_uri,
      },
    });
    expect(googleClientCredentials(GOOD)).toEqual({
      client_email: GOOD.client_email,
      private_key: PEM,
    });
    expect(checkServiceAccount(GOOD).ok).toBe(true);
  });

  it("accepts a key with no token_uri and Google's documented accounts form", () => {
    const { token_uri: _drop, ...bare } = GOOD;
    expect(checkServiceAccount(bare).ok).toBe(true);
    expect(
      checkServiceAccount({
        ...GOOD,
        token_uri: "https://accounts.google.com/o/oauth2/token",
      }).ok,
    ).toBe(true);
  });

  it("refuses the external_account proof-of-concept shape", () => {
    const checked = checkServiceAccount(EXTERNAL_JSON);
    expect(checked.ok).toBe(false);
    expect(JSON.stringify(checked)).toMatch(NOT_ALLOWED);
    expect(JSON.stringify(checked)).not.toContain("environ");
  });

  it.each([
    "external_account",
    "impersonated_service_account",
    "external_account_authorized_user",
    "authorized_user",
    "anything_else",
  ])("refuses type %s even with a valid email and key", type => {
    expect(checkServiceAccount({ ...GOOD, type }).ok).toBe(false);
  });

  it("refuses a key with no type", () => {
    const { type: _t, ...untyped } = GOOD;
    expect(checkServiceAccount(untyped).ok).toBe(false);
  });

  it.each([
    ["a file credential_source", { credential_source: { file: "/etc/x" } }],
    ["a url credential_source", { credential_source: { url: "http://a/" } }],
    [
      "an executable credential_source",
      { credential_source: { executable: { command: "id" } } },
    ],
    ["token_url", { token_url: "http://a/" }],
    [
      "service_account_impersonation_url",
      { service_account_impersonation_url: "http://a/" },
    ],
    ["executable", { executable: { command: "id" } }],
    ["subject_token_type", { subject_token_type: "x" }],
    ["audience", { audience: "x" }],
    ["workforce_pool_user_project", { workforce_pool_user_project: "x" }],
    ["source_credentials", { source_credentials: {} }],
  ])("refuses a service_account key that also carries %s", (_n, extra) => {
    expect(checkServiceAccount({ ...GOOD, ...extra }).ok).toBe(false);
  });

  it.each([
    "http://169.254.169.254/token",
    "https://evil.example/token",
    "https://oauth2.googleapis.com.evil.example/token",
    "http://10.0.0.1/token",
  ])("refuses the non-Google token_uri %s", token_uri => {
    expect(checkServiceAccount({ ...GOOD, token_uri }).ok).toBe(false);
  });

  it("refuses a loopback token_uri outside tests", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(
        checkServiceAccount({ ...GOOD, token_uri: "http://127.0.0.1:9/token" })
          .ok,
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a bad email, a missing PEM and non-JSON", () => {
    expect(checkServiceAccount({ ...GOOD, client_email: "nope" }).ok).toBe(
      false,
    );
    expect(checkServiceAccount({ ...GOOD, private_key: "x" }).ok).toBe(false);
    expect(checkServiceAccount("{nope").ok).toBe(false);
    expect(checkServiceAccount("").ok).toBe(false);
    expect(checkServiceAccount([]).ok).toBe(false);
  });
});

describe("save time", () => {
  it("serviceAccountConfigRefusal (database and source connection routes) refuses it", () => {
    expect(
      serviceAccountConfigRefusal({ service_account_json: EXTERNAL_JSON }),
    ).toMatch(NOT_ALLOWED);
    expect(
      serviceAccountConfigRefusal({ service_account_json: EXTERNAL }),
    ).toMatch(NOT_ALLOWED);
    expect(
      serviceAccountConfigRefusal({
        service_account_json: JSON.stringify(GOOD),
      }),
    ).toBeNull();
    expect(serviceAccountConfigRefusal({})).toBeNull();
  });

  it("BigQueryConnector.validateConfig refuses it", () => {
    const connector = new BigQueryConnector({
      id: "x",
      name: "x",
      type: "bigquery",
      config: {
        project_id: "p",
        queries: [{ name: "q", query: "select 1" }],
        service_account_json: EXTERNAL_JSON,
      },
    } as never);
    const result = connector.validateConfig();
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(NOT_ALLOWED);
  });

  it("the Custom API Google credential refuses it", () => {
    expect(
      googleCredentialRefusal({
        auth_type: "google_service_account",
        base_url: "https://sheets.googleapis.com",
        service_account_json: EXTERNAL_JSON,
      } as never),
    ).toMatch(NOT_ALLOWED);
  });

  it("the boxed BigQuery connector refuses it", () => {
    expect(boxedRefusal(EXTERNAL_JSON)).toMatch(NOT_ALLOWED);
    expect(boxedRefusal(JSON.stringify(GOOD))).toBeNull();
    expect(
      boxedRefusal(JSON.stringify({ ...GOOD, token_uri: "http://a/" })),
    ).toMatch(NOT_ALLOWED);
  });
});

describe("use time: a stored external_account config fails closed", () => {
  it("BigQuery database driver (BigQueryClients.getHttpClient: queries, catalog, writes, test)", async () => {
    await expect(
      new BigQueryClients().getHttpClient(EXTERNAL_JSON),
    ).rejects.toThrow(NOT_ALLOWED);
    await expect(
      new BigQueryClients().getHttpClient(EXTERNAL as unknown as object),
    ).rejects.toThrow(NOT_ALLOWED);
    noRequestMade();
    neverConstructed();
  });

  it("BigQuery database driver refuses a non-Google token_uri before any request", async () => {
    await expect(
      new BigQueryClients().getHttpClient(
        JSON.stringify({ ...GOOD, token_uri: "http://10.0.0.1/token" }),
      ),
    ).rejects.toThrow(NOT_ALLOWED);
    noRequestMade();
  });

  it("BigQuery source connector (sync, probe, entities)", async () => {
    const connector = new BigQueryConnector({
      id: "x",
      name: "x",
      type: "bigquery",
      config: {
        project_id: "p",
        queries: [{ name: "q", query: "select 1" }],
        service_account_json: EXTERNAL_JSON,
      },
    } as never);
    const tested = await connector.testConnection();
    expect(tested.success).toBe(false);
    expect(JSON.stringify(tested)).not.toContain("environ");
    await expect(
      (
        connector as unknown as { getAccessToken(): Promise<string> }
      ).getAccessToken(),
    ).rejects.toThrow(NOT_ALLOWED);
    noRequestMade();
    neverConstructed();
  });

  it("CDC BigQuery destination adapter (resolveBqClient)", async () => {
    vi.spyOn(DatabaseConnection, "findOne").mockResolvedValue({
      connection: { service_account_json: EXTERNAL_JSON, project_id: "p" },
    } as never);
    const adapter = new BigQueryDestinationAdapter({
      destinationDatabaseId: "000000000000000000000001",
      workspaceId: "000000000000000000000002",
      tableDestination: { schema: "d" },
    } as never);
    await expect(
      (
        adapter as unknown as { resolveBqClient(): Promise<unknown> }
      ).resolveBqClient(),
    ).rejects.toThrow(NOT_ALLOWED);
    neverConstructed();
  });

  it("dbt BigQuery job cancel", async () => {
    await cancelBigQueryJobs({
      credentials: EXTERNAL,
      jobs: [{ jobId: "job_1234" }],
    });
    neverConstructed();
  });

  it("dbt profile and keyfile rendering", () => {
    expect(() =>
      renderDbtProfile(
        {
          type: "bigquery",
          connection: { service_account_json: EXTERNAL_JSON, project_id: "p" },
        } as never,
        {
          name: "prod",
          connectionId: "x",
          targetSchema: "a",
          threads: 1,
        } as never,
      ),
    ).toThrow(NOT_ALLOWED);
  });

  it("dbt keyfile for a normal key holds only the safe fields with type service_account", () => {
    const rendered = renderDbtProfile(
      {
        type: "bigquery",
        connection: {
          service_account_json: JSON.stringify({
            ...GOOD,
            universe_domain: "evil.example",
            auth_uri: "http://evil.example/auth",
          }),
          project_id: "p",
        },
      } as never,
      {
        name: "prod",
        connectionId: "x",
        targetSchema: "a",
        threads: 1,
      } as never,
    );
    const keyfile = JSON.parse(rendered.keyfiles[0].content);
    expect(Object.keys(keyfile).sort()).toEqual([
      "client_email",
      "private_key",
      "project_id",
      "token_uri",
      "type",
    ]);
    expect(keyfile.type).toBe("service_account");
    expect(keyfile.token_uri).toBe("https://oauth2.googleapis.com/token");
  });

  it("Cloud SQL Postgres connector", async () => {
    const driver = new CloudSQLPostgresDatabaseDriver();
    await expect(
      (
        driver as unknown as {
          _getConnector(db: unknown): Promise<unknown>;
        }
      )._getConnector({
        _id: "x",
        type: "cloudsql-postgres",
        connection: { service_account_json: EXTERNAL_JSON },
      }),
    ).rejects.toThrow(NOT_ALLOWED);
    neverConstructed();
  });

  it("Custom API Google token (access and ID)", async () => {
    await expect(
      googleToken(EXTERNAL_JSON, { kind: "access", scopes: ["x"] }),
    ).rejects.toThrow(NOT_ALLOWED);
    await expect(
      googleToken(EXTERNAL_JSON, { kind: "id", audience: "a" }),
    ).rejects.toThrow(NOT_ALLOWED);
    expect(parseServiceAccountKey(EXTERNAL_JSON)).toBeNull();
    neverConstructed();
  });

  it("boxed BigQuery connector folder (check, read and discover all call serviceAccount)", async () => {
    expect(() => boxedServiceAccount(EXTERNAL_JSON)).toThrow(NOT_ALLOWED);
    expect(() => boxedServiceAccount(EXTERNAL)).toThrow(NOT_ALLOWED);
    noRequestMade();
  });
});

describe("guard: no raw Google credential constructors outside the validator", () => {
  const apiSrc = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(apiSrc, "..", "..");
  const allowed = new Set([
    path.join(apiSrc, "connections", "google-service-account.ts"),
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "fixtures") {
        continue;
      }
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|mjs|js)$/.test(name) && !/\.test\./.test(name)) {
        out.push(full);
      }
    }
    return out;
  }

  /** `new BigQuery(`, `new Storage(` and `new JWT(` with an options object. */
  const withOptions = /new\s+(BigQuery|Storage|JWT|GoogleAuth)\s*\(\s*[^)\s]/;
  const rawCredential =
    /\b(fromJSON|keyFilename|keyFile|credentials\s*:\s*(?!\s*(true|false))|GoogleAuth\s*\(\s*\{)/;

  it("only the validator module builds Google clients from tenant input", () => {
    const files = [
      ...walk(path.join(apiSrc)),
      ...walk(path.join(repoRoot, "connectors")),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      if (allowed.has(file)) continue;
      const text = readFileSync(file, "utf8");
      if (!/google-auth-library|@google-cloud\//.test(text)) continue;
      for (const [i, line] of text.split("\n").entries()) {
        if (withOptions.test(line) || rawCredential.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}:${i + 1}`);
        }
      }
    }
    // Reviewed call sites, each building from validated fields only.
    const reviewed = new Set([
      "api/src/sync-cdc/adapters/bigquery.ts",
      "api/src/dbt/bigquery-cancel.service.ts",
      // Application Default Credentials of the server itself, scopes only:
      // no tenant input reaches these.
      "api/src/databases/drivers/cloudsql-postgres/driver.ts",
      "api/src/services/artifact-store.service.ts",
      "api/src/services/kernel-provider/gke-kernel-provider.ts",
    ]);
    const unexpected = offenders.filter(
      o => !reviewed.has(o.slice(0, o.lastIndexOf(":"))),
    );
    expect(unexpected).toEqual([]);
  });

  it("the reviewed call sites pass validated fields, never the raw value", () => {
    const read = (p: string) => readFileSync(path.join(repoRoot, p), "utf8");
    expect(read("api/src/sync-cdc/adapters/bigquery.ts")).toContain(
      "googleClientCredentials(conn.service_account_json)",
    );
    expect(read("api/src/dbt/bigquery-cancel.service.ts")).toContain(
      "requireServiceAccount(params.credentials)",
    );
  });
});
