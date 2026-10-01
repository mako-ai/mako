import assert from "node:assert/strict";
import {
  CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH,
  CloseConnector,
  formatCloseApiErrorResponse,
} from "./connector";
import {
  buildCloseSearchFieldSelection,
  splitCloseSearchFieldSelection,
} from "./schema";

function createConnector() {
  return new CloseConnector({
    id: "ds_close",
    name: "Close",
    type: "close",
    config: { api_key: "test-key" },
  } as any);
}

function testCloseApiErrorResponseIsFormattedForLogs() {
  const error = Object.assign(
    new Error("Request failed with status code 400"),
    {
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: "Invalid field selection",
          "field-errors": { _fields: ["Unsupported field"] },
        },
      },
    },
  );

  assert.equal(
    formatCloseApiErrorResponse(error),
    '{"error":"Invalid field selection","field-errors":{"_fields":["Unsupported field"]}}',
  );
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

function testCallWebhookEventsIncludeUpdated() {
  const connector = createConnector();

  // Regression: `activity.call updated` was missing from the subscription
  // list, so manually-logged calls (source "External") kept duration 0 forever
  // and recordings never attached — while created/answered/completed flowed.
  assert.deepEqual(connector.getWebhookEventsForEntities(["activities:Call"]), [
    "activity.call.created",
    "activity.call.updated",
    "activity.call.deleted",
    "activity.call.answered",
    "activity.call.completed",
  ]);
  assert.deepEqual(connector.getWebhookEventMapping("activity.call.updated"), {
    entity: "activities:Call",
    operation: "upsert",
  });
}

function testTaskCompletedWebhookEventsIncludeUpdated() {
  const connector = createConnector();

  assert.deepEqual(
    connector.getWebhookEventsForEntities(["activities:TaskCompleted"]),
    [
      "activity.task_completed.created",
      "activity.task_completed.updated",
      "activity.task_completed.deleted",
    ],
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

function makeCustomFields(count: number, appliesTo = "lead") {
  return Array.from({ length: count }, (_, i) => ({
    id: `cf_${String(i).padStart(3, "0")}`,
    name: `Field ${i}`,
    type: "text",
    appliesTo,
  }));
}

// Close rejects a `_fields` list past an undocumented ceiling (~100+). The
// selection must be split so no single request names more than the budget
// of custom selectors, with the remainder shaped as by-id follow-ups that
// each start with the `id` merge key.
function testSplitFieldSelectionRespectsBudget() {
  const plan = splitCloseSearchFieldSelection(
    ["id", "name", "date_created"],
    makeCustomFields(130),
    60,
  );

  assert.equal(plan.primary.length, 3 + 60);
  assert.deepEqual(plan.primary.slice(0, 3), ["id", "name", "date_created"]);
  assert.equal(plan.primary[3], "custom.cf_000");
  assert.equal(plan.primary[62], "custom.cf_059");

  assert.equal(plan.supplemental.length, 2);
  assert.equal(plan.supplemental[0][0], "id");
  assert.equal(plan.supplemental[0].length, 61);
  assert.equal(plan.supplemental[0][1], "custom.cf_060");
  assert.equal(plan.supplemental[1][0], "id");
  assert.equal(plan.supplemental[1].length, 11);
  assert.equal(plan.supplemental[1][10], "custom.cf_129");

  // Everything fits: no follow-ups, and `id` is always requested.
  const small = splitCloseSearchFieldSelection(
    ["name"],
    makeCustomFields(5),
    60,
  );
  assert.deepEqual(small.supplemental, []);
  assert.equal(small.primary[0], "id");
  assert.equal(small.primary.length, 2 + 5);

  // Duplicate ids (a shared field listed twice) are requested once.
  const dup = splitCloseSearchFieldSelection(
    ["id"],
    [...makeCustomFields(2), ...makeCustomFields(2)],
    60,
  );
  assert.deepEqual(dup.primary, ["id", "custom.cf_000", "custom.cf_001"]);
}

/**
 * Stub Close client for the lead backfill: serves one page of `pageRows`,
 * rejects any search request whose `_fields.lead` is longer than
 * `maxFields` with the 400 Close returns for an oversized selection, and
 * answers by-id follow-ups with the requested selectors for each id.
 */
function stubLeadSearchApi(params: {
  customFieldCount: number;
  maxFields: number;
  pageRows: Array<Record<string, unknown>>;
}) {
  const searchBodies: any[] = [];
  let servedPage = false;
  const post = async (_url: string, body: any) => {
    if (body?.include_counts) {
      return { data: { count: { total: params.pageRows.length }, data: [] } };
    }
    const idQuery = body?.query?.queries?.find((q: any) => q?.type === "or");
    if (!idQuery && body?._limit === 1 && Array.isArray(body?.sort)) {
      // Oldest-record probe used to seed the date window
      return {
        data: {
          data: [
            {
              id: params.pageRows[0].id,
              date_created: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      };
    }
    if (!idQuery && body?._limit === 1) {
      // Gap probe after the window is exhausted — no more data
      return { data: { data: [] } };
    }
    searchBodies.push(body);
    const fields: string[] = body?._fields?.lead ?? [];
    if (fields.length > params.maxFields) {
      throw Object.assign(new Error("Request failed with status code 400"), {
        isAxiosError: true,
        response: {
          status: 400,
          headers: {},
          data: { "field-errors": { _fields: ["Too many fields requested"] } },
        },
      });
    }

    if (idQuery) {
      // By-id follow-up: return only the requested selectors for each id.
      const ids: string[] = idQuery.queries.map((q: any) => q.value);
      return {
        data: {
          data: params.pageRows
            .filter(row => ids.includes(String(row.id)))
            .map(row => {
              const out: Record<string, unknown> = { id: row.id };
              for (const field of fields) {
                if (field !== "id" && field in row) out[field] = row[field];
              }
              return out;
            }),
          cursor: null,
        },
      };
    }

    if (!servedPage) {
      servedPage = true;
      return {
        data: {
          data: params.pageRows.map(row => {
            const out: Record<string, unknown> = {};
            for (const field of fields) {
              if (field in row) out[field] = row[field];
            }
            return out;
          }),
          cursor: null,
        },
      };
    }
    return { data: { data: [], cursor: null } };
  };

  const api = {
    get: async (url: string) => {
      if (url === "/custom_field_schema/lead/") {
        return { data: { fields: makeCustomFields(params.customFieldCount) } };
      }
      return { data: { data: [] } };
    },
    post,
  };
  return { api, searchBodies };
}

function makeLeadRow(id: string, customFieldCount: number) {
  const row: Record<string, unknown> = {
    id,
    name: `Lead ${id}`,
    date_created: "2026-01-02T00:00:00.000Z",
    date_updated: "2026-01-03T00:00:00.000Z",
  };
  for (const field of makeCustomFields(customFieldCount)) {
    row[`custom.${field.id}`] = `${id}:${field.id}`;
  }
  return row;
}

// Regression for the July 2026 outage: an org with 130 lead custom fields
// must sync every one of them as a flat `custom_cf_*` key, without any
// request exceeding the per-request selector budget.
async function testLeadBackfillSplitsCustomFieldsAcrossRequests() {
  const connector = createConnector();
  const rows = [makeLeadRow("lead_a", 130), makeLeadRow("lead_b", 130)];
  const { api, searchBodies } = stubLeadSearchApi({
    customFieldCount: 130,
    maxFields: 100,
    pageRows: rows,
  });
  (connector as any).closeApi = api;

  const batches: Record<string, unknown>[][] = [];
  const state = await connector.fetchEntityChunk({
    entity: "leads",
    onBatch: async (batch: Record<string, unknown>[]) => {
      batches.push(batch);
    },
    onProgress: () => {},
    rateLimitDelay: 1,
  } as any);

  assert.equal(state.hasMore, false);
  const pageRequests = searchBodies.filter(
    b => !b.query?.queries?.some((q: any) => q?.type === "or"),
  );
  const byIdRequests = searchBodies.filter(b =>
    b.query?.queries?.some((q: any) => q?.type === "or"),
  );
  // One paged request serves the rows; the loop then advances the window and
  // issues one more paged request that comes back empty.
  assert.ok(pageRequests.length >= 1, "a paged request for the window");
  assert.equal(byIdRequests.length, 2, "two by-id follow-ups for the rest");
  for (const body of searchBodies) {
    const custom = (body._fields.lead as string[]).filter(f =>
      f.startsWith("custom."),
    );
    assert.ok(
      custom.length <= CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH,
      `request named ${custom.length} custom selectors`,
    );
    assert.ok(
      !(body._fields.lead as string[]).includes("custom"),
      "deprecated custom blob must not be requested",
    );
  }
  // Follow-ups target exactly the ids of the page.
  for (const body of byIdRequests) {
    const or = body.query.queries.find((q: any) => q.type === "or");
    assert.deepEqual(
      or.queries.map((q: any) => q.value),
      ["lead_a", "lead_b"],
    );
    assert.equal(body._limit, 2);
  }

  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  for (const record of batches[0]) {
    const id = record.id as string;
    assert.equal(record.name, `Lead ${id}`);
    for (const field of makeCustomFields(130)) {
      assert.equal(
        record[`custom_${field.id}`],
        `${id}:${field.id}`,
        `${id} is missing custom_${field.id}`,
      );
    }
    assert.ok(!Object.keys(record).some(k => k.startsWith("custom.")));
  }
}

// If Close's ceiling is lower than the configured budget, the connector must
// shrink the batch and retry the same page instead of failing the sync.
async function testLeadBackfillShrinksBatchWhenCloseRejectsSelection() {
  const connector = createConnector();
  const rows = [makeLeadRow("lead_a", 70)];
  const { api, searchBodies } = stubLeadSearchApi({
    customFieldCount: 70,
    maxFields: 40,
    pageRows: rows,
  });
  (connector as any).closeApi = api;
  const warnings: string[] = [];

  const batches: Record<string, unknown>[][] = [];
  await connector.fetchEntityChunk({
    entity: "leads",
    onBatch: async (batch: Record<string, unknown>[]) => {
      batches.push(batch);
    },
    onLog: (level: string, message: string) => {
      if (level === "warn") warnings.push(message);
    },
    rateLimitDelay: 1,
  } as any);

  const sizes = searchBodies.map(b => (b._fields.lead as string[]).length);
  assert.ok(sizes[0] > 40, "first attempt used the default budget");
  const rejected = sizes.filter(n => n > 40);
  assert.equal(
    rejected.length,
    2,
    `60 -> 30 -> 15: two attempts over the ceiling, got ${sizes.join(",")}`,
  );
  const lastRejected = sizes.lastIndexOf(rejected[rejected.length - 1]);
  assert.ok(
    sizes.slice(lastRejected + 1).every(n => n <= 40),
    `after the last 400 every request fits the ceiling, got ${sizes.join(",")}`,
  );
  assert.ok(
    searchBodies.some(b =>
      b.query?.queries?.some((q: any) => q?.type === "or"),
    ),
    "the remaining fields are fetched by id",
  );
  assert.ok(
    warnings.some(m => m.includes("fewer custom selectors")),
    "the shrink is logged to the sync log",
  );
  assert.equal((connector as any).customSelectorBatchSize, 15);

  assert.equal(batches.length, 1);
  const record = batches[0][0];
  for (const field of makeCustomFields(70)) {
    assert.equal(record[`custom_${field.id}`], `lead_a:${field.id}`);
  }
}

// Schema change mid-run: a custom field deleted in Close after the schema
// was cached leaves a dangling selector that Close rejects. The connector
// must re-read the schema, drop the selector, and carry on — not shrink the
// batch, and not fail the sync.
async function testLeadBackfillReplansWhenCustomFieldDeletedMidRun() {
  const connector = createConnector();
  const rows = [makeLeadRow("lead_a", 3)];
  let schemaReads = 0;
  const { api, searchBodies } = stubLeadSearchApi({
    customFieldCount: 3,
    maxFields: 1000,
    pageRows: rows,
  });
  const basePost = api.post;
  (connector as any).closeApi = {
    get: async (url: string) => {
      if (url === "/custom_field_schema/lead/") {
        schemaReads++;
        // First read: three fields. Later reads: cf_002 has been deleted.
        return {
          data: {
            fields: makeCustomFields(schemaReads === 1 ? 3 : 2),
          },
        };
      }
      return { data: { data: [] } };
    },
    post: async (url: string, body: any) => {
      const fields: string[] = body?._fields?.lead ?? [];
      if (fields.includes("custom.cf_002")) {
        throw Object.assign(new Error("Request failed with status code 400"), {
          isAxiosError: true,
          response: {
            status: 400,
            headers: {},
            data: { "field-errors": { _fields: ["Unsupported field"] } },
          },
        });
      }
      return basePost(url, body);
    },
  };
  const warnings: string[] = [];

  const batches: Record<string, unknown>[][] = [];
  await connector.fetchEntityChunk({
    entity: "leads",
    onBatch: async (batch: Record<string, unknown>[]) => {
      batches.push(batch);
    },
    onLog: (level: string, message: string) => {
      if (level === "warn") warnings.push(message);
    },
    rateLimitDelay: 1,
  } as any);

  assert.equal(schemaReads, 2, "schema is re-read after the rejection");
  assert.ok(
    warnings.some(m => m.includes("schema changed during the run")),
    "the re-plan is logged to the sync log",
  );
  assert.equal(
    (connector as any).customSelectorBatchSize,
    CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH,
    "a schema change must not shrink the batch",
  );
  assert.ok(
    searchBodies.slice(1).every(b => !b._fields.lead.includes("custom.cf_002")),
    "the deleted field is no longer requested",
  );
  assert.equal(batches.length, 1);
  const record = batches[0][0];
  assert.equal(record.custom_cf_000, "lead_a:cf_000");
  assert.equal(record.custom_cf_001, "lead_a:cf_001");
  assert.ok(!("custom_cf_002" in record));
}

// A 400 that is not about the selection (and a selection-less entity) must
// still surface: shrinking is only for requests that carried selectors.
async function testUnrelatedSearch400StillThrows() {
  const connector = createConnector();
  (connector as any).closeApi = {
    get: async () => ({ data: { fields: [] } }),
    post: async () => {
      throw Object.assign(new Error("Request failed with status code 400"), {
        isAxiosError: true,
        response: { status: 400, headers: {}, data: { error: "Bad query" } },
      });
    },
  };

  await assert.rejects(
    connector.fetchEntityChunk({
      entity: "leads",
      state: {
        totalProcessed: 0,
        hasMore: true,
        iterationsInChunk: 0,
        metadata: {
          windowStart: "2026-01-01T00:00:00.000Z",
          windowEnd: "2026-01-08T00:00:00.000Z",
        },
      },
      onBatch: async () => {},
      maxIterations: 1,
      rateLimitDelay: 1,
    } as any),
    /status code 400/,
  );
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
    onBatch: async (batch: Record<string, unknown>[]) => {
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
    !requestedFields.includes("custom"),
    "_fields must not lean on the deprecated custom blob",
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

async function testExpiredCursorRetriesWithNormalizedWindowStart() {
  const connector = createConnector();
  const searchBodies: Record<string, unknown>[] = [];
  let requestCount = 0;

  (connector as any).closeApi = {
    get: async () => ({ data: { fields: [] } }),
    post: async (_url: string, body: Record<string, unknown>) => {
      searchBodies.push(body);
      requestCount++;

      if (requestCount === 1) {
        throw Object.assign(new Error("Request failed with status code 400"), {
          isAxiosError: true,
          response: {
            status: 400,
            headers: {},
            data: { "field-errors": { cursor: ["Invalid cursor"] } },
          },
        });
      }

      return {
        data: {
          data: [
            {
              id: "lead_1",
              name: "Lead 1",
              date_created: "2025-03-18T15:49:15.000000+00:00",
              date_updated: "2025-03-18T15:49:15.000000+00:00",
            },
          ],
          cursor: null,
        },
      };
    },
  };

  const state = await connector.fetchEntityChunk({
    entity: "leads",
    state: {
      totalProcessed: 40_117,
      hasMore: true,
      iterationsInChunk: 0,
      metadata: {
        pageCursor: "expired-close-cursor",
        lastSeenDateCreated: "2025-03-18T15:49:14.689000+00:00",
        windowStart: "2025-03-18T08:13:38.996Z",
        windowEnd: "2025-03-25T08:13:38.996Z",
      },
    },
    onBatch: async () => {},
    maxIterations: 1,
    rateLimitDelay: 1,
  });

  assert.equal(searchBodies.length, 2);
  assert.equal(searchBodies[0].cursor, "expired-close-cursor");
  assert.ok(!("cursor" in searchBodies[1]));
  const retriedQuery = searchBodies[1].query as {
    queries: Array<{
      condition?: { on_or_after?: { value?: string } };
    }>;
  };
  assert.equal(
    retriedQuery.queries[1].condition?.on_or_after?.value,
    "2025-03-18T15:49:14.689Z",
  );
  assert.equal(state.metadata?.pageCursor, null);
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
  testCloseApiErrorResponseIsFormattedForLogs();
  testUserWebhookEventsAreSupported();
  testUserWebhookEventsAreMapped();
  testUserWebhookPayloadIsExtractedForProcessing();
  testUserWebhookCdcRecordUsesUsersEntity();
  testWebhookChangeIdUsesNestedEventId();
  testWebhookChangeIdFallbackIncludesSourceTs();
  testGroupsEntityIsAvailable();
  testCallWebhookEventsIncludeUpdated();
  testTaskCompletedWebhookEventsIncludeUpdated();
  testGroupWebhookEventsAreScopedToGroups();
  testGroupWebhookEventsAreMapped();
  await testGroupSchemaResolves();
  testOpportunityBackfillFlattensCustomFields();
  testOpportunityWebhookFlattensCustomFields();
  testContactBackfillFlattensCustomFields();
  testSearchFieldSelectionIncludesCustomFieldSelectors();
  await testOpportunitySearchBackfillRequestsAndFlattensCustomFields();
  testSplitFieldSelectionRespectsBudget();
  await testLeadBackfillSplitsCustomFieldsAcrossRequests();
  await testLeadBackfillShrinksBatchWhenCloseRejectsSelection();
  await testLeadBackfillReplansWhenCustomFieldDeletedMidRun();
  await testUnrelatedSearch400StillThrows();
  await testExpiredCursorRetriesWithNormalizedWindowStart();
  await testCreateWebhookSubscriptionReturnsSignatureKey();
  await testExistingWebhookSubscriptionReturnsSignatureKey();
  await testExistingWebhookFetchesDetailWhenListOmitsSignatureKey();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
