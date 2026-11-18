/**
 * Calendly webhook provisioning: events per entity and the
 * organization-scoped create, which returns the signing key.
 *
 * Run: node --import tsx src/connectors/vendor-webhooks/calendly.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AxiosInstance } from "axios";
import {
  calendlyWebhookEventsForEntities,
  calendlyWebhookProvisioning,
} from "./calendly";

const ENDPOINT = "https://mako.example/api/webhooks/ws/flow";
const ORG = "https://api.calendly.com/organizations/ORG1";

void test("events per entity", () => {
  assert.deepEqual(calendlyWebhookEventsForEntities(["invitees"]).sort(), [
    "invitee.canceled",
    "invitee.created",
    "invitee_no_show.created",
  ]);
  assert.deepEqual(
    calendlyWebhookEventsForEntities(["scheduled_events"]).sort(),
    ["invitee.canceled", "invitee.created"],
  );
  assert.deepEqual(calendlyWebhookEventsForEntities(["event_types"]).sort(), [
    "event_type.created",
    "event_type.updated",
  ]);
  assert.deepEqual(calendlyWebhookEventsForEntities(["groups"]), []);
});

void test("create subscribes the token's organization and returns the signing key", async () => {
  const posts: Array<{ path: string; body: any }> = [];
  const api = {
    get: async (path: string) => {
      assert.equal(path, "/users/me");
      return {
        data: {
          resource: {
            uri: "https://api.calendly.com/users/U1",
            current_organization: ORG,
          },
        },
      };
    },
    post: async (path: string, body: any) => {
      posts.push({ path, body });
      return {
        data: {
          resource: {
            uri: "https://api.calendly.com/webhook_subscriptions/WH1",
            signing_key: "sign",
          },
        },
      };
    },
  } as unknown as AxiosInstance;

  const provisioning = calendlyWebhookProvisioning({ access_token: "t" }, api);
  const result = await provisioning.create({
    endpointUrl: ENDPOINT,
    enabledEntities: ["event_types"],
  });

  assert.deepEqual(result, {
    providerWebhookId: "WH1",
    endpointUrl: ENDPOINT,
    signingSecret: "sign",
  });
  assert.deepEqual(posts, [
    {
      path: "/webhook_subscriptions",
      body: {
        url: ENDPOINT,
        events: ["event_type.created", "event_type.updated"],
        organization: ORG,
        scope: "organization",
      },
    },
  ]);
  assert.equal(await provisioning.update(), null);
});

void test("create refuses events Calendly does not emit", async () => {
  const api = {
    get: async () => ({
      data: { resource: { uri: "u", current_organization: ORG } },
    }),
  } as unknown as AxiosInstance;
  await assert.rejects(
    () =>
      calendlyWebhookProvisioning({ access_token: "t" }, api).create({
        endpointUrl: ENDPOINT,
        events: ["routing_form.submitted"],
      }),
    /Calendly only emits/,
  );
});

void test("no token fails before any call", async () => {
  await assert.rejects(
    () => calendlyWebhookProvisioning({}).create({ endpointUrl: ENDPOINT }),
    /Calendly access token not configured/,
  );
});
