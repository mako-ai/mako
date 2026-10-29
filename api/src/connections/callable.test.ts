/**
 * Call profiles, credential types and the forwarding core: which requests
 * read, where a path may go, how each credential is sent, and that no answer
 * carries it. Also the three kinds of source connection.
 * No network: the transport is replaced.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import {
  callableFor,
  isGraphqlQuery,
  isGraphqlReadBody,
  isReadRequest,
  type CallableConnection,
} from "./callable";
import { isSyncSource, sourceConnectionKind } from "./kinds";
import {
  ConnectionRequestError,
  callerHeaders,
  formEncode,
  forward,
  setTransportForTests,
  urlUnder,
} from "./forward";
import { CustomApiConnector } from "../connectors/custom_api/connector";
import type { ISourceConnection } from "../database/workspace-schema";

const KEY = "api_live_7f3a9c1e2b4d";

function type(name: string): CallableConnection {
  const found = callableFor(name);
  if (!found) throw new Error(`no call profile for ${name}`);
  return found;
}

function connection(
  kind: string,
  config: Record<string, unknown>,
): Pick<ISourceConnection, "_id" | "type" | "config" | "settings"> {
  return {
    _id: new Types.ObjectId(),
    type: kind,
    config,
    settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
  };
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

describe("reads and writes", () => {
  const read = (kind: string, method: string, path: string, extra = {}) =>
    isReadRequest(
      type(kind),
      { method, path, headers: {}, ...extra },
      (extra as { config?: Record<string, unknown> }).config ?? {},
    );

  it("GET, HEAD and OPTIONS read on every type", () => {
    for (const kind of ["close", "stripe", "wise", "custom_api"]) {
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        expect(read(kind, method, "/anything")).toBe(true);
      }
    }
  });

  it("Close: POST /lead/ told to act as GET reads; POST /task/ writes", () => {
    expect(
      read("close", "POST", "/lead/", {
        headers: { "x-http-method-override": "GET" },
      }),
    ).toBe(true);
    expect(read("close", "POST", "/data/search/")).toBe(true);
    expect(read("close", "POST", "/task/")).toBe(false);
    expect(read("close", "PUT", "/lead/lead_1/")).toBe(false);
    expect(read("close", "DELETE", "/task/task_1/")).toBe(false);
  });

  it("Stripe and Wise: every POST writes", () => {
    expect(read("stripe", "POST", "/v1/customers/search")).toBe(false);
    expect(read("wise", "POST", "/v3/profiles/1/quotes")).toBe(false);
  });

  it("Custom API GraphQL: a query reads, a mutation writes, only when GraphQL is on", () => {
    const on = { config: { graphql: true } };
    expect(
      read("custom_api", "POST", "/", {
        ...on,
        body: { query: "{ me { id } }" },
      }),
    ).toBe(true);
    expect(
      read("custom_api", "POST", "/", {
        ...on,
        body: { query: "query Q { me { id } }" },
      }),
    ).toBe(true);
    expect(
      read("custom_api", "POST", "/", {
        ...on,
        body: { query: "mutation { delete(id: 1) }" },
      }),
    ).toBe(false);
    expect(
      read("custom_api", "POST", "/", { body: { query: "{ me { id } }" } }),
    ).toBe(false);
  });

  it("GraphQL: a mutation hidden after a query, or in a batch, is a write", () => {
    expect(isGraphqlQuery("query A { a } mutation B { b }")).toBe(false);
    expect(isGraphqlQuery("subscription { s }")).toBe(false);
    expect(isGraphqlQuery('{ search(text: "mutation") { id } }')).toBe(true);
    expect(isGraphqlQuery("{ a } # mutation in a comment")).toBe(true);
    expect(
      isGraphqlReadBody([{ query: "{ a }" }, { query: "mutation { b }" }]),
    ).toBe(false);
    expect(isGraphqlReadBody(JSON.stringify({ query: "{ a }" }))).toBe(true);
    expect(isGraphqlReadBody({})).toBe(false);
    expect(isGraphqlReadBody("not json")).toBe(false);
  });
});

describe("paths stay under the base URL", () => {
  const base = "https://api.example.com/v1";

  it("joins a path and a query", () => {
    expect(
      urlUnder(base, "/lead/", { limit: 2, tag: ["a", "b"] }).toString(),
    ).toBe("https://api.example.com/v1/lead/?limit=2&tag=a&tag=b");
    expect(urlUnder(base, "/").toString()).toBe("https://api.example.com/v1");
  });

  it("refuses a path that leaves the base URL", () => {
    for (const path of [
      "/../admin",
      "/a/../../admin",
      "/%2e%2e/admin",
      "/%2E%2E/admin",
      "//evil.example.com/x",
      "/x#frag",
      "/a\\..\\b",
      "relative",
      "https://evil.example.com/",
    ]) {
      expect(() => urlUnder(base, path), path).toThrow(ConnectionRequestError);
    }
  });

  it("refuses a sibling of the base path", () => {
    expect(() => urlUnder("https://api.example.com/v1", "/../v10/x")).toThrow();
  });
});

describe("each credential is added the type's way", () => {
  it("Close: Basic with the key and an empty password", async () => {
    const sent = answering(200, { data: [] });
    await forward(connection("close", { api_key: KEY }), type("close"), {
      method: "GET",
      path: "/lead/",
    });
    expect(sent[0].url).toBe("https://api.close.com/api/v1/lead/");
    expect(sent[0].headers.authorization).toBe(
      `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`,
    );
  });

  it("Stripe: Bearer, a form body, the idempotency header", async () => {
    const sent = answering(200, { id: "cus_1" });
    await forward(connection("stripe", { api_key: KEY }), type("stripe"), {
      method: "POST",
      path: "/v1/customers",
      body: { email: "a@b.c", metadata: { source: "mako" } },
      idempotencyKey: "run-1-step-2",
    });
    expect(sent[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent[0].headers["idempotency-key"]).toBe("run-1-step-2");
    expect(sent[0].headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(sent[0].body).toBe("email=a%40b.c&metadata%5Bsource%5D=mako");
  });

  it("Wise: Bearer on the configured base URL", async () => {
    const sent = answering(200, []);
    await forward(
      connection("wise", {
        api_key: KEY,
        api_base_url: "https://api.sandbox.transferwise.tech/",
      }),
      type("wise"),
      { method: "GET", path: "/v2/profiles" },
    );
    expect(sent[0].url).toBe(
      "https://api.sandbox.transferwise.tech/v2/profiles",
    );
    expect(sent[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("Custom API: bearer, API key in a header or query, basic", async () => {
    const base = { base_url: "https://probo.example.com/api" };
    const cases: Array<[Record<string, unknown>, (s: Sent) => void]> = [
      [
        { auth_type: "bearer", token: KEY },
        s => expect(s.headers.authorization).toBe(`Bearer ${KEY}`),
      ],
      [
        {
          auth_type: "api_key_header",
          token: KEY,
          header_name: "X-Probo-Key",
        },
        s => expect(s.headers["x-probo-key"]).toBe(KEY),
      ],
      [
        { auth_type: "basic", username: "me", password: KEY },
        s =>
          expect(s.headers.authorization).toBe(
            `Basic ${Buffer.from(`me:${KEY}`).toString("base64")}`,
          ),
      ],
      [
        { auth_type: "api_key_query", token: KEY, query_param: "key" },
        s => expect(new URL(s.url).searchParams.get("key")).toBe(KEY),
      ],
    ];
    for (const [config, check] of cases) {
      const sent = answering(200, {});
      await forward(
        connection("custom_api", { ...base, ...config }),
        type("custom_api"),
        {
          method: "GET",
          path: "/x",
        },
      );
      check(sent[0]);
    }
  });

  it("a caller cannot set or replace the credential", async () => {
    expect(
      callerHeaders({
        Authorization: "Bearer mine",
        Cookie: "a=b",
        Host: "evil",
        "Proxy-Authorization": "x",
        Accept: "application/json",
      }),
    ).toEqual({ accept: "application/json" });
  });
});

describe("no secret in any answer", () => {
  it("drops credential headers and cookies, and redacts the key from the body", async () => {
    answering(
      200,
      {
        echoed: KEY,
        auth: `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`,
      },
      {
        "content-type": "application/json",
        authorization: `Basic ${KEY}`,
        "set-cookie": "session=1",
        "x-echo": KEY,
        "x-request-id": "req_1",
      },
    );
    const result = await forward(
      connection("close", { api_key: KEY }),
      type("close"),
      { method: "GET", path: "/me/" },
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(Buffer.from(`${KEY}:`).toString("base64"));
    expect(result.headers).toEqual({
      "content-type": "application/json",
      "x-request-id": "req_1",
    });
  });

  it("drops a Custom API's own key header", async () => {
    answering(200, "ok", { "content-type": "text/plain", "x-probo-key": "x" });
    const result = await forward(
      connection("custom_api", {
        base_url: "https://probo.example.com",
        auth_type: "api_key_header",
        header_name: "X-Probo-Key",
        token: KEY,
      }),
      type("custom_api"),
      { method: "GET", path: "/" },
    );
    expect(result.headers["x-probo-key"]).toBeUndefined();
    expect(result.body).toBe("ok");
  });
});

describe("the Custom API connection", () => {
  const conn = (config: Record<string, unknown>) =>
    new CustomApiConnector(
      connection("custom_api", config) as unknown as ISourceConnection,
    );

  it("is never a sync source", () => {
    const c = conn({ base_url: "https://x.example.com" });
    expect(c.getAvailableEntities()).toEqual([]);
    expect(isSyncSource("custom_api")).toBe(false);
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

describe("kinds of source connection", () => {
  it("are read from the type alone", () => {
    expect(sourceConnectionKind("custom_api")).toBe("custom");
    expect(sourceConnectionKind("close")).toBe("builtin");
    expect(sourceConnectionKind("rest")).toBe("builtin");
    expect(sourceConnectionKind("graphql")).toBe("builtin");
    expect(sourceConnectionKind("ws:close-tasks")).toBe("workspace");
    expect(isSyncSource("close")).toBe(true);
    expect(isSyncSource("ws:close-tasks")).toBe(true);
  });

  it("an unknown credential type on a Custom API falls back to bearer", async () => {
    const sent = answering(200, {});
    await forward(
      connection("custom_api", {
        base_url: "https://x.example.com",
        auth_type: "oauth9",
        token: KEY,
      }),
      type("custom_api"),
      { method: "GET", path: "/" },
    );
    expect(sent[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("form encoding", () => {
  it("nests objects and arrays as Stripe reads them", () => {
    expect(formEncode({ a: 1, b: { c: "d" }, e: ["x", "y"], n: null })).toEqual(
      ["a=1", "b%5Bc%5D=d", "e%5B0%5D=x", "e%5B1%5D=y"],
    );
  });
});
