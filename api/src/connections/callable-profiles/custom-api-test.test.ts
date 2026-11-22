/**
 * Test for a Custom API connection, through the connector class the
 * registries build from its profile (profile-connector.ts). Moved from
 * callable.test.ts with the deleted `connectors/custom_api/` folder.
 * No network: the transport is replaced.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { setTransportForTests } from "../forward";
import { connectorRegistry } from "../../connectors/registry";
import {
  isOrphanConnectorType,
  isSecretField,
} from "../../connectors/source-connection-create.service";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import type { ISourceConnection } from "../../database/workspace-schema";
import { customApiProfile } from "./custom-api";
import { profileConnectorClass } from "./profile-connector";

const KEY = "api_live_7f3a9c1e2b4d";

const found = profileConnectorClass("custom_api");
if (!found) throw new Error("no connector class for custom_api");
const CustomApiConnector = found;

function connection(config: Record<string, unknown>): ISourceConnection {
  return {
    _id: new Types.ObjectId(),
    type: "custom_api",
    config,
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
  } as unknown as ISourceConnection;
}

type Sent = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

function answering(
  status: number,
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
): Sent[] {
  const sent: Sent[] = [];
  setTransportForTests(async (url, options) => {
    sent.push({
      url,
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
    return {
      status,
      headers,
      body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    };
  });
  return sent;
}

afterEach(() => setTransportForTests(null));

describe("the Custom API connection", () => {
  const conn = (config: Record<string, unknown>) =>
    new CustomApiConnector(connection(config));

  it("is never a sync source", async () => {
    const c = conn({ base_url: "https://x.example.com" });
    expect(c.getAvailableEntities()).toEqual([]);
    await expect(c.fetchEntity({ entity: "x" } as never)).rejects.toThrow(
      "A Custom API connection is never synced. Call it from a workflow with connection(id).",
    );
  });

  it("stores the basic-auth username as a secret, like the password", () => {
    const fields = CustomApiConnector.getConfigSchema().fields;
    expect(fields).toBe(customApiProfile.configSchema.fields);
    const secret = (name: string) =>
      fields.find(f => f.name === name) as {
        encrypted?: boolean;
        type: string;
      };
    expect(isSecretField(secret("username"))).toBe(true);
    expect(isSecretField(secret("password"))).toBe(true);
  });

  it("tests with GET on the test path, or { __typename } for GraphQL", async () => {
    let sent = answering(200, { ok: true });
    let result = await conn({
      base_url: "https://x.example.com/v1",
      token: KEY,
      test_path: "/me",
    }).testConnection();
    expect(result.success).toBe(true);
    expect(sent[0].url).toBe("https://x.example.com/v1/me");

    sent = answering(200, { data: { __typename: "Query" } });
    result = await conn({
      base_url: "https://x.example.com/graphql",
      token: KEY,
      graphql: true,
    }).testConnection();
    expect(result.success).toBe(true);
    expect(sent[0].url).toBe("https://x.example.com/graphql");
    expect(JSON.parse(sent[0].body ?? "{}")).toEqual({
      query: "{ __typename }",
    });
  });

  it("checks a JSON field when test_expect is set", async () => {
    answering(200, { data: { status: "active", count: 2 } });
    let result = await conn({
      base_url: "https://x.example.com",
      token: KEY,
      test_expect: "data.status=active",
    }).testConnection();
    expect(result.success).toBe(true);

    answering(200, { data: { status: "active", count: 2 } });
    result = await conn({
      base_url: "https://x.example.com",
      token: KEY,
      test_expect: "data.count == 2",
    }).testConnection();
    expect(result.success).toBe(true);

    answering(200, { data: { status: "suspended" } });
    result = await conn({
      base_url: "https://x.example.com",
      token: KEY,
      test_expect: "data.status=active",
    }).testConnection();
    expect(result.success).toBe(false);
    expect(result.message).toContain('data.status is "suspended"');

    answering(200, {});
    result = await conn({
      base_url: "https://x.example.com",
      token: KEY,
      test_expect: "ok=true",
    }).testConnection();
    expect(result.success).toBe(false);
    expect(result.message).toContain("ok is missing");
  });

  it("checks ok=true on Slack by default, which says 200 to a bad token", async () => {
    answering(200, { ok: false, error: "invalid_auth" });
    let result = await conn({
      base_url: "https://slack.com/api",
      token: "bad",
      test_path: "/auth.test",
    }).testConnection();
    expect(result.success).toBe(false);
    expect(result.message).toContain("ok is false, not true");
    expect(result.message).toContain("invalid_auth");

    answering(200, { ok: true, team: "T1" });
    result = await conn({
      base_url: "https://slack.com/api",
      token: KEY,
      test_path: "/auth.test",
    }).testConnection();
    expect(result.success).toBe(true);

    // Another API's 200 is not read for `ok`.
    answering(200, { ok: false });
    result = await conn({
      base_url: "https://x.example.com",
      token: KEY,
    }).testConnection();
    expect(result.success).toBe(true);
  });

  it("tests Slack on /auth.test when no test path is set", async () => {
    let sent = answering(200, { ok: false, error: "invalid_auth" });
    let result = await conn({
      base_url: "https://slack.com/api",
      token: "bad",
    }).testConnection();
    expect(sent[0].url).toBe("https://slack.com/api/auth.test");
    expect(result.success).toBe(false);

    sent = answering(200, { ok: true });
    result = await conn({
      base_url: "https://slack.com/api",
      token: KEY,
    }).testConnection();
    expect(sent[0].url).toBe("https://slack.com/api/auth.test");
    expect(result.success).toBe(true);
  });

  it("refuses a test_expect that is not path=value, without calling", async () => {
    for (const bad of ["ok", "ok:true", "ok true"]) {
      const sent = answering(200, { ok: false });
      const result = await conn({
        base_url: "https://slack.com/api",
        token: "bad",
        test_expect: bad,
      }).testConnection();
      expect(result.success).toBe(false);
      expect(result.message).toContain("Test expects must be path=value");
      expect(sent).toHaveLength(0);
    }
  });

  it("compares an object or array expected value as JSON", async () => {
    answering(200, { data: { tags: ["a", "b"], owner: { id: 1 } } });
    let result = await conn({
      base_url: "https://x.example.com",
      token: KEY,
      test_expect: 'data.tags=["a","b"]',
    }).testConnection();
    expect(result.success).toBe(true);

    answering(200, { data: { owner: { id: 2 } } });
    result = await conn({
      base_url: "https://x.example.com",
      token: KEY,
      test_expect: 'data.owner={"id":1}',
    }).testConnection();
    expect(result.success).toBe(false);
    expect(result.message).toContain('data.owner is {"id":2}');
  });

  it("fails test_expect on a 200 answer that is not JSON", async () => {
    answering(200, "<html>ok</html>", { "content-type": "text/html" });
    const result = await conn({
      base_url: "https://x.example.com",
      token: KEY,
      test_expect: "ok=true",
    }).testConnection();
    expect(result.success).toBe(false);
    expect(result.message).toContain("ok is missing");
  });

  it("reports a refused credential and a bad base URL", async () => {
    answering(401, { error: "no" });
    expect(
      (
        await conn({
          base_url: "https://x.example.com",
          token: "bad",
        }).testConnection()
      ).success,
    ).toBe(false);
    expect((await conn({ base_url: "ftp://x" }).testConnection()).success).toBe(
      false,
    );
  });
});

describe("a Custom API connection without a connector folder", () => {
  it("is no orphan where a connector is required: enable, probe, retype", async () => {
    expect(await isOrphanConnectorType("custom_api")).toBe(false);
    expect(
      await syncConnectorRegistry.getConfigSchemaForType(
        "custom_api",
        undefined,
        { connectorOnly: true },
      ),
    ).toEqual(customApiProfile.configSchema);
  });

  it("is in the connector catalog, with the name and form it had", async () => {
    await connectorRegistry.ready();
    const entry = connectorRegistry.getMetadata("custom_api");
    expect(entry?.metadata).toMatchObject({
      name: "Custom API",
      version: "1.0.0",
      supportedEntities: [],
      webhook: { supported: false },
      incremental: { supported: false, mode: "none" },
    });
    expect(
      (
        entry?.connector as unknown as typeof CustomApiConnector
      ).getConfigSchema(),
    ).toBe(customApiProfile.configSchema);
  });

  it("is tested through the registry's connector", async () => {
    const sent = answering(200, { ok: true });
    const connector = await syncConnectorRegistry.getConnectorFor({
      id: "c1",
      name: "api",
      type: "custom_api",
      connection: { base_url: "https://x.example.com", token: KEY },
    } as never);
    expect(await connector?.testConnection()).toEqual({
      success: true,
      message: "Connected (HTTP 200).",
    });
    expect(sent[0].url).toBe("https://x.example.com/");
  });
});
