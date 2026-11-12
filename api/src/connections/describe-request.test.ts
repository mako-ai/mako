/**
 * A write an agent's run records instead of sending (describeRequest): the
 * whole request as it would go on the wire, URL, headers and body, with
 * every credential value redacted wherever it would travel. Nothing is sent:
 * the transport fails the test if asked, and a Google credential is never
 * minted.
 */
import { afterEach, describe, expect, it } from "vitest";
import { callableFor, type CallableConnection } from "./callable";
import {
  describeRequest,
  resolveRequest,
  setTransportForTests,
  type ForwardInput,
} from "./forward";

const KEY = "xoxb_live_4f9a2c7e1b3d";

function type(name: string): CallableConnection {
  const found = callableFor(name);
  if (!found) throw new Error(`no call profile for ${name}`);
  return found;
}

function describeFor(
  kind: string,
  config: Record<string, unknown>,
  input: ForwardInput,
) {
  const callable = type(kind);
  setTransportForTests(async () => {
    throw new Error("describeRequest must not send");
  });
  return describeRequest(
    { config },
    callable,
    resolveRequest(callable, config, input),
  );
}

afterEach(() => setTransportForTests(null));

describe("describeRequest", () => {
  it("shows a Slack-style JSON post whole, the bearer token redacted", () => {
    const recorded = describeFor(
      "custom_api",
      { base_url: "https://slack.com/api", auth_type: "bearer", token: KEY },
      {
        method: "post",
        path: "/chat.postMessage",
        headers: { "Idempotency-Key": "digest-1", "X-Drop-Me": "x" },
        body: { channel: "C123", text: "Weekly digest" },
      },
    );
    expect(recorded).toEqual({
      method: "POST",
      url: "https://slack.com/api/chat.postMessage",
      headers: {
        "idempotency-key": "digest-1",
        "content-type": "application/json",
        authorization: "Bearer [redacted]",
      },
      body: { channel: "C123", text: "Weekly digest" },
    });
    expect(JSON.stringify(recorded)).not.toContain(KEY);
  });

  it("redacts a key sent in the query string, and one the body repeats", () => {
    const recorded = describeFor(
      "custom_api",
      {
        base_url: "https://api.sendgrid.example/v3",
        auth_type: "api_key_query",
        token: KEY,
        query_param: "key",
      },
      {
        method: "POST",
        path: "/mail/send",
        query: { sandbox: true },
        body: { to: "a@example.com", note: `key ${KEY}` },
      },
    );
    expect(recorded.url).toBe(
      "https://api.sendgrid.example/v3/mail/send?sandbox=true&key=%5Bredacted%5D",
    );
    expect(recorded.body).toEqual({
      to: "a@example.com",
      note: "key [redacted]",
    });
    expect(JSON.stringify(recorded)).not.toContain(KEY);
  });

  it("keeps a header-sent key's header, value redacted", () => {
    const recorded = describeFor(
      "custom_api",
      {
        base_url: "https://hooks.example.com",
        auth_type: "api_key_header",
        token: KEY,
        header_name: "X-Api-Key",
      },
      { method: "DELETE", path: "/hooks/1" },
    );
    expect(recorded).toEqual({
      method: "DELETE",
      url: "https://hooks.example.com/hooks/1",
      headers: { "x-api-key": "[redacted]" },
    });
  });

  it("shows a form body as the text sent (Stripe)", () => {
    const recorded = describeFor(
      "stripe",
      { api_key: KEY },
      {
        method: "POST",
        path: "/v1/customers",
        body: { email: "a@example.com", metadata: { id: "7" } },
      },
    );
    expect(recorded.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(recorded.body).toBe("email=a%40example.com&metadata%5Bid%5D=7");
    expect(recorded.headers.authorization).toBe("Bearer [redacted]");
  });

  it("redacts basic auth, the encoded pair included (Close)", () => {
    const recorded = describeFor(
      "close",
      { api_key: KEY },
      { method: "POST", path: "/task/", body: { text: "Call back" } },
    );
    expect(recorded.headers.authorization).toBe("Basic [redacted]");
    expect(JSON.stringify(recorded)).not.toContain(KEY);
    expect(JSON.stringify(recorded)).not.toContain(
      Buffer.from(`${KEY}:`).toString("base64"),
    );
  });

  it("does not mint a Google token: a redacted bearer stands in", () => {
    const recorded = describeFor(
      "custom_api",
      {
        base_url: "https://sheets.googleapis.com/v4",
        auth_type: "google_service_account",
        service_account_json: JSON.stringify({
          client_email: "bot@p.iam.gserviceaccount.com",
          private_key:
            "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
        }),
      },
      { method: "POST", path: "/spreadsheets", body: { title: "t" } },
    );
    expect(recorded.headers.authorization).toBe("Bearer [redacted]");
    expect(recorded.body).toEqual({ title: "t" });
  });
});
