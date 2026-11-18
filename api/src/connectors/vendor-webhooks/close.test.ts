/**
 * Close webhook provisioning: the events per entity, create (or adopt) of
 * the webhook on the flow URL with its signing key, and the client's retry
 * policy. Moved from close/connector.test.ts with the code.
 *
 * Run: node --import tsx src/connectors/vendor-webhooks/close.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import axios, { type AxiosInstance } from "axios";
import {
  closeWebhookEventsForEntities,
  closeWebhookProvisioning,
  createCloseClient,
} from "./close";

const ENDPOINT = "https://app.mako.ai/api/webhooks/ws/flow";

const provisioning = (api: Record<string, unknown>) =>
  closeWebhookProvisioning("test-key", api as unknown as AxiosInstance);

void test("users subscribe to membership events (Close has no user.*)", () => {
  assert.deepEqual(closeWebhookEventsForEntities(["users"]), [
    "membership.activated",
    "membership.deactivated",
  ]);
});

void test("call events include updated", () => {
  // Regression: `activity.call updated` was missing from the subscription
  // list, so manually-logged calls (source "External") kept duration 0
  // forever and recordings never attached.
  assert.deepEqual(closeWebhookEventsForEntities(["activities:Call"]), [
    "activity.call.created",
    "activity.call.updated",
    "activity.call.deleted",
    "activity.call.answered",
    "activity.call.completed",
  ]);
});

void test("task-completed events include updated", () => {
  assert.deepEqual(
    closeWebhookEventsForEntities(["activities:TaskCompleted"]),
    [
      "activity.task_completed.created",
      "activity.task_completed.updated",
      "activity.task_completed.deleted",
    ],
  );
});

void test("group events are scoped to groups", () => {
  assert.deepEqual(closeWebhookEventsForEntities(["groups"]), [
    "group.created",
    "group.updated",
    "group.deleted",
  ]);
});

void test("create returns the new webhook's signature key", async () => {
  const result = await provisioning({
    get: async () => ({ data: { data: [] } }),
    post: async (_url: string, body: Record<string, unknown>) => {
      assert.equal(body.url, ENDPOINT);
      return {
        data: {
          id: "whsub_new",
          url: ENDPOINT,
          signature_key: "aabbccddeeff00112233445566778899",
        },
      };
    },
  }).create({ endpointUrl: ENDPOINT, enabledEntities: ["leads"] });

  assert.equal(result.providerWebhookId, "whsub_new");
  assert.equal(result.signingSecret, "aabbccddeeff00112233445566778899");
});

void test("create adopts the webhook already on the URL and returns its key", async () => {
  let putCalled = false;
  const result = await provisioning({
    get: async (url: string) => {
      if (url === "/webhook/") {
        return {
          data: {
            data: [
              {
                id: "whsub_existing",
                url: ENDPOINT,
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
  }).create({ endpointUrl: ENDPOINT, enabledEntities: ["leads"] });

  assert.equal(putCalled, true);
  assert.equal(result.providerWebhookId, "whsub_existing");
  assert.equal(result.signingSecret, "00112233445566778899aabbccddeeff");
});

void test("create reads the key from the webhook when the list leaves it out", async () => {
  const result = await provisioning({
    get: async (url: string) => {
      if (url === "/webhook/") {
        return { data: { data: [{ id: "whsub_existing", url: ENDPOINT }] } };
      }
      if (url === "/webhook/whsub_existing/") {
        return {
          data: {
            id: "whsub_existing",
            url: ENDPOINT,
            signature_key: "fedcba9876543210fedcba9876543210",
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    },
    put: async () => ({ data: {} }),
  }).create({ endpointUrl: ENDPOINT, enabledEntities: ["contacts"] });

  assert.equal(result.providerWebhookId, "whsub_existing");
  assert.equal(result.signingSecret, "fedcba9876543210fedcba9876543210");
});

/**
 * A sustained 429 whose Retry-After is an HTTP-date is honoured (a past
 * date means "now", never NaN), retries are capped, and a write is not
 * repeated after a 5xx that may have applied it.
 */
void test("client retries are capped, date-aware, and never repeat a write after a 5xx", async () => {
  const delays: number[] = [];
  const api = createCloseClient({
    apiKey: "vendor-webhooks-retry-key",
    minDelayMs: 0,
    sleep: ms => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
  let calls = 0;
  api.defaults.adapter = async (request: any) => {
    calls++;
    const error = new axios.AxiosError("Too Many Requests", "ERR_BAD_REQUEST");
    error.response = {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" },
      data: {},
      config: request,
    } as any;
    throw error;
  };
  await assert.rejects(
    api.get("/webhook/"),
    (error: any) => error?.response?.status === 429,
  );
  assert.equal(calls, 9, "1 attempt + 8 capped retries");
  assert.ok(
    delays.every(ms => Number.isFinite(ms) && ms === 0),
    `past HTTP-date waits 0 ms, never NaN: ${delays.join(",")}`,
  );

  calls = 0;
  api.defaults.adapter = async (request: any) => {
    calls++;
    const error = new axios.AxiosError("Bad Gateway", "ERR_BAD_RESPONSE");
    error.response = {
      status: 502,
      statusText: "Bad Gateway",
      headers: {},
      data: {},
      config: request,
    } as any;
    throw error;
  };
  await assert.rejects(api.post("/webhook/", { url: "https://x" }));
  assert.equal(calls, 1, "a write is not retried after a 5xx");
  calls = 0;
  await assert.rejects(api.get("/webhook/"));
  assert.equal(calls, 9, "a read is retried after a 5xx");
});
