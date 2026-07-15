import assert from "node:assert/strict";
import { CloseConnector } from "./connector";
import { buildCloseSearchFieldSelection } from "./schema";

function createConnector() {
  return new CloseConnector({
    id: "ds_close",
    name: "Close",
    type: "close",
    config: { api_key: "test-key" },
  } as any);
}

function testUserWebhookEventsAreSupported() {
  const connector = createConnector();

  // Close has no user.* webhook selectors — membership carries user CDC.
  assert.deepEqual(connector.getWebhookEventsForEntities(["users"]), [
    "membership.activated",
    "membership.deactivated",
  ]);
}

function testUserWebhookEventsAreMapped() {
  const connector = createConnector();

  assert.deepEqual(connector.getWebhookEventMapping("membership.activated"), {
    entity: "users",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("membership.deactivated"), {
    entity: "users",
    operation: "delete",
  });
  // Legacy user.* mappings retained for defensive processing.
  assert.deepEqual(connector.getWebhookEventMapping("user.created"), {
    entity: "users",
    operation: "upsert",
  });
}

function testUserWebhookPayloadIsExtractedForProcessing() {
  const connector = createConnector();

  assert.deepEqual(
    connector.extractWebhookData({
      event: {
        object_type: "membership",
        action: "activated",
        object_id: "memb_123",
        data: {
          id: "memb_123",
          user_id: "user_123",
          user: {
            id: "user_123",
            email: "user@example.com",
            first_name: "Test",
            date_updated: "2026-05-20T07:00:00.000Z",
          },
        },
      },
    }),
    {
      id: "user_123",
      data: {
        id: "user_123",
        email: "user@example.com",
        first_name: "Test",
        date_updated: "2026-05-20T07:00:00.000Z",
      },
    },
  );
}

function testUserWebhookCdcRecordUsesUsersEntity() {
  const connector = createConnector();

  const records = connector.extractWebhookCdcRecords(
    {
      id: "evt_123",
      event: {
        object_type: "membership",
        action: "deactivated",
        object_id: "memb_123",
        data: {
          id: "memb_123",
          user_id: "user_123",
          user: { id: "user_123" },
        },
      },
    },
    "membership.deactivated",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].entity, "users");
  assert.equal(records[0].recordId, "user_123");
  assert.equal(records[0].operation, "delete");
  assert.deepEqual(records[0].payload, { id: "user_123" });
}

// Regression: Close nests its unique event id at `event.event.id`. The CDC
// record's changeId must resolve to it so distinct updates get distinct
// idempotency keys (instead of collapsing onto `lead.updated:<recordId>`).
function testWebhookChangeIdUsesNestedEventId() {
  const connector = createConnector();

  const records = connector.extractWebhookCdcRecords(
    {
      event: {
        id: "ev_nested_123",
        object_type: "lead",
        action: "updated",
        object_id: "lead_abc",
        date_updated: "2026-06-21T17:19:39.000Z",
        data: {
          id: "lead_abc",
          display_name: "Acme",
          date_updated: "2026-06-21T17:19:39.000Z",
        },
      },
    },
    "lead.updated",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].changeId, "ev_nested_123");
}

// When no vendor event id is present, the fallback changeId must include the
// source timestamp so two distinct updates of the same record never share a
// changeId (and therefore never collapse to one idempotency key).
function testWebhookChangeIdFallbackIncludesSourceTs() {
  const connector = createConnector();

  const records = connector.extractWebhookCdcRecords(
    {
      event: {
        object_type: "lead",
        action: "updated",
        object_id: "lead_xyz",
        date_updated: "2026-06-21T17:19:39.000Z",
        data: {
          id: "lead_xyz",
          display_name: "Beta",
          date_updated: "2026-06-21T17:19:39.000Z",
        },
      },
    },
    "lead.updated",
  );

  assert.equal(records.length, 1);
  assert.ok(
    records[0].changeId.endsWith(":2026-06-21T17:19:39.000Z"),
    `changeId should include sourceTs, got ${records[0].changeId}`,
  );
  assert.ok(records[0].changeId.includes("lead_xyz"));
}

function testGroupsEntityIsAvailable() {
  const connector = createConnector();

  assert.ok(
    connector.getAvailableEntities().includes("groups"),
    "groups should be an available entity",
  );
  assert.ok(
    connector.getEntityMetadata().some(meta => meta.name === "groups"),
    "groups should be present in entity metadata",
  );
}

function testGroupWebhookEventsAreScopedToGroups() {
  const connector = createConnector();

  assert.deepEqual(connector.getWebhookEventsForEntities(["groups"]), [
    "group.created",
    "group.updated",
    "group.deleted",
  ]);
}

function testGroupWebhookEventsAreMapped() {
  const connector = createConnector();

  assert.deepEqual(connector.getWebhookEventMapping("group.created"), {
    entity: "groups",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("group.updated"), {
    entity: "groups",
    operation: "upsert",
  });
  assert.deepEqual(connector.getWebhookEventMapping("group.deleted"), {
    entity: "groups",
    operation: "delete",
  });
}

async function testGroupSchemaResolves() {
  const connector = createConnector();

  const schema = await connector.resolveSchema("groups");
  assert.ok(schema, "groups schema should resolve");
  if (!schema) return;
  assert.equal(schema.entity, "groups");
  assert.ok(schema.fields.members, "groups schema should expose members");
  assert.ok(
    schema.fields.organization_id,
    "groups schema should expose organization_id",
  );
}

// Regression: opportunity custom fields must be flattened into `custom_cf_*`
// columns on the backfill path. Previously only leads and custom_objects were
// flattened, so opportunity custom fields stayed buried in the nested `custom`
// JSON blob and never materialized as destination columns.
function testOpportunityBackfillFlattensCustomFields() {
  const connector = createConnector();

  const normalized = connector.normalizeBackfillRecord("opportunities", {
    id: "oppo_123",
    lead_id: "lead_abc",
    status_label: "Active",
    date_updated: "2026-06-21T17:19:39.000Z",
    // Nested blob (Search API `custom` field)
    custom: { cf_renewal: "2027-01-01", cf_amount: 42 },
    // Flat dotted key (explicit `_fields=custom.cf_<id>` selector)
    "custom.cf_owner": "user_1",
  });

  assert.ok(normalized);
  if (!normalized) return;
  const payload = normalized.payload as Record<string, unknown>;
  assert.equal(payload.custom_cf_renewal, "2027-01-01");
  assert.equal(payload.custom_cf_amount, 42);
  assert.equal(payload.custom_cf_owner, "user_1");
  assert.ok(
    !("custom.cf_owner" in payload),
    "dotted key should be renamed, not duplicated",
  );
  assert.deepEqual(
    payload.custom,
    { cf_renewal: "2027-01-01", cf_amount: 42 },
    "nested custom blob should be preserved as JSON fallback",
  );
}

// Same regression for the webhook path: opportunity.updated payloads carry a
// nested `custom` object which must land in `custom_cf_*` columns.
function testOpportunityWebhookFlattensCustomFields() {
  const connector = createConnector();

  const records = connector.extractWebhookCdcRecords(
    {
      event: {
        id: "ev_oppo_1",
        object_type: "opportunity",
        action: "updated",
        object_id: "oppo_123",
        date_updated: "2026-06-21T17:19:39.000Z",
        data: {
          id: "oppo_123",
          status_label: "Active",
          date_updated: "2026-06-21T17:19:39.000Z",
          custom: { cf_renewal: "2027-01-01" },
        },
      },
    },
    "opportunity.updated",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].entity, "opportunities");
  const payload = records[0].payload as Record<string, unknown>;
  assert.equal(payload.custom_cf_renewal, "2027-01-01");
}

// Contacts share the same custom-field mechanics as opportunities.
function testContactBackfillFlattensCustomFields() {
  const connector = createConnector();

  const normalized = connector.normalizeBackfillRecord("contacts", {
    id: "cont_123",
    lead_id: "lead_abc",
    date_updated: "2026-06-21T17:19:39.000Z",
    custom: { cf_linkedin: "https://linkedin.com/in/x" },
  });

  assert.ok(normalized);
  if (!normalized) return;
  const payload = normalized.payload as Record<string, unknown>;
  assert.equal(payload.custom_cf_linkedin, "https://linkedin.com/in/x");
}

// The Search API field selection must enumerate every custom field as an
// explicit `custom.cf_<id>` selector (plus keep the `custom` blob fallback),
// so no field is silently missing from backfill payloads.
function testSearchFieldSelectionIncludesCustomFieldSelectors() {
  const selection = buildCloseSearchFieldSelection(
    ["id", "lead_id", "custom"],
    [
      {
        id: "cf_renewal",
        name: "Renewal Date",
        type: "date",
        appliesTo: "opportunity",
      },
      {
        id: "cf_amount",
        name: "Amount",
        type: "number",
        appliesTo: "opportunity",
      },
      { id: "", name: "bogus", type: "text", appliesTo: "opportunity" },
    ],
  );

  assert.deepEqual(selection, [
    "id",
    "lead_id",
    "custom",
    "custom.cf_renewal",
    "custom.cf_amount",
  ]);
}

// End-to-end contract for the opportunity backfill path with a stubbed Close
// client: the Search API request must enumerate `custom.cf_<id>` selectors,
// and records handed to onBatch must arrive with flattened `custom_cf_*` keys.
async function testOpportunitySearchBackfillRequestsAndFlattensCustomFields() {
  const connector = createConnector();

  const searchBodies: any[] = [];
  let servedPage = false;

  const opportunityRow = {
    id: "oppo_1",
    lead_id: "lead_1",
    status_label: "Active",
    date_created: "2026-01-01T00:00:01.000Z",
    date_updated: "2026-01-02T00:00:00.000Z",
    "custom.cf_renewal": "2027-01-01",
    custom: { cf_renewal: "2027-01-01", cf_amount: 42 },
  };

  (connector as any).closeApi = {
    get: async (url: string) => {
      if (url === "/custom_field_schema/opportunity/") {
        return {
          data: {
            fields: [
              { id: "cf_renewal", name: "Renewal Date", type: "date" },
              { id: "cf_amount", name: "Amount", type: "number" },
            ],
          },
        };
      }
      return { data: {} };
    },
    post: async (_url: string, body: any) => {
      if (body?.include_counts) {
        return { data: { count: { total: 1 }, data: [] } };
      }
      if (body?._limit === 1 && Array.isArray(body?.sort)) {
        // Oldest-record probe used to seed the date window
        return {
          data: {
            data: [{ id: "oppo_1", date_created: "2026-01-01T00:00:00.000Z" }],
          },
        };
      }
      if (body?._limit === 1) {
        // Gap probe after the window is exhausted — no more data
        return { data: { data: [] } };
      }
      searchBodies.push(body);
      if (!servedPage) {
        servedPage = true;
        return { data: { data: [opportunityRow], cursor: null } };
      }
      return { data: { data: [], cursor: null } };
    },
  };

  const batches: Record<string, unknown>[][] = [];
  const state = await connector.fetchEntityChunk({
    entity: "opportunities",
    onBatch: async batch => {
      batches.push(batch);
    },
    onProgress: () => {},
    rateLimitDelay: 1,
  } as any);

  assert.equal(state.hasMore, false);
  assert.ok(searchBodies.length >= 1, "should issue a paged search request");
  const requestedFields: string[] = searchBodies[0]?._fields?.opportunity ?? [];
  assert.ok(
    requestedFields.includes("custom.cf_renewal"),
    `_fields should include custom.cf_renewal, got: ${requestedFields.join(",")}`,
  );
  assert.ok(
    requestedFields.includes("custom"),
    "_fields should keep the custom blob fallback",
  );

  assert.equal(batches.length, 1);
  const record = batches[0][0];
  assert.equal(record.custom_cf_renewal, "2027-01-01");
  assert.equal(record.custom_cf_amount, 42);
  assert.ok(
    !("custom.cf_renewal" in record),
    "dotted key should be renamed in emitted records",
  );
}

async function testCreateWebhookSubscriptionReturnsSignatureKey() {
  const connector = createConnector();
  const endpointUrl = "https://app.mako.ai/api/webhooks/ws/flow";

  (connector as any).closeApi = {
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

  const result = await connector.createWebhookSubscription({
    endpointUrl,
    enabledEntities: ["leads"],
  });

  assert.equal(result.providerWebhookId, "whsub_new");
  assert.equal(result.signingSecret, "aabbccddeeff00112233445566778899");
}

async function testExistingWebhookSubscriptionReturnsSignatureKey() {
  const connector = createConnector();
  const endpointUrl = "https://app.mako.ai/api/webhooks/ws/flow";
  let putCalled = false;

  (connector as any).closeApi = {
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

  const result = await connector.createWebhookSubscription({
    endpointUrl,
    enabledEntities: ["leads"],
  });

  assert.equal(putCalled, true);
  assert.equal(result.providerWebhookId, "whsub_existing");
  assert.equal(result.signingSecret, "00112233445566778899aabbccddeeff");
}

async function testExistingWebhookFetchesDetailWhenListOmitsSignatureKey() {
  const connector = createConnector();
  const endpointUrl = "https://app.mako.ai/api/webhooks/ws/flow";

  (connector as any).closeApi = {
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

  const result = await connector.createWebhookSubscription({
    endpointUrl,
    enabledEntities: ["contacts"],
  });

  assert.equal(result.providerWebhookId, "whsub_existing");
  assert.equal(result.signingSecret, "fedcba9876543210fedcba9876543210");
}

async function main() {
  testUserWebhookEventsAreSupported();
  testUserWebhookEventsAreMapped();
  testUserWebhookPayloadIsExtractedForProcessing();
  testUserWebhookCdcRecordUsesUsersEntity();
  testWebhookChangeIdUsesNestedEventId();
  testWebhookChangeIdFallbackIncludesSourceTs();
  testGroupsEntityIsAvailable();
  testGroupWebhookEventsAreScopedToGroups();
  testGroupWebhookEventsAreMapped();
  await testGroupSchemaResolves();
  testOpportunityBackfillFlattensCustomFields();
  testOpportunityWebhookFlattensCustomFields();
  testContactBackfillFlattensCustomFields();
  testSearchFieldSelectionIncludesCustomFieldSelectors();
  await testOpportunitySearchBackfillRequestsAndFlattensCustomFields();
  await testCreateWebhookSubscriptionReturnsSignatureKey();
  await testExistingWebhookSubscriptionReturnsSignatureKey();
  await testExistingWebhookFetchesDetailWhenListOmitsSignatureKey();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
