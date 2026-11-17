/**
 * Webhook provisioning for boxed connectors: the API makes the vendor
 * subscription with the connection's key, and the signing key comes back
 * to the caller (the flow), never to a box.
 *
 * Run: node --import tsx src/connectors/workspace/webhook-provisioners.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AxiosInstance } from "axios";
import { adoptCloseWebhook } from "../close/webhooks";
import { SandboxedConnector } from "./SandboxedConnector";
import {
  hasWebhookProvisioner,
  webhookProvisionerFor,
} from "./webhook-provisioners";

const URL_A = "https://api.example.test/api/webhooks/ws1/flowA";
const events = () => ["lead.created", "lead.updated"];

/** A Close API stand-in: records calls, serves one webhook list. */
function fakeClose(list: Array<Record<string, unknown>>, putError?: Error) {
  const calls: string[] = [];
  const api = {
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      if (path === "/webhook/") return { data: { data: list } };
      const found = list.find(w => path === `/webhook/${String(w.id)}/`);
      return { data: found ?? {} };
    },
    put: async (path: string) => {
      calls.push(`PUT ${path}`);
      if (putError) throw putError;
      return { data: {} };
    },
    post: async (path: string) => {
      calls.push(`POST ${path}`);
      return { data: { id: "whsub_new", signature_key: "a".repeat(64) } };
    },
  };
  return { api: api as unknown as AxiosInstance, calls };
}

void test("adopt returns null when no Close webhook targets the URL", async () => {
  const { api, calls } = fakeClose([
    { id: "whsub_other", url: "https://elsewhere.test/hook" },
  ]);
  const result = await adoptCloseWebhook(api, { endpointUrl: URL_A }, events);
  assert.equal(result, null);
  assert.deepEqual(calls, ["GET /webhook/"]);
});

void test("adopt sets the events of the webhook on the URL and returns its key", async () => {
  const key = "b".repeat(64);
  const { api, calls } = fakeClose([
    { id: "whsub_a", url: URL_A, signature_key: key },
  ]);
  const result = await adoptCloseWebhook(api, { endpointUrl: URL_A }, events);
  assert.equal(result?.providerWebhookId, "whsub_a");
  assert.equal(result?.signingSecret, key);
  assert.ok(calls.includes("PUT /webhook/whsub_a/"));
  assert.ok(!calls.some(c => c.startsWith("POST")), "never creates");
});

void test("adopt also matches a webhook listed with `endpoint` instead of `url`", async () => {
  const key = "c".repeat(64);
  const { api, calls } = fakeClose([
    { id: "whsub_e", endpoint: URL_A, signature_key: key },
  ]);
  const result = await adoptCloseWebhook(api, { endpointUrl: URL_A }, events);
  assert.equal(result?.providerWebhookId, "whsub_e");
  assert.equal(result?.signingSecret, key);
  assert.ok(!calls.some(c => c.startsWith("POST")), "never creates");
});

void test("adopt fails, with the reason, when Close refuses the event update", async () => {
  const { api, calls } = fakeClose(
    [{ id: "whsub_a", url: URL_A, signature_key: "d".repeat(64) }],
    new Error("HTTP 429: rate limited"),
  );
  await assert.rejects(
    () => adoptCloseWebhook(api, { endpointUrl: URL_A }, events),
    /Failed to update the events of Close webhook whsub_a: .*429/,
  );
  assert.ok(calls.includes("PUT /webhook/whsub_a/"));
  assert.ok(!calls.some(c => c.startsWith("POST")), "never creates");
});

void test("adopt reads the key from the webhook when the list leaves it out", async () => {
  const key = "e".repeat(64);
  const { api, calls } = fakeClose([{ id: "whsub_k", url: URL_A }]);
  (api as any).get = async (path: string) => {
    calls.push(`GET ${path}`);
    return path === "/webhook/"
      ? { data: { data: [{ id: "whsub_k", url: URL_A }] } }
      : { data: { id: "whsub_k", signature_key: key } };
  };
  const result = await adoptCloseWebhook(api, { endpointUrl: URL_A }, events);
  assert.equal(result?.signingSecret, key);
  assert.ok(calls.includes("GET /webhook/whsub_k/"));
});

void test("only Close has a provisioner, and it needs a key", async () => {
  assert.equal(hasWebhookProvisioner("close"), true);
  assert.equal(hasWebhookProvisioner("acme"), false);
  assert.equal(hasWebhookProvisioner("__proto__"), false);
  assert.equal(hasWebhookProvisioner("constructor"), false);
  await assert.rejects(() => webhookProvisionerFor("close", {}), /API key/);
  await assert.rejects(() => webhookProvisionerFor("acme", { api_key: "k" }));
});

/** A boxed connector whose indexed spec is given, without any box. */
class SpecConnector extends SandboxedConnector {
  constructor(type: string, spec: Record<string, unknown>) {
    super({
      _id: "665f00000000000000000001",
      workspaceId: "ws1",
      name: "PL Close shadow",
      type,
      config: { api_key: "k" },
    } as never);
    this.loaded = {
      slug: type.slice(3),
      sha: "sha",
      sourceSha: "sha",
      entry: "connector.ts",
      entities: [],
      spec,
    } as never;
  }
}

const VERIFYING_SPEC = {
  mako: {
    webhooks: {
      verification: {
        scheme: "hmac-sha256",
        secretEncoding: "hex",
        signedPayload: ["header:close-sig-timestamp", "body"],
        signatureHeader: "close-sig-hash",
        signatureEncoding: "hex",
        timestampHeader: "close-sig-timestamp",
        toleranceSeconds: 300,
      },
    },
  },
};

const before = process.env.CONNECTOR_WEBHOOK_BATCHES;
afterEach(() => {
  if (before === undefined) delete process.env.CONNECTOR_WEBHOOK_BATCHES;
  else process.env.CONNECTOR_WEBHOOK_BATCHES = before;
});

void test("flag off: a boxed Close folder offers no provisioning", () => {
  delete process.env.CONNECTOR_WEBHOOK_BATCHES;
  const connector = new SpecConnector("ws:close", VERIFYING_SPEC);
  assert.equal(connector.supportsWebhookProvisioning(), false);
  assert.equal(connector.supportsWebhookSubscriptionUpdate(), false);
  assert.equal(
    connector.getWebhookCapabilities().provisioning.supported,
    false,
  );
});

void test("flag on: a boxed Close folder provisions; another folder does not", () => {
  process.env.CONNECTOR_WEBHOOK_BATCHES = "true";
  const close = new SpecConnector("ws:close", VERIFYING_SPEC);
  assert.equal(close.supportsWebhookProvisioning(), true);
  assert.equal(close.supportsWebhookSubscriptionUpdate(), true);
  assert.equal(
    close.getWebhookCapabilities().provisioning.storesSecretAutomatically,
    true,
  );
  const acme = new SpecConnector("ws:acme", VERIFYING_SPEC);
  assert.equal(acme.supportsWebhookProvisioning(), false);
});

void test("a folder that declares no verification is refused before any call", async () => {
  process.env.CONNECTOR_WEBHOOK_BATCHES = "true";
  const connector = new SpecConnector("ws:close", { mako: {} });
  await assert.rejects(
    () => connector.createWebhookSubscription({ endpointUrl: URL_A }),
    /declares no webhook verification/,
  );
  await assert.rejects(
    () => connector.updateWebhookSubscription({ endpointUrl: URL_A }),
    /declares no webhook verification/,
  );
});
