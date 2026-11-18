/**
 * PandaDoc webhook provisioning: triggers per entity, and the create call
 * with its payload sections and returned shared key.
 *
 * Run: node --import tsx src/connectors/vendor-webhooks/pandadoc.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AxiosInstance } from "axios";
import {
  pandaDocSupportedWebhookEvents,
  pandaDocWebhookEventsForEntities,
  pandaDocWebhookProvisioning,
} from "./pandadoc";

const ENDPOINT = "https://mako.example/api/webhooks/ws/flow";

void test("triggers per entity; no entities means every trigger", () => {
  assert.deepEqual(pandaDocWebhookEventsForEntities(["documents"]).sort(), [
    "document_completed_pdf_ready",
    "document_creation_failed",
    "document_deleted",
    "document_section_added",
    "document_state_changed",
    "document_updated",
    "quote_updated",
    "recipient_completed",
  ]);
  assert.deepEqual(pandaDocWebhookEventsForEntities(["templates"]).sort(), [
    "template_created",
    "template_deleted",
    "template_updated",
  ]);
  assert.deepEqual(pandaDocWebhookEventsForEntities(["contacts"]), []);
  assert.equal(
    pandaDocWebhookEventsForEntities([]).length,
    pandaDocSupportedWebhookEvents().length,
  );
});

void test("create posts the flow's triggers with payload sections and returns the shared key", async () => {
  const posts: Array<{ path: string; body: any }> = [];
  const api = {
    post: async (path: string, body: any) => {
      posts.push({ path, body });
      return { data: { uuid: "sub-uuid", shared_key: "shared" } };
    },
  } as unknown as AxiosInstance;

  const result = await pandaDocWebhookProvisioning("k", api).create({
    endpointUrl: ENDPOINT,
    enabledEntities: ["templates"],
  });

  assert.deepEqual(result, {
    providerWebhookId: "sub-uuid",
    endpointUrl: ENDPOINT,
    signingSecret: "shared",
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/public/v1/webhook-subscriptions");
  assert.deepEqual(posts[0].body, {
    name: "Mako",
    url: ENDPOINT,
    active: true,
    payload: ["fields", "products", "tokens", "metadata", "pricing"],
    triggers: ["template_created", "template_updated", "template_deleted"],
  });
});

void test("create refuses unknown triggers before any call, and never updates", async () => {
  const provisioning = pandaDocWebhookProvisioning("k", {
    post: async () => {
      throw new Error("no call expected");
    },
  } as unknown as AxiosInstance);
  await assert.rejects(
    () =>
      provisioning.create({ endpointUrl: ENDPOINT, events: ["nope_event"] }),
    /No valid PandaDoc webhook events configured/,
  );
  assert.equal(await provisioning.update(), null);
});

void test("create fails when PandaDoc returns no uuid", async () => {
  const provisioning = pandaDocWebhookProvisioning("k", {
    post: async () => ({ data: {} }),
  } as unknown as AxiosInstance);
  await assert.rejects(
    () => provisioning.create({ endpointUrl: ENDPOINT }),
    /Failed to create PandaDoc webhook subscription: .*no subscription uuid/,
  );
});
