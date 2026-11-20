/**
 * The BigQuery query client takes the tenant's api_base_url. In production
 * only an https *.googleapis.com address is allowed, and a refusal happens
 * before the key is read or any request is made. Outside production a local
 * emulator address still works.
 */
import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BigQueryClients } from "./client";
import { assertBigQueryApiBaseUrl } from "../../../utils/bigquery-emulator";

const key = JSON.stringify({
  type: "service_account",
  project_id: "p",
  client_email: "sa@p.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
});

describe("BigQuery api_base_url", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    "http://localhost:9050",
    "localhost:9050",
    "http://127.0.0.1:9050",
    "http://[::1]:9050",
    "http://10.0.0.5",
    "http://192.168.1.10:9050",
    "http://169.254.169.254",
    "https://my-proxy.internal.corp",
    "https://evil.example.com",
    "https://bigquery.googleapis.com.evil.com",
    "https://bigquery.googleapis.com@evil.com",
    "http://bigquery.googleapis.com",
  ])("production refuses %s before any request", async url => {
    vi.stubEnv("NODE_ENV", "production");
    const create = vi.spyOn(axios, "create");
    const post = vi.spyOn(axios, "post");
    await expect(new BigQueryClients().getHttpClient(key, url)).rejects.toThrow(
      /api_base_url/,
    );
    expect(create).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "https://bigquery.googleapis.com",
    "https://bigquery.europe-west3.rep.googleapis.com",
    "bigquery.googleapis.com",
  ])("production allows %s", url => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertBigQueryApiBaseUrl(url)).not.toThrow();
  });

  it("outside production the local emulator works without a token call", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const post = vi.spyOn(axios, "post");
    const client = await new BigQueryClients().getHttpClient(
      key,
      "http://localhost:9050",
    );
    expect(client.defaults.baseURL).toBe("http://localhost:9050/bigquery/v2");
    expect(client.defaults.headers.common["Authorization"]).toBe(
      "Bearer emulator",
    );
    expect(post).not.toHaveBeenCalled();
  });
});
