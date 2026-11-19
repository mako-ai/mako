/**
 * Wise webhook provisioning: profile subscriptions are created, retargeted
 * and removed with the connection's token, in the API process.
 * Run: node --import tsx src/webhook-provisioning/wise.test.ts
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import axios from "axios";
import { createWiseProvisioning } from "./wise";

/** The provisioning calls under the names the built-in connector gave them. */
function createConnector(config: Record<string, unknown> = {}) {
  const holder: { wiseApi?: any } = {};
  const provisioning = createWiseProvisioning(
    { api_key: "test-token", ...config },
    { api: () => holder.wiseApi },
  );
  return Object.assign(holder, {
    createWebhookSubscription: provisioning.create,
    updateWebhookSubscription: provisioning.update,
    deleteWebhookSubscription: provisioning.delete,
  });
}

const ENDPOINT = "https://mako.example/api/webhooks/ws1/flow1";

type FakeSubscription = {
  id: string;
  name: string;
  trigger_on: string;
  delivery: { version: string; url: string };
};

/**
 * In-memory Wise: `/v2/profiles` plus the profile subscription endpoints.
 * `refuse` makes every subscription call answer with that HTTP status.
 */
function subscriptionApi(
  profiles: Record<string, FakeSubscription[]>,
  options: { refuse?: number; scaChallenge?: boolean } = {},
) {
  const calls: Array<{
    method: string;
    path: string;
    body?: any;
    headers?: Record<string, string>;
  }> = [];
  let nextId = 1;
  const refuse = (headers?: Record<string, string>) => {
    if (options.scaChallenge && !headers?.["X-Signature"]) {
      const error = new axios.AxiosError("Forbidden", "403");
      error.response = {
        status: 403,
        headers: { "x-2fa-approval": "ott" },
        data: {},
      } as any;
      throw error;
    }
    if (options.refuse) {
      const error = new axios.AxiosError("Forbidden", String(options.refuse));
      error.response = {
        status: options.refuse,
        headers: {},
        data: { error: "access_denied", error_description: "Access denied" },
      } as any;
      throw error;
    }
  };
  const profileOf = (path: string) =>
    path.match(/\/v3\/profiles\/(\d+)\/subscriptions/)?.[1] ?? "";
  const api = {
    get: async (
      path: string,
      config?: { headers?: Record<string, string> },
    ) => {
      calls.push({ method: "get", path, headers: config?.headers });
      if (path === "/v2/profiles") {
        return { data: Object.keys(profiles).map(id => ({ id: Number(id) })) };
      }
      refuse(config?.headers);
      return { data: [...(profiles[profileOf(path)] ?? [])] };
    },
    post: async (
      path: string,
      body: any,
      config?: { headers?: Record<string, string> },
    ) => {
      calls.push({ method: "post", path, body, headers: config?.headers });
      refuse(config?.headers);
      const created = { id: `sub-${nextId++}`, ...body };
      profiles[profileOf(path)].push(created);
      return { data: created };
    },
    delete: async (
      path: string,
      config?: { headers?: Record<string, string> },
    ) => {
      calls.push({ method: "delete", path, headers: config?.headers });
      refuse(config?.headers);
      const profile = profileOf(path);
      const id = path.split("/").pop();
      profiles[profile] = profiles[profile].filter(s => s.id !== id);
      return { data: undefined, status: 204 };
    },
  };
  return { api, calls };
}

async function testProvisionSubscribesBalanceUpdatesOnEveryProfile() {
  const connector = createConnector();
  const profiles: Record<string, FakeSubscription[]> = { "10": [], "20": [] };
  const { api, calls } = subscriptionApi(profiles);
  (connector as any).wiseApi = api;

  const result = await connector.createWebhookSubscription({
    endpointUrl: ENDPOINT,
    enabledEntities: ["balance_updates"],
  });

  const posts = calls.filter(c => c.method === "post");
  assert.deepEqual(
    posts.map(c => c.path),
    ["/v3/profiles/10/subscriptions", "/v3/profiles/20/subscriptions"],
  );
  assert.deepEqual(posts[0].body, {
    name: "Mako balances#update",
    trigger_on: "balances#update",
    delivery: { version: "4.0.0", url: ENDPOINT },
  });
  assert.equal(result.providerWebhookId, "10:sub-1,20:sub-2");
  assert.equal(result.endpointUrl, ENDPOINT);
  // The flow's "secret" names the Wise key set that verifies deliveries.
  assert.equal(result.signingSecret, "production");
}

async function testProvisionIsIdempotentAndLeavesOtherUrlsAlone() {
  const connector = createConnector({ profile_id: "10" });
  const foreign: FakeSubscription = {
    id: "theirs",
    name: "Accounting",
    trigger_on: "balances#update",
    delivery: { version: "2.0.0", url: "https://accounting.example/hook" },
  };
  const existing: FakeSubscription = {
    id: "ours",
    name: "Manual",
    trigger_on: "balances#update",
    delivery: { version: "2.0.0", url: ENDPOINT },
  };
  const profiles = { "10": [foreign, existing] };
  const { api, calls } = subscriptionApi(profiles);
  (connector as any).wiseApi = api;

  const result = await connector.createWebhookSubscription({
    endpointUrl: ENDPOINT,
    enabledEntities: ["balance_updates"],
  });

  assert.equal(calls.filter(c => c.method === "post").length, 0);
  assert.equal(calls.filter(c => c.method === "delete").length, 0);
  // `profile_id` restricts to that profile: /v2/profiles is never listed.
  assert.ok(!calls.some(c => c.path === "/v2/profiles"));
  assert.equal(result.providerWebhookId, "10:ours");
  assert.deepEqual(
    profiles["10"].map(s => s.id),
    ["theirs", "ours"],
  );
}

async function testUpdateRetargetsEventsAndDropsDuplicates() {
  const connector = createConnector({ profile_id: "10" });
  const sub = (id: string, trigger_on: string): FakeSubscription => ({
    id,
    name: `Mako ${trigger_on}`,
    trigger_on,
    delivery: { version: "4.0.0", url: ENDPOINT },
  });
  const profiles = {
    "10": [
      sub("a", "balances#update"),
      sub("b", "balances#update"),
      sub("c", "recipients#state-change"),
    ],
  };
  const { api } = subscriptionApi(profiles);
  (connector as any).wiseApi = api;

  const result = await connector.updateWebhookSubscription({
    endpointUrl: ENDPOINT,
    enabledEntities: ["balance_updates", "transfers"],
  });

  const triggers = profiles["10"].map(s => s.trigger_on).sort();
  assert.deepEqual(triggers, [
    "balances#update",
    "transfers#active-cases",
    "transfers#payout-failure",
    "transfers#refund",
    "transfers#state-change",
  ]);
  assert.ok(
    profiles["10"].some(s => s.id === "a"),
    "keeps the first match",
  );
  const payoutFailure = profiles["10"].find(
    s => s.trigger_on === "transfers#payout-failure",
  );
  assert.equal(payoutFailure?.delivery.version, "5.0.0");
  // Adopted or new, the stored "secret" is the key set that verifies deliveries.
  assert.equal(result?.signingSecret, "production");
  assert.equal(result?.providerWebhookId.split(",").length, 5);
}

async function testUpdateWithoutSubscriptionsResolvesNull() {
  const connector = createConnector({ profile_id: "10" });
  const profiles = { "10": [] as FakeSubscription[] };
  const { api, calls } = subscriptionApi(profiles);
  (connector as any).wiseApi = api;

  const result = await connector.updateWebhookSubscription({
    endpointUrl: ENDPOINT,
    enabledEntities: ["balance_updates"],
  });
  assert.equal(result, null);
  assert.equal(calls.filter(c => c.method === "post").length, 0);
}

async function testProvisionRejectsApplicationOnlyEvents() {
  const connector = createConnector({ profile_id: "10" });
  const { api, calls } = subscriptionApi({ "10": [] });
  (connector as any).wiseApi = api;

  await assert.rejects(
    connector.createWebhookSubscription({
      endpointUrl: ENDPOINT,
      enabledEntities: ["profiles", "balances"],
    }),
    /application-level subscriptions only/,
  );
  assert.equal(calls.length, 0);
}

async function testProvisionSkipsApplicationOnlyEventsAlongsideOthers() {
  const connector = createConnector({ profile_id: "10" });
  const profiles = { "10": [] as FakeSubscription[] };
  const { api } = subscriptionApi(profiles);
  (connector as any).wiseApi = api;

  await connector.createWebhookSubscription({
    endpointUrl: ENDPOINT,
    enabledEntities: ["balances", "balance_updates"],
  });
  assert.deepEqual(
    profiles["10"].map(s => s.trigger_on),
    ["balances#update"],
  );
}

async function testProvisionRefusalExplainsTokenType() {
  const connector = createConnector({ profile_id: "10" });
  const { api } = subscriptionApi({ "10": [] }, { refuse: 403 });
  (connector as any).wiseApi = api;

  await assert.rejects(
    connector.createWebhookSubscription({
      endpointUrl: ENDPOINT,
      enabledEntities: ["balance_updates"],
    }),
    (error: Error) => {
      assert.match(error.message, /refused to list webhook subscriptions/);
      assert.match(error.message, /profile 10/);
      assert.match(error.message, /full access/);
      assert.match(error.message, /limited/);
      assert.ok(error.message.includes(ENDPOINT));
      assert.ok(error.message.includes("balances#update"));
      assert.match(error.message, /"production"/);
      return true;
    },
  );
}

async function testProvisionAnswersScaChallenge() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const connector = createConnector({ profile_id: "10", sca_private_key: pem });
  const profiles = { "10": [] as FakeSubscription[] };
  const { api, calls } = subscriptionApi(profiles, { scaChallenge: true });
  (connector as any).wiseApi = api;

  await connector.createWebhookSubscription({
    endpointUrl: ENDPOINT,
    enabledEntities: ["balance_updates"],
  });

  const signedPost = calls.find(
    c => c.method === "post" && c.headers?.["X-Signature"],
  );
  assert.ok(signedPost, "expected a signed create");
  assert.equal(signedPost?.headers?.["x-2fa-approval"], "ott");
  assert.equal(profiles["10"].length, 1);
}

async function testSandboxProvisionNamesSandboxKeys() {
  const connector = createConnector({
    profile_id: "10",
    api_base_url: "https://api.sandbox.transferwise.tech",
  });
  const { api } = subscriptionApi({ "10": [] });
  (connector as any).wiseApi = api;

  const result = await connector.createWebhookSubscription({
    endpointUrl: ENDPOINT,
    enabledEntities: ["balance_updates"],
  });
  assert.equal(result.signingSecret, "sandbox");
}

async function testDeleteRemovesOnlyThisFlowsSubscriptions() {
  const connector = createConnector();
  const profiles: Record<string, FakeSubscription[]> = {
    "10": [
      {
        id: "x",
        name: "Mako balances#update",
        trigger_on: "balances#update",
        delivery: { version: "4.0.0", url: ENDPOINT },
      },
      {
        id: "keep",
        name: "Other",
        trigger_on: "balances#update",
        delivery: { version: "4.0.0", url: "https://other.example/hook" },
      },
    ],
    "20": [
      {
        id: "y",
        name: "Mako transfers#state-change",
        trigger_on: "transfers#state-change",
        delivery: { version: "4.0.0", url: ENDPOINT },
      },
    ],
  };
  const { api } = subscriptionApi(profiles);
  (connector as any).wiseApi = api;

  const removed = await connector.deleteWebhookSubscription({
    endpointUrl: ENDPOINT,
  });
  assert.equal(removed, 2);
  assert.deepEqual(
    profiles["10"].map(s => s.id),
    ["keep"],
  );
  assert.deepEqual(profiles["20"], []);
}

async function main() {
  await testProvisionSubscribesBalanceUpdatesOnEveryProfile();
  await testProvisionIsIdempotentAndLeavesOtherUrlsAlone();
  await testUpdateRetargetsEventsAndDropsDuplicates();
  await testUpdateWithoutSubscriptionsResolvesNull();
  await testProvisionRejectsApplicationOnlyEvents();
  await testProvisionSkipsApplicationOnlyEventsAlongsideOthers();
  await testProvisionRefusalExplainsTokenType();
  await testProvisionAnswersScaChallenge();
  await testSandboxProvisionNamesSandboxKeys();
  await testDeleteRemovesOnlyThisFlowsSubscriptions();
}

main().catch((error: unknown) => {
  throw error;
});
