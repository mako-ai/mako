/**
 * Close webhook provisioning: create or adopt the subscription on the flow
 * URL and return its signing key.
 * Run: node --import tsx src/webhook-provisioning/close.test.ts
 */
import assert from "node:assert/strict";
import type { AxiosInstance } from "axios";
import { closeWebhookEventsForEntities, provisionCloseWebhook } from "./close";

const endpointUrl = "https://app.mako.ai/api/webhooks/ws/flow";

const provision = (api: unknown, enabledEntities: string[]) =>
  provisionCloseWebhook(
    api as AxiosInstance,
    { endpointUrl, enabledEntities },
    closeWebhookEventsForEntities,
  );

async function testCreateWebhookSubscriptionReturnsSignatureKey() {
  const api = {
    get: async () => ({ data: { data: [] } }),
    post: async (_url: string, body: Record<string, unknown>) => {
      assert.equal(body.url, endpointUrl);
      return {
        data: {
          id: "whsub_new",
          url: endpointUrl,
          signature_key: "aabbccddeeff00112233445566778899",
        },
      };
    },
  };

  const result = await provision(api, ["leads"]);

  assert.equal(result.providerWebhookId, "whsub_new");
  assert.equal(result.signingSecret, "aabbccddeeff00112233445566778899");
}

async function testExistingWebhookSubscriptionReturnsSignatureKey() {
  let putCalled = false;

  const api = {
    get: async (url: string) => {
      if (url === "/webhook/") {
        return {
          data: {
            data: [
              {
                id: "whsub_existing",
                url: endpointUrl,
                signature_key: "00112233445566778899aabbccddeeff",
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    },
    put: async (url: string) => {
      putCalled = true;
      assert.equal(url, "/webhook/whsub_existing/");
      return { data: {} };
    },
  };

  const result = await provision(api, ["leads"]);

  assert.equal(putCalled, true);
  assert.equal(result.providerWebhookId, "whsub_existing");
  assert.equal(result.signingSecret, "00112233445566778899aabbccddeeff");
}

async function testExistingWebhookFetchesDetailWhenListOmitsSignatureKey() {
  const api = {
    get: async (url: string) => {
      if (url === "/webhook/") {
        return {
          data: {
            data: [{ id: "whsub_existing", url: endpointUrl }],
          },
        };
      }
      if (url === "/webhook/whsub_existing/") {
        return {
          data: {
            id: "whsub_existing",
            url: endpointUrl,
            signature_key: "fedcba9876543210fedcba9876543210",
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    },
    put: async () => ({ data: {} }),
  };

  const result = await provision(api, ["contacts"]);

  assert.equal(result.providerWebhookId, "whsub_existing");
  assert.equal(result.signingSecret, "fedcba9876543210fedcba9876543210");
}

function testEventsForEntities() {
  assert.deepEqual(closeWebhookEventsForEntities(["contacts"]), [
    "contact.created",
    "contact.updated",
    "contact.deleted",
  ]);
  assert.deepEqual(closeWebhookEventsForEntities(["unknown"]), []);
}

async function main() {
  await testCreateWebhookSubscriptionReturnsSignatureKey();
  await testExistingWebhookSubscriptionReturnsSignatureKey();
  await testExistingWebhookFetchesDetailWhenListOmitsSignatureKey();
  testEventsForEntities();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
