/**
 * Claap webhook provisioning: recording events per entity, create, and
 * adopt (with retarget) of the webhook already on the flow URL.
 *
 * Run: node --import tsx src/connectors/vendor-webhooks/claap.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AxiosInstance } from "axios";
import {
  claapWebhookEventsForEntities,
  claapWebhookProvisioning,
} from "./claap";

const ENDPOINT = "https://mako.example/api/webhooks/ws/flow";

void test("recordings and transcripts both subscribe to the recording events", () => {
  assert.deepEqual(claapWebhookEventsForEntities(["recordings"]), [
    "recording_added",
    "recording_updated",
  ]);
  // Transcripts ride on the recording webhooks.
  assert.deepEqual(claapWebhookEventsForEntities(["recording_transcripts"]), [
    "recording_added",
    "recording_updated",
  ]);
  assert.deepEqual(claapWebhookEventsForEntities(["workspace"]), []);
  assert.deepEqual(claapWebhookEventsForEntities([]), [
    "recording_added",
    "recording_updated",
  ]);
});

void test("create posts a new webhook and returns its id and secret", async () => {
  const calls: string[] = [];
  const api = {
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      return {
        data: { result: [{ id: "other", url: "https://elsewhere.test" }] },
      };
    },
    post: async (path: string, body: any) => {
      calls.push(`POST ${path}`);
      assert.deepEqual(body, {
        url: ENDPOINT,
        events: ["recording_added", "recording_updated"],
      });
      return { data: { result: { webhook: { id: "wh1", secret: "s3" } } } };
    },
  } as unknown as AxiosInstance;

  const result = await claapWebhookProvisioning("k", api).create({
    endpointUrl: ENDPOINT,
    enabledEntities: ["recordings"],
  });
  assert.deepEqual(result, {
    providerWebhookId: "wh1",
    endpointUrl: ENDPOINT,
    signingSecret: "s3",
  });
  assert.deepEqual(calls, ["GET /v1/webhooks", "POST /v1/webhooks"]);
});

void test("create adopts and retargets the webhook already on the URL", async () => {
  const calls: string[] = [];
  const api = {
    get: async () => ({
      data: { result: { webhooks: [{ id: "wh0", url: ENDPOINT }] } },
    }),
    put: async (path: string) => {
      calls.push(`PUT ${path}`);
      return { data: {} };
    },
    post: async () => {
      throw new Error("never creates");
    },
  } as unknown as AxiosInstance;

  const provisioning = claapWebhookProvisioning("k", api);
  const result = await provisioning.create({ endpointUrl: ENDPOINT });
  assert.equal(result.providerWebhookId, "wh0");
  assert.equal(result.signingSecret, undefined, "Claap may not show it");
  assert.deepEqual(calls, ["PUT /v1/webhooks/wh0"]);
  assert.equal(await provisioning.update(), null);
});
