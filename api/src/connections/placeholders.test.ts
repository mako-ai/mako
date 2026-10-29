/**
 * Placeholder keys for workspace connectors: a `raw` connector's sandbox
 * config is exactly what it was; a `proxied` one gets placeholders and a run
 * token; the sandbox-fetch route swaps only its own connection's
 * placeholders (URL, headers, basic auth, body) and never answers with a key.
 *
 * In-memory Mongo; the connector index, the credential load and the vendor
 * are mocked.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const mode = vi.hoisted(() => ({ credentials: "raw" as "raw" | "proxied" }));
const SPEC = {
  connectionSpecification: {
    type: "object",
    properties: {
      apiKey: { type: "string", airbyte_secret: true },
      lookbackDays: { type: "number" },
    },
  },
};

vi.mock("../connectors/workspace/resolver", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../connectors/workspace/resolver")
  >()),
  loadConnectorDefinition: vi.fn(async (_ws: string, slug: string) => ({
    slug,
    runtime: "node",
    entry: "connector.ts",
    credentials: mode.credentials,
    sha: "a".repeat(40),
    sourceSha: "b",
    spec: SPEC,
    entities: ["open-tasks"],
    status: "indexed",
  })),
}));

const KEY = "api_close_real_key_9f8e7d";
vi.mock("../sync/database-data-source-manager", () => ({
  sourceConnectionManager: {
    getSourceConnection: vi.fn(async () => ({
      connection: { apiKey: KEY, lookbackDays: 3 },
      settings: {},
    })),
  },
}));

vi.mock("../apps/config", async importOriginal => ({
  ...(await importOriginal<typeof import("../apps/config")>()),
  appsGitOriginBase: () => "https://mako.example.com",
}));

import {
  SourceConnection,
  type ISourceConnection,
} from "../database/workspace-schema";
import { SandboxedConnector } from "../connectors/workspace/SandboxedConnector";
import { parseConnectorFile } from "../connectors/workspace/connector-file";
import { setTransportForTests } from "./forward";
import {
  placeholderFor,
  signRunToken,
  swapHeader,
  verifyRunToken,
} from "./placeholders";
import { sandboxFetch } from "./sandbox-fetch.service";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
let connectionId: string;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  mode.credentials = "proxied";
  await SourceConnection.deleteMany({});
  const row = await SourceConnection.create({
    workspaceId: WS,
    name: "ch_close_tasks",
    type: "ws:close-tasks",
    config: { apiKey: "stored" },
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
    createdBy: "u1",
  });
  connectionId = String(row._id);
});

afterEach(() => setTransportForTests(null));

const sandboxConfig = (config: Record<string, unknown>) =>
  (
    new SandboxedConnector({
      _id: connectionId,
      type: "ws:close-tasks",
      workspaceId: WS,
      config,
      settings: {},
    } as unknown as ISourceConnection) as unknown as {
      config(): Promise<Record<string, unknown>>;
    }
  ).config();

describe("connector.yaml credentials", () => {
  it("defaults to raw and accepts proxied, nothing else", () => {
    const raw = parseConnectorFile("runtime: node\n");
    expect(raw.ok && raw.value.credentials).toBe("raw");
    const proxied = parseConnectorFile("runtime: node\ncredentials: proxied\n");
    expect(proxied.ok && proxied.value.credentials).toBe("proxied");
    expect(parseConnectorFile("runtime: node\ncredentials: maybe\n").ok).toBe(
      false,
    );
  });
});

describe("what the sandbox receives", () => {
  it("raw (the default): the stored config itself, unchanged", async () => {
    mode.credentials = "raw";
    const config = { apiKey: KEY, lookbackDays: 3 };
    expect(await sandboxConfig(config)).toBe(config);
  });

  it("proxied: placeholders for secret fields, a token, where to send", async () => {
    const config = (await sandboxConfig({ apiKey: KEY, lookbackDays: 3 })) as {
      apiKey: string;
      lookbackDays: number;
      __http: { proxy: { url: string; token: string } };
    };
    expect(config.apiKey).toBe(placeholderFor(connectionId, "apiKey"));
    expect(config.lookbackDays).toBe(3);
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(config.__http.proxy.url).toBe(
      "https://mako.example.com/api/connections/sandbox-fetch",
    );
    expect(verifyRunToken(config.__http.proxy.token)).toMatchObject({
      workspaceId: String(WS),
      connectionId,
    });
  });
});

describe("run tokens", () => {
  it("refuse a forged, tampered or expired token", () => {
    const token = signRunToken({ workspaceId: "w", connectionId: "c" });
    expect(verifyRunToken(token)?.connectionId).toBe("c");
    expect(verifyRunToken(`${token}x`)).toBeNull();
    expect(verifyRunToken("mkr_e30.abc")).toBeNull();
    expect(verifyRunToken(undefined)).toBeNull();
    expect(
      verifyRunToken(signRunToken({ workspaceId: "w", connectionId: "c" }, -1)),
    ).toBeNull();
  });
});

describe("the sandbox-fetch route", () => {
  type Sent = { url: string; headers: Record<string, string>; body?: string };
  const vendor = (answer: string, headers: Record<string, string> = {}) => {
    const sent: Sent[] = [];
    setTransportForTests(async (url, options) => {
      sent.push({ url, headers: options.headers, body: options.body });
      return {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
        body: Buffer.from(answer),
      };
    });
    return sent;
  };
  const token = () => signRunToken({ workspaceId: String(WS), connectionId });
  const placeholder = () => placeholderFor(connectionId, "apiKey");

  it("swaps the connection's placeholders in the URL, headers, basic auth and body", async () => {
    const sent = vendor('{"ok":true}');
    const basic = `Basic ${Buffer.from(`${placeholder()}:`).toString("base64")}`;
    const result = await sandboxFetch(token(), {
      url: `https://api.close.com/api/v1/task/?key=${placeholder()}`,
      method: "POST",
      headers: { Authorization: basic, "X-Key": placeholder() },
      body: JSON.stringify({ key: placeholder() }),
    });
    expect(sent[0].url).toBe(`https://api.close.com/api/v1/task/?key=${KEY}`);
    expect(sent[0].headers.authorization).toBe(
      `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`,
    );
    expect(sent[0].headers["x-key"]).toBe(KEY);
    expect(sent[0].body).toBe(JSON.stringify({ key: KEY }));
    expect(result.status).toBe(200);
  });

  it("swaps a placeholder the connector URL-encoded into a query string", async () => {
    const sent = vendor("{}");
    await sandboxFetch(token(), {
      url: `https://api.vendor.example/x?apikey=${encodeURIComponent(placeholder())}`,
    });
    expect(sent[0].url).toBe(
      `https://api.vendor.example/x?apikey=${encodeURIComponent(KEY)}`,
    );
    await expect(
      sandboxFetch(token(), {
        url: `https://api.vendor.example/x?apikey=${encodeURIComponent(
          placeholderFor(new Types.ObjectId().toString(), "apiKey"),
        )}`,
      }),
    ).rejects.toThrow(/not a key of this connection/);
  });

  it("never answers with the key, raw or encoded", async () => {
    vendor(JSON.stringify({ echo: KEY }), { "x-echo": KEY, "set-cookie": "a" });
    const result = await sandboxFetch(token(), {
      url: "https://api.close.com/api/v1/me/",
      headers: { authorization: `Bearer ${placeholder()}` },
    });
    const text = Buffer.from(result.body, "base64").toString("utf8");
    expect(text).not.toContain(KEY);
    expect(JSON.stringify(result.headers)).not.toContain(KEY);
    expect(result.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses another connection's placeholder or an unknown field", async () => {
    vendor("{}");
    const other = placeholderFor(new Types.ObjectId().toString(), "apiKey");
    await expect(
      sandboxFetch(token(), {
        url: "https://api.close.com/x",
        headers: { authorization: other },
      }),
    ).rejects.toThrow(/not a key of this connection/);
    await expect(
      sandboxFetch(token(), {
        url: `https://api.close.com/x?k=${placeholderFor(connectionId, "lookbackDays")}`,
      }),
    ).rejects.toThrow(/not a key of this connection/);
  });

  it("refuses a missing token and a raw connector", async () => {
    vendor("{}");
    await expect(
      sandboxFetch(undefined, { url: "https://api.close.com/x" }),
    ).rejects.toThrow(/run token/);
    mode.credentials = "raw";
    await expect(
      sandboxFetch(token(), { url: "https://api.close.com/x" }),
    ).rejects.toThrow(/credentials: proxied/);
  });

  it("swaps nothing that is not a placeholder", () => {
    expect(swapHeader("accept", "application/json", connectionId, {})).toBe(
      "application/json",
    );
  });
});
