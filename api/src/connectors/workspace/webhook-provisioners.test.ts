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
import { adoptCloseWebhook, setCloseWebhookPaused } from "../close/webhooks";
import { SandboxedConnector } from "./SandboxedConnector";
import {
  builtInProvisioningConfig,
  hasWebhookProvisioner,
  webhookProvisionerFor,
  webhookProvisionerTraits,
} from "./webhook-provisioners";

const URL_A = "https://api.example.test/api/webhooks/ws1/flowA";
const events = () => ["lead.created", "lead.updated"];

/** A Close API stand-in: records calls, serves one webhook list. */
function fakeClose(list: Array<Record<string, unknown>>, putError?: Error) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const api = {
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      if (path === "/webhook/") return { data: { data: list } };
      const found = list.find(w => path === `/webhook/${String(w.id)}/`);
      return { data: found ?? {} };
    },
    put: async (path: string, body?: unknown) => {
      calls.push(`PUT ${path}`);
      bodies.push(body);
      if (putError) throw putError;
      return { data: {} };
    },
    post: async (path: string) => {
      calls.push(`POST ${path}`);
      return { data: { id: "whsub_new", signature_key: "a".repeat(64) } };
    },
  };
  return { api: api as unknown as AxiosInstance, calls, bodies };
}

void test("pause sets only the Close webhooks on the flow's URL, and only when they are not paused yet", async () => {
  const { api, calls, bodies } = fakeClose([
    { id: "whsub_other", url: "https://elsewhere.test/hook", status: "active" },
    { id: "whsub_a", url: URL_A, status: "active" },
    { id: "whsub_dup", endpoint: URL_A, status: "active" },
    { id: "whsub_done", url: URL_A, status: "paused" },
  ]);
  const changed = await setCloseWebhookPaused(api, {
    endpointUrl: URL_A,
    // A stored id never widens the match beyond the URL.
    providerWebhookId: "whsub_other",
    paused: true,
  });
  assert.equal(changed, 2);
  assert.deepEqual(calls, [
    "GET /webhook/",
    "PUT /webhook/whsub_a/",
    "PUT /webhook/whsub_dup/",
  ]);
  assert.deepEqual(bodies, [{ status: "paused" }, { status: "paused" }]);
});

void test("resume reactivates a paused Close webhook and leaves an active one alone", async () => {
  const paused = fakeClose([{ id: "whsub_a", url: URL_A, status: "paused" }]);
  assert.equal(
    await setCloseWebhookPaused(paused.api, {
      endpointUrl: URL_A,
      paused: false,
    }),
    1,
  );
  assert.deepEqual(paused.bodies, [{ status: "active" }]);

  const active = fakeClose([{ id: "whsub_a", url: URL_A, status: "active" }]);
  assert.equal(
    await setCloseWebhookPaused(active.api, {
      endpointUrl: URL_A,
      paused: false,
    }),
    0,
  );
  assert.deepEqual(active.calls, ["GET /webhook/"]);
});

void test("pause fails, with the reason, when Close refuses the status change", async () => {
  const { api } = fakeClose(
    [{ id: "whsub_a", url: URL_A, status: "active" }],
    new Error("403 forbidden"),
  );
  await assert.rejects(
    () => setCloseWebhookPaused(api, { endpointUrl: URL_A, paused: true }),
    /whsub_a to paused: 403 forbidden/,
  );
});

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

void test("only Close and Stripe have a provisioner, and each needs a key", async () => {
  assert.equal(hasWebhookProvisioner("close"), true);
  assert.equal(hasWebhookProvisioner("stripe"), true);
  await assert.rejects(() => webhookProvisionerFor("stripe", {}), /API key/);
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

void test("PandaDoc and Claap folders provision as their built-ins do, create only", () => {
  process.env.CONNECTOR_WEBHOOK_BATCHES = "true";
  const pandadoc = new SpecConnector("ws:pandadoc", VERIFYING_SPEC);
  const claap = new SpecConnector("ws:claap", VERIFYING_SPEC);
  const close = new SpecConnector("ws:close", VERIFYING_SPEC);
  assert.equal(pandadoc.supportsWebhookProvisioning(), true);
  assert.equal(claap.supportsWebhookProvisioning(), true);
  // The built-ins have no in-place update; Close's adopt stays.
  assert.equal(pandadoc.supportsWebhookSubscriptionUpdate(), false);
  assert.equal(claap.supportsWebhookSubscriptionUpdate(), false);
  assert.equal(close.supportsWebhookSubscriptionUpdate(), true);
  // PandaDoc returns its shared key; Claap may not show its secret.
  const pd = pandadoc.getWebhookCapabilities();
  const cl = claap.getWebhookCapabilities();
  assert.equal(pd.provisioning.storesSecretAutomatically, true);
  assert.equal(cl.provisioning.storesSecretAutomatically, false);
  assert.match(String(cl.secretHelpText), /X-Claap-Webhook-Secret/);
  assert.match(String(pd.secretHelpText), /Shared Key/);
});

void test("a shared-secret folder names its secret header for redaction", () => {
  const claap = new SpecConnector("ws:claap", {
    mako: {
      webhooks: {
        verification: {
          scheme: "shared-secret",
          secretHeader: "x-claap-webhook-secret",
        },
      },
    },
  });
  assert.deepEqual(claap.webhookSecretHeaders(), ["x-claap-webhook-secret"]);
  const close = new SpecConnector("ws:close", VERIFYING_SPEC);
  assert.deepEqual(close.webhookSecretHeaders(), []);
});

void test("Wise and Calendly provision as their built-ins: Wise updates and deletes, Calendly only creates", async () => {
  process.env.CONNECTOR_WEBHOOK_BATCHES = "true";
  await assert.rejects(
    () => webhookProvisionerFor("wise", {}),
    /Wise API token/,
  );
  await assert.rejects(
    () => webhookProvisionerFor("calendly", { api_key: "k" }),
    /Calendly access token/,
  );
  assert.equal(webhookProvisionerTraits("wise")?.canUpdate, true);
  assert.equal(webhookProvisionerTraits("wise")?.canDelete, true);
  assert.match(String(webhookProvisionerTraits("wise")?.secretHelpText), /RSA/);
  assert.equal(webhookProvisionerTraits("calendly")?.canUpdate, false);
  assert.equal(webhookProvisionerTraits("calendly")?.canDelete, undefined);
  const wise = new SpecConnector("ws:wise", VERIFYING_SPEC);
  assert.equal(wise.supportsWebhookSubscriptionUpdate(), true);
  assert.equal(wise.supportsWebhookSubscriptionDelete(), true);
  const calendly = new SpecConnector("ws:calendly", VERIFYING_SPEC);
  assert.equal(calendly.supportsWebhookProvisioning(), true);
  assert.equal(calendly.supportsWebhookSubscriptionUpdate(), false);
  assert.equal(calendly.supportsWebhookSubscriptionDelete(), false);
  assert.equal(
    new SpecConnector(
      "ws:close",
      VERIFYING_SPEC,
    ).supportsWebhookSubscriptionDelete(),
    false,
  );
});

void test("the provisioned built-ins take the credential, and only Wise's own hosts as base URL", () => {
  const evil = { api_base_url: "https://attacker.example" };
  assert.deepEqual(
    builtInProvisioningConfig("wise", {
      ...evil,
      api_key: "k",
      profile_id: "9",
      sca_private_key: "x",
    }),
    { api_key: "k", profile_id: "9" },
  );
  assert.deepEqual(
    builtInProvisioningConfig("calendly", { ...evil, access_token: "t" }),
    { access_token: "t" },
  );
  // A sandbox connection provisions in Wise's sandbox, as in-process.
  assert.deepEqual(
    builtInProvisioningConfig("wise", {
      api_key: "k",
      api_base_url: "https://api.sandbox.transferwise.tech/",
    }),
    { api_key: "k", api_base_url: "https://api.sandbox.transferwise.tech" },
  );
  for (const url of [
    "http://api.sandbox.transferwise.tech",
    "https://api.wise.com.attacker.example",
    "https://user:pw@api.wise.com",
    "https://api.wise.com:8443",
    "http://127.0.0.1:9000",
  ]) {
    assert.equal(
      builtInProvisioningConfig("wise", { api_key: "k", api_base_url: url })
        .api_base_url,
      undefined,
      url,
    );
  }
});
