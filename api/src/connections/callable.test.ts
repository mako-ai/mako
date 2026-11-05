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
import { sourceConnectionKind } from "./kinds";
import {
  ConnectionRequestError,
  callerHeaders,
  formEncode,
  forward,
  resolveRequest,
  setTransportForTests,
  urlUnder,
} from "./forward";
import { CustomApiConnector } from "../connectors/custom_api/connector";
import { isSecretField } from "../connectors/source-connection-create.service";
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
    expect(read("close", "POST", "/lead/", { methodOverride: "GET" })).toBe(
      true,
    );
    expect(read("close", "POST", "/data/search/")).toBe(true);
    expect(read("close", "POST", "/task/")).toBe(false);
    expect(read("close", "PUT", "/lead/lead_1/")).toBe(false);
    expect(read("close", "DELETE", "/task/task_1/")).toBe(false);
  });

  it("Close: the GET override reads only on a POST", () => {
    const override = { methodOverride: "GET" };
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      expect(read("close", method, "/lead/lead_1/", override)).toBe(false);
    }
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
    expect(isGraphqlQuery("{ a } # mutation in a comment")).toBe(false);
    expect(
      isGraphqlReadBody([{ query: "{ a }" }, { query: "mutation { b }" }]),
    ).toBe(false);
    expect(isGraphqlReadBody(JSON.stringify({ query: "{ a }" }))).toBe(true);
    expect(isGraphqlReadBody({})).toBe(false);
    expect(isGraphqlReadBody("not json")).toBe(false);
  });

  it("GraphQL: a mutation behind a \\r comment line or in a block string is a write", () => {
    expect(isGraphqlQuery("{ a } # note\rmutation { b }")).toBe(false);
    expect(
      isGraphqlQuery('{ a(text: """ x """) } """\nmutation { b }\n"""'),
    ).toBe(false);
    expect(isGraphqlQuery('{ a(doc: """mutation { b }""") }')).toBe(false);
  });

  it("GraphQL: fail closed, a query that only mentions mutation in a string is a write", () => {
    expect(isGraphqlQuery('{ search(text: "mutation") { id } }')).toBe(false);
    expect(isGraphqlQuery("{ subscriptions { id } }")).toBe(true);
  });
});

describe("GraphQL: only a query POSTed to the endpoint reads", () => {
  const graphql = { base_url: "https://x.example.com/graphql", graphql: true };
  const read = (input: Parameters<typeof resolveRequest>[2]) =>
    isReadRequest(
      type("custom_api"),
      resolveRequest(type("custom_api"), graphql, input),
      graphql,
    );

  it("reads a query POSTed to the endpoint, in one operation or a batch", () => {
    expect(
      read({
        method: "POST",
        path: "/",
        body: { query: "{ a }", variables: {}, operationName: null },
      }),
    ).toBe(true);
    expect(
      read({ method: "POST", path: "/", body: [{ query: "{ a }" }] }),
    ).toBe(true);
    expect(read({ method: "POST", path: "/", body: '{"query":"{ a }"}' })).toBe(
      true,
    );
  });

  it("a GET, HEAD or OPTIONS is a write, a query string mutation included", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(read({ method, path: "/" })).toBe(false);
    }
    expect(
      read({ method: "GET", path: "/", query: { query: "mutation { b }" } }),
    ).toBe(false);
  });

  it("an operation in the URL is a write, whatever the body", () => {
    const body = { query: "{ a }" };
    for (const name of ["query", "documentId", "doc_id", "id", "extensions"]) {
      expect(
        read({ method: "POST", path: "/", query: { [name]: "x" }, body }),
        name,
      ).toBe(false);
    }
    expect(
      read({ method: "POST", path: "/?query=mutation%20%7B%20b%20%7D", body }),
    ).toBe(false);
  });

  it("a query POSTed elsewhere than the endpoint is a write", () => {
    expect(
      read({
        method: "POST",
        path: "/repos/x",
        body: { query: "{a}", title: "x" },
      }),
    ).toBe(false);
    expect(
      read({ method: "POST", path: "/repos/x", body: { query: "{a}" } }),
    ).toBe(false);
  });

  it("an extra or duplicated field is a write", () => {
    expect(
      read({ method: "POST", path: "/", body: { query: "{a}", title: "x" } }),
    ).toBe(false);
    expect(
      read({
        method: "POST",
        path: "/",
        body: '{"query":"mutation { b }","query":"{ a }"}',
      }),
    ).toBe(false);
    expect(
      read({ method: "POST", path: "/", body: '{"\\u0071uery":"{ a }"}' }),
    ).toBe(false);
    expect(
      read({ method: "POST", path: "/", body: [{ query: "{a}" }, [1]] }),
    ).toBe(false);
  });
});

describe("no caller method override reaches the service", () => {
  it("a GET with an override goes out without it, and _method is dropped", async () => {
    const sent = answering(200, {});
    const request = resolveRequest(
      type("stripe"),
      { api_key: KEY },
      {
        method: "GET",
        path: "/v1/customers?_method=DELETE",
        query: { _METHOD: "DELETE", limit: 1 },
        headers: {
          "X-HTTP-Method-Override": "DELETE",
          "x-http-method": "DELETE",
          "x-method-override": "DELETE",
        },
      },
    );
    expect(isReadRequest(type("stripe"), request, {})).toBe(true);
    await forward(connection("stripe", { api_key: KEY }), type("stripe"), {
      method: "GET",
      path: "/v1/customers?_method=DELETE",
      headers: { "X-HTTP-Method-Override": "DELETE", "x-http-method": "PUT" },
    });
    expect(sent[0].url).toBe("https://api.stripe.com/v1/customers");
    expect(sent[0].headers["x-http-method-override"]).toBeUndefined();
    expect(sent[0].headers["x-http-method"]).toBeUndefined();
    expect(request.url.searchParams.toString()).toBe("limit=1");
  });

  it("Close: a POST told to act as GET reads and goes out with exactly GET", async () => {
    const sent = answering(200, {});
    const input = {
      method: "POST",
      path: "/lead/",
      headers: { "X-HTTP-Method-Override": "get" },
    };
    const request = resolveRequest(type("close"), { api_key: KEY }, input);
    expect(isReadRequest(type("close"), request, {})).toBe(true);
    await forward(connection("close", { api_key: KEY }), type("close"), input);
    expect(sent[0].headers["x-http-method-override"]).toBe("GET");
  });

  it("Close: an override other than GET is refused, and nothing is sent", async () => {
    const sent = answering(200, {});
    for (const value of ["DELETE", "PUT", "get, delete"]) {
      const input = {
        method: "POST",
        path: "/lead/lead_1/",
        headers: { "x-http-method-override": value },
      };
      expect(() =>
        resolveRequest(type("close"), { api_key: KEY }, input),
      ).toThrow(/may only be GET/);
      await expect(
        forward(connection("close", { api_key: KEY }), type("close"), input),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(sent).toHaveLength(0);
  });
});

describe("a request a profile reads goes out as JSON", () => {
  const graphql = {
    base_url: "https://x.example.com/graphql",
    graphql: true,
    token: KEY,
  };

  it("GraphQL: a caller's form content type is replaced, so variables cannot become form fields", async () => {
    const body = {
      query: "{ a }",
      variables: { x: "&query=mutation { drop }" },
    };
    const input = {
      method: "POST",
      path: "/",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    };
    const request = resolveRequest(type("custom_api"), graphql, input);
    expect(isReadRequest(type("custom_api"), request, graphql)).toBe(true);
    const sent = answering(200, {});
    await forward(connection("custom_api", graphql), type("custom_api"), input);
    expect(sent[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(sent[0].body ?? "")).toEqual(body);
  });

  it("GraphQL: a string body read goes out re-serialized as JSON", async () => {
    const sent = answering(200, {});
    await forward(connection("custom_api", graphql), type("custom_api"), {
      method: "POST",
      path: "/",
      headers: { "content-type": "text/plain" },
      body: '{"query":"{ a }"}',
    });
    expect(sent[0].headers["content-type"]).toBe("application/json");
    expect(sent[0].body).toBe('{"query":"{ a }"}');
  });

  it("Close: a search or a POST read as GET goes out as JSON; a string that is not JSON is refused", async () => {
    let sent = answering(200, {});
    await forward(connection("close", { api_key: KEY }), type("close"), {
      method: "POST",
      path: "/data/search/",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { query: { type: "and" } },
    });
    expect(sent[0].headers["content-type"]).toBe("application/json");
    sent = answering(200, {});
    await expect(
      forward(connection("close", { api_key: KEY }), type("close"), {
        method: "POST",
        path: "/lead/",
        headers: { "x-http-method-override": "GET" },
        body: "a=1&b=2",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(sent).toHaveLength(0);
  });

  it("a write keeps the caller's content type", async () => {
    const sent = answering(200, {});
    await forward(connection("close", { api_key: KEY }), type("close"), {
      method: "POST",
      path: "/task/",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    expect(sent[0].headers["content-type"]).toBe("text/plain");
  });

  it("OPTIONS goes out without a body", async () => {
    const sent = answering(200, {});
    await forward(
      connection("custom_api", {
        base_url: "https://x.example.com",
        token: KEY,
      }),
      type("custom_api"),
      { method: "OPTIONS", path: "/x", body: { a: 1 } },
    );
    expect(sent[0].body).toBeUndefined();
  });

  it("GraphQL: a persisted query is never a read", () => {
    expect(
      isGraphqlReadBody({
        query: "{ a }",
        extensions: { persistedQuery: { version: 1, sha256Hash: "abc" } },
      }),
    ).toBe(false);
    expect(
      isGraphqlReadBody([
        { query: "{ a }" },
        { query: "{ b }", extensions: { persistedQuery: {} } },
      ]),
    ).toBe(false);
    expect(isGraphqlReadBody({ query: "{ a }", extensions: "x" })).toBe(false);
    expect(isGraphqlReadBody({ query: "{ a }", extensions: {} })).toBe(true);
  });
});

describe("paths stay under the base URL", () => {
  const base = "https://api.example.com/v1";

  it("joins a path and a query", () => {
    expect(
      urlUnder(base, "/lead/", { limit: 2, tag: ["a", "b"] }).url.toString(),
    ).toBe("https://api.example.com/v1/lead/?limit=2&tag=a&tag=b");
    expect(urlUnder(base, "/lead/").path).toBe("/lead/");
    expect(urlUnder(base, "/")).toMatchObject({ path: "/" });
    expect(urlUnder(base, "/").url.toString()).toBe(
      "https://api.example.com/v1",
    );
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

  it("refuses a dot segment however it is encoded, keeps an encoded slash", () => {
    const tenant = "https://api.example.com/v1/tenant-a";
    for (const path of [
      "/..%2f..%2fadmin/users",
      "/..%5cadmin",
      "/%252e%252e/admin",
      "/a/%2e/b",
      "/%E0%A4%A",
    ]) {
      expect(() => urlUnder(tenant, path), path).toThrow(
        ConnectionRequestError,
      );
    }
    // Sent as given: the service reads the id's own `/`.
    expect(urlUnder(tenant, "/items/a%2Fb").url.toString()).toBe(
      "https://api.example.com/v1/tenant-a/items/a%2Fb",
    );
    expect(urlUnder(tenant, "/items/..a%2Fb..").path).toBe("/items/..a%2Fb..");
  });

  it("refuses a segment a server may read as a dot segment", () => {
    for (const path of [
      "/..;/admin",
      "/.;/x",
      "/..%3b/admin",
      "/..%3B/admin",
      "/..%00/admin",
      "/..%20/admin",
      "/..%09/admin",
      "/．．/admin",
      "/..。/admin",
      "/%E2%80%A4%E2%80%A4/admin",
      "/%EF%B9%92./admin",
      "/.../admin",
    ]) {
      expect(() => urlUnder(base, path), path).toThrow(ConnectionRequestError);
    }
    for (const path of [
      "/lead/lead_1;v=2/",
      "/files/a..b",
      "/files/.env",
      "/v1.2/items",
      "/items/x.json",
    ]) {
      expect(() => urlUnder(base, path), path).not.toThrow();
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

  it("Stripe: Bearer, a form body, the caller's idempotency header", async () => {
    const sent = answering(200, { id: "cus_1" });
    await forward(connection("stripe", { api_key: KEY }), type("stripe"), {
      method: "POST",
      path: "/v1/customers",
      body: { email: "a@b.c", metadata: { source: "mako" } },
      headers: { "Idempotency-Key": "run-1-step-2" },
    });
    expect(sent[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent[0].headers["idempotency-key"]).toBe("run-1-step-2");
    expect(sent[0].headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(sent[0].body).toBe("email=a%40b.c&metadata%5Bsource%5D=mako");
  });

  it("Stripe: the caller's Stripe-Account header goes out (Connect)", async () => {
    const sent = answering(200, {});
    await forward(connection("stripe", { api_key: KEY }), type("stripe"), {
      method: "GET",
      path: "/v1/customers",
      headers: { "Stripe-Account": "acct_123" },
    });
    expect(sent[0].headers["stripe-account"]).toBe("acct_123");
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

  it("forwards only allowlisted caller headers, plus the profile's", async () => {
    const asked = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": "k-1",
      "Stripe-Version": "2024-06-20",
      "X-Original-URL": "/admin",
      "X-Rewrite-URL": "/admin",
      "X-Forwarded-Host": "evil.example.com",
      "X-Forwarded-Prefix": "/admin",
      "X-Original-Method": "DELETE",
      "X-Foo": "bar",
    };
    let sent = answering(200, {});
    await forward(connection("stripe", { api_key: KEY }), type("stripe"), {
      method: "POST",
      path: "/v1/customers",
      headers: asked,
      body: "a=1",
    });
    const forwarded = Object.keys(sent[0].headers).sort();
    expect(forwarded).toEqual(
      [
        "accept",
        "authorization",
        "content-type",
        "idempotency-key",
        "stripe-version",
      ].sort(),
    );
    // A profile's extra is its own: not forwarded to another service.
    sent = answering(200, {});
    await forward(
      connection("custom_api", {
        base_url: "https://x.example.com",
        token: KEY,
      }),
      type("custom_api"),
      { method: "GET", path: "/", headers: asked },
    );
    expect(sent[0].headers["stripe-version"]).toBeUndefined();
    expect(sent[0].headers["x-original-url"]).toBeUndefined();
    expect(sent[0].headers.accept).toBe("application/json");
  });

  it("gives a string body the profile's content type unless the caller set one", async () => {
    let sent = answering(200, {});
    await forward(connection("stripe", { api_key: KEY }), type("stripe"), {
      method: "POST",
      path: "/v1/customers",
      body: "email=a%40b.c",
    });
    expect(sent[0].headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    sent = answering(200, {});
    const custom = connection("custom_api", {
      base_url: "https://x.example.com",
      token: KEY,
    });
    await forward(custom, type("custom_api"), {
      method: "POST",
      path: "/x",
      body: '{"a":1}',
    });
    expect(sent[0].headers["content-type"]).toBe("application/json");
    sent = answering(200, {});
    await forward(custom, type("custom_api"), {
      method: "POST",
      path: "/x",
      headers: { "Content-Type": "text/csv" },
      body: "a,b",
    });
    expect(sent[0].headers["content-type"]).toBe("text/csv");
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

  it("scrubs the exact basic-auth payload and header a Custom API sent", async () => {
    const payload = Buffer.from("user:pass").toString("base64");
    answering(200, { payload, header: `Basic ${payload}` });
    const result = await forward(
      connection("custom_api", {
        base_url: "https://probo.example.com",
        auth_type: "basic",
        username: "user",
        password: "pass",
      }),
      type("custom_api"),
      { method: "GET", path: "/" },
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain(payload);
    expect(result.body).toEqual({
      payload: "[redacted]",
      header: "[redacted]",
    });
  });

  it("keeps a plain basic-auth username in the answer when there is a password", async () => {
    const payload = Buffer.from("api:s3cret_pw").toString("base64");
    answering(200, { api_version: 1, echo: "s3cret_pw", payload });
    const result = await forward(
      connection("custom_api", {
        base_url: "https://x.example.com",
        auth_type: "basic",
        username: "api",
        password: "s3cret_pw",
      }),
      type("custom_api"),
      { method: "GET", path: "/" },
    );
    expect(result.body).toEqual({
      api_version: 1,
      echo: "[redacted]",
      payload: "[redacted]",
    });
  });

  it("scrubs a short key, and a key in escaped or encoded forms", async () => {
    answering(200, { echoed: "k3y9", again: "id k3y9" });
    let result = await forward(
      connection("custom_api", {
        base_url: "https://x.example.com",
        auth_type: "api_key_header",
        token: "k3y9",
      }),
      type("custom_api"),
      { method: "GET", path: "/" },
    );
    expect(JSON.stringify(result)).not.toContain("k3y9");

    const token = "ab/cd+ef/gh==";
    answering(
      200,
      `{"escaped":"${token.replace(/\//g, "\\/")}","lower":"${encodeURIComponent(token).toLowerCase()}"}`,
    );
    result = await forward(
      connection("custom_api", { base_url: "https://x.example.com", token }),
      type("custom_api"),
      { method: "GET", path: "/" },
    );
    expect(result.body).toEqual({
      escaped: "[redacted]",
      lower: "[redacted]",
    });
  });

  it("redacts a key the HTTP client quotes in its error", async () => {
    const token = "tok_9f2c4e7a\nx";
    setTransportForTests(async (_url, options) => {
      throw new TypeError(
        `Headers.append: "${options.headers.authorization}" is an invalid header value.`,
        { cause: new Error(`invalid value ${token}`) },
      );
    });
    const error = await forward(
      connection("custom_api", { base_url: "https://x.example.com", token }),
      type("custom_api"),
      { method: "GET", path: "/" },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const err = error as Error;
    expect(err.message).toContain("invalid header value");
    expect(err.message).not.toContain("tok_9f2c4e7a");
    expect(err.cause).toBeUndefined();
    expect(String(err.stack)).not.toContain("tok_9f2c4e7a");
  });

  it("drops a header echoing a Custom API's key", async () => {
    answering(200, "ok", { "content-type": "text/plain", "x-probo-key": KEY });
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
  });

  it("stores the basic-auth username as a secret, like the password", () => {
    const fields = CustomApiConnector.getConfigSchema().fields;
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
