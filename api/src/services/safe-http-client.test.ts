/**
 * SSRF guard for the user-URL connectors (REST, GraphQL): private, loopback
 * and metadata targets are refused before any byte is sent, by IP literal,
 * by DNS answer, and on redirect.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphQLConnector } from "../connectors/graphql/connector";
import { RestConnector } from "../connectors/rest/connector";
import {
  assertSafeRedirect,
  createSsrfSafeAxios,
  createSsrfSafeLookup,
} from "./safe-http-client";

// A real server on loopback — the thing an attacker wants to reach. It must
// never see a request.
let hits = 0;
let server: http.Server;
let localUrl = "";
beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits++;
    res.end('{"secret":"internal"}');
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  localUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

describe("createSsrfSafeAxios", () => {
  it.each([
    () => `${localUrl}/`,
    () => "http://169.254.169.254/latest/meta-data/",
    () => "http://[::1]:80/",
    () => "http://10.0.0.5/",
    () => "http://[::ffff:a9fe:a9fe]/",
    () => "http://localhost:1/",
    () => "http://metadata.local/",
    () => "file:///etc/passwd",
  ])("refuses %#", async target => {
    const client = createSsrfSafeAxios();
    await expect(client.get(target())).rejects.toThrow(
      /Blocked|Invalid|scheme/,
    );
  });

  it("refuses an absolute path that escapes a public baseURL", async () => {
    const client = createSsrfSafeAxios({ baseURL: "https://api.example.com" });
    await expect(client.get(`${localUrl}/admin`)).rejects.toThrow(/Blocked/);
  });

  it("a per-request config cannot opt out", async () => {
    const client = createSsrfSafeAxios();
    await expect(
      client.get(`${localUrl}/`, {
        httpAgent: new http.Agent(),
        proxy: false,
      }),
    ).rejects.toThrow(/Blocked/);
  });

  it("never reached the loopback server", () => {
    expect(hits).toBe(0);
  });
});

describe("guarded DNS lookup", () => {
  const lookupWith = (addresses: string[]) =>
    createSsrfSafeLookup((_h, _o, cb) =>
      cb(
        null,
        addresses.map(address => ({
          address,
          family: address.includes(":") ? 6 : 4,
        })),
      ),
    );
  const run = (lookup: ReturnType<typeof createSsrfSafeLookup>, all = false) =>
    new Promise<unknown>((resolve, reject) =>
      lookup("api.example.com", { all }, (err, address) =>
        err ? reject(err) : resolve(address),
      ),
    );

  it("refuses a name that resolves to a private or metadata address", async () => {
    await expect(run(lookupWith(["10.1.2.3"]))).rejects.toThrow(/Blocked/);
    await expect(run(lookupWith(["169.254.169.254"]))).rejects.toThrow(
      /Blocked/,
    );
    // One bad answer among good ones is enough to refuse (rebinding).
    await expect(
      run(lookupWith(["93.184.216.34", "127.0.0.1"]), true),
    ).rejects.toThrow(/Blocked/);
  });

  it("passes public answers through in both callback shapes", async () => {
    expect(await run(lookupWith(["93.184.216.34"]))).toBe("93.184.216.34");
    expect(await run(lookupWith(["93.184.216.34"]), true)).toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
  });
});

describe("redirect re-check", () => {
  it("refuses a redirect to a private, metadata or non-http target", () => {
    for (const hop of [
      { protocol: "http:", hostname: "169.254.169.254" },
      { protocol: "http:", hostname: "127.0.0.1" },
      { protocol: "https:", hostname: "localhost" },
      { protocol: "ftp:", hostname: "example.com" },
    ]) {
      expect(() => assertSafeRedirect(hop)).toThrow();
    }
  });

  it("allows a public hop and strips metadata headers from it", () => {
    const headers: Record<string, unknown> = {
      authorization: "Bearer t",
      "Metadata-Flavor": "Google",
    };
    assertSafeRedirect({
      protocol: "https:",
      hostname: "example.com",
      headers,
    });
    expect(headers).toEqual({ authorization: "Bearer t" });
  });
});

describe("REST and GraphQL connectors", () => {
  it("REST testConnection to the metadata IP fails without connecting", async () => {
    const connector = new RestConnector({
      id: "ds",
      name: "REST",
      type: "rest",
      config: {
        api_base_url: "http://169.254.169.254/latest/meta-data/",
        entities: [{ name: "creds", path: "/iam/", method: "GET" }],
      },
    } as never);
    const result = await connector.testConnection();
    expect(result.success).toBe(false);
    expect(String(result.details)).toMatch(/Blocked/);
  });

  it("GraphQL testConnection to loopback fails and the server is never hit", async () => {
    const connector = new GraphQLConnector({
      id: "ds",
      name: "GraphQL",
      type: "graphql",
      config: { endpoint: `${localUrl}/graphql` },
    } as never);
    const result = await connector.testConnection();
    expect(result.success).toBe(false);
    expect(String(result.details)).toMatch(/Blocked/);
    expect(hits).toBe(0);
  });
});
