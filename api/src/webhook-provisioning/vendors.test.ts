/**
 * PandaDoc, Claap and Calendly webhook provisioning: the request each vendor
 * gets and the signing secret that comes back, in the API process.
 * Run: node --import tsx src/webhook-provisioning/vendors.test.ts
 */
import assert from "node:assert/strict";
import type { AxiosInstance } from "axios";
import {
  calendlyWebhookEventsForEntities,
  provisionCalendlyWebhook,
} from "./calendly";
import { claapWebhookEventsForEntities, provisionClaapWebhook } from "./claap";
import {
  createPandaDocWebhookSubscription,
  pandaDocWebhookEventsForEntities,
} from "./pandadoc";

const endpointUrl = "https://app.mako.ai/api/webhooks/ws/flow";
const execute = <T>(fn: () => Promise<T>) => fn();

async function testPandaDocCreatesWithDocumentTriggers() {
  const posts: Array<{ path: string; body: any }> = [];
  const api = {
    post: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { data: { uuid: "pd_1", shared_key: "shared" } };
    },
  } as unknown as AxiosInstance;

  const result = await createPandaDocWebhookSubscription(
    { api: () => api, execute },
    { endpointUrl, enabledEntities: ["templates"] },
  );

  assert.equal(posts[0].path, "/public/v1/webhook-subscriptions");
  assert.equal(posts[0].body.name, "Mako");
  assert.equal(posts[0].body.url, endpointUrl);
  assert.deepEqual(posts[0].body.payload, [
    "fields",
    "products",
    "tokens",
    "metadata",
    "pricing",
  ]);
  assert.deepEqual(posts[0].body.triggers, [
    "template_created",
    "template_updated",
    "template_deleted",
  ]);
  assert.deepEqual(result, {
    providerWebhookId: "pd_1",
    endpointUrl,
    signingSecret: "shared",
  });
  assert.equal(pandaDocWebhookEventsForEntities([]).length, 11);
  await assert.rejects(
    createPandaDocWebhookSubscription(
      { api: () => api, execute },
      { endpointUrl, events: ["nope"] },
    ),
    /No valid PandaDoc webhook events/,
  );
}

async function testClaapAdoptsTheWebhookOnTheUrl() {
  const calls: string[] = [];
  const api = {
    get: async () => {
      calls.push("GET /v1/webhooks");
      return {
        data: {
          result: [{ id: "cw_1", url: endpointUrl, secret: "claap-secret" }],
        },
      };
    },
    put: async (path: string, body: any) => {
      calls.push(`PUT ${path}`);
      assert.deepEqual(body, {
        url: endpointUrl,
        events: ["recording_added", "recording_updated"],
      });
      return { data: {} };
    },
  } as unknown as AxiosInstance;

  const result = await provisionClaapWebhook(
    { api: () => api, execute },
    { endpointUrl, enabledEntities: ["recording_transcripts"] },
    claapWebhookEventsForEntities,
  );

  assert.deepEqual(calls, ["GET /v1/webhooks", "PUT /v1/webhooks/cw_1"]);
  assert.deepEqual(result, {
    providerWebhookId: "cw_1",
    endpointUrl,
    signingSecret: "claap-secret",
  });
  assert.deepEqual(claapWebhookEventsForEntities(["workspace"]), []);
}

async function testClaapCreatesWhenNoneIsOnTheUrl() {
  const api = {
    get: async () => ({ data: { result: [] } }),
    post: async (path: string) => {
      assert.equal(path, "/v1/webhooks");
      return { data: { result: { id: "cw_2" } } };
    },
  } as unknown as AxiosInstance;
  const result = await provisionClaapWebhook(
    { api: () => api, execute },
    { endpointUrl },
    claapWebhookEventsForEntities,
  );
  assert.equal(result.providerWebhookId, "cw_2");
  assert.equal(result.signingSecret, undefined);
}

async function testCalendlyCreatesAnOrganizationSubscription() {
  const posts: Array<{ path: string; body: any }> = [];
  const api = {
    post: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return {
        data: {
          resource: {
            uri: "https://api.calendly.com/webhook_subscriptions/abc",
            signing_key: "sig",
          },
        },
      };
    },
  } as unknown as AxiosInstance;

  const result = await provisionCalendlyWebhook(
    {
      api: () => api,
      execute,
      currentUser: async () => ({
        user_uri: "u",
        organization_uri: "https://api.calendly.com/organizations/o1",
      }),
    },
    { endpointUrl, enabledEntities: ["event_types"] },
    calendlyWebhookEventsForEntities,
  );

  assert.equal(posts[0].path, "/webhook_subscriptions");
  assert.deepEqual(posts[0].body, {
    url: endpointUrl,
    events: ["event_type.created", "event_type.updated"],
    organization: "https://api.calendly.com/organizations/o1",
    scope: "organization",
  });
  assert.deepEqual(result, {
    providerWebhookId: "abc",
    endpointUrl,
    signingSecret: "sig",
  });
}

async function main() {
  await testPandaDocCreatesWithDocumentTriggers();
  await testClaapAdoptsTheWebhookOnTheUrl();
  await testClaapCreatesWhenNoneIsOnTheUrl();
  await testCalendlyCreatesAnOrganizationSubscription();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
