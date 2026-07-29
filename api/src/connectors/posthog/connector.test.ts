import assert from "node:assert/strict";
import { PosthogConnector, POSTHOG_BUILTIN_ENTITIES } from "./connector";
import { resolvePosthogEntitySchema } from "./schema";

function createConnector(config: Record<string, unknown> = {}) {
  return new PosthogConnector({
    id: "ds_posthog",
    name: "PostHog",
    type: "posthog",
    config: {
      api_base_url: "https://us.posthog.com",
      project_id: "12345",
      api_key: "phx_test_key",
      auth_type: "personal_api_key",
      ...config,
    },
  } as any);
}

function testConfigValidationRequiresProjectAndKey() {
  const connector = createConnector({ project_id: "", api_key: "" });
  const result = connector.validateConfig();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes("project_id")));
  assert.ok(result.errors.some(e => e.includes("api_key")));
}

function testBuiltinEntitiesAlwaysAvailable() {
  const connector = createConnector();
  const entities = connector.getAvailableEntities();
  assert.deepEqual(entities, [...POSTHOG_BUILTIN_ENTITIES]);

  const withQueries = createConnector({
    queries: [
      { name: "events_7d", query: "SELECT 1" },
      { name: "  ", query: "SELECT 1" },
      { name: "broken", query: "" },
    ],
  });
  assert.deepEqual(withQueries.getAvailableEntities(), [
    "surveys",
    "survey_responses",
    "events_7d",
  ]);
}

function testEntityMetadataIncludesSurveys() {
  const connector = createConnector();
  const metadata = connector.getEntityMetadata();
  const names = metadata.map(m => m.name);
  assert.ok(names.includes("surveys"));
  assert.ok(names.includes("survey_responses"));
  const surveys = metadata.find(m => m.name === "surveys");
  assert.equal(surveys?.layoutSuggestion?.partitionField, "created_at");
  const responses = metadata.find(m => m.name === "survey_responses");
  assert.equal(responses?.layoutSuggestion?.partitionField, "submitted_at");
}

function testSchemaResolution() {
  const surveys = resolvePosthogEntitySchema("surveys");
  assert.ok(surveys);
  assert.equal(surveys.keyColumns?.[0], "id");
  assert.equal(surveys.fields.id?.type, "string");
  assert.equal(surveys.fields.created_at?.type, "timestamp");

  const responses = resolvePosthogEntitySchema("survey_responses");
  assert.ok(responses);
  assert.equal(responses.fields.survey_id?.type, "string");
  assert.equal(responses.fields.submitted_at?.type, "timestamp");

  assert.equal(resolvePosthogEntitySchema("events_7d"), null);
}

function testIncrementalCapabilitiesPerEntity() {
  const connector = createConnector();
  const caps = connector.getIncrementalCapabilities();
  assert.equal(caps.supported, true);
  assert.equal(caps.mode, "native");
  assert.equal(caps.anchorField, "$since");
  assert.equal(caps.perEntity?.surveys?.mode, "created-anchor");
  assert.equal(caps.perEntity?.survey_responses?.mode, "native");
  assert.equal(caps.perEntity?.survey_responses?.anchorField, "since");
}

function testTransferQueriesOptional() {
  const schema = PosthogConnector.getConfigSchema() as {
    transferQueries?: { required?: boolean };
  };
  assert.equal(schema.transferQueries?.required, false);
}

async function testFetchSurveysChunkPaginatesAndFiltersSince() {
  const connector = createConnector();
  const client = (connector as any).getHttpClient();
  const calls: Array<{ url: string; params: Record<string, unknown> }> = [];

  const originalGet = client.get.bind(client);
  client.get = async (
    url: string,
    config?: { params?: Record<string, unknown> },
  ) => {
    calls.push({ url, params: config?.params || {} });
    if (calls.length === 1) {
      return {
        data: {
          count: 3,
          next: "https://us.posthog.com/api/projects/12345/surveys/?offset=2",
          results: [
            {
              id: "s1",
              name: "Old",
              created_at: "2020-01-01T00:00:00Z",
            },
            {
              id: "s2",
              name: "New",
              created_at: "2026-01-15T00:00:00Z",
            },
          ],
        },
      };
    }
    return {
      data: {
        count: 3,
        next: null,
        results: [
          {
            id: "s3",
            name: "Newest",
            created_at: "2026-06-01T00:00:00Z",
          },
        ],
      },
    };
  };

  try {
    const batches: unknown[][] = [];
    const since = new Date("2026-01-01T00:00:00Z");
    const state = await connector.fetchEntityChunk({
      entity: "surveys",
      since,
      maxIterations: 10,
      batchSize: 2,
      rateLimitDelay: 0,
      onBatch: async rows => {
        batches.push(rows);
      },
    });

    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.includes("/api/projects/12345/surveys/"));
    assert.equal(calls[0].params.limit, 2);
    assert.equal(calls[0].params.offset, 0);
    assert.equal(calls[1].params.offset, 2);

    // First page: only s2 passes since filter; second page: s3
    assert.equal(batches.length, 2);
    assert.equal((batches[0][0] as { id: string }).id, "s2");
    assert.equal((batches[1][0] as { id: string }).id, "s3");
    assert.equal(state.hasMore, false);
    assert.equal(state.totalProcessed, 2);
  } finally {
    client.get = originalGet;
  }
}

async function testFetchSurveyResponsesNestsAndAppliesSince() {
  const connector = createConnector();
  const client = (connector as any).getHttpClient();
  const calls: Array<{ url: string; params: Record<string, unknown> }> = [];

  client.get = async (
    url: string,
    config?: { params?: Record<string, unknown> },
  ) => {
    calls.push({ url, params: config?.params || {} });

    if (url.includes("/responses/")) {
      const surveyId = url.match(/surveys\/([^/]+)\/responses/)?.[1];
      if (surveyId === "surv-a" && config?.params?.offset === 0) {
        return {
          data: {
            results: [
              {
                uuid: "r1",
                distinct_id: "user-1",
                submitted_at: "2026-02-01T00:00:00Z",
                answers: [],
              },
            ],
            has_more: false,
          },
        };
      }
      if (surveyId === "surv-b") {
        return {
          data: {
            results: [
              {
                uuid: "r2",
                distinct_id: "user-2",
                submitted_at: "2026-03-01T00:00:00Z",
                answers: [{ question_id: "q1", answer: "yes" }],
              },
            ],
            has_more: false,
          },
        };
      }
      return { data: { results: [], has_more: false } };
    }

    // Survey list pages (limit 1)
    const offset = Number(config?.params?.offset ?? 0);
    if (offset === 0) {
      return { data: { results: [{ id: "surv-a", name: "A" }], next: "x" } };
    }
    if (offset === 1) {
      return { data: { results: [{ id: "surv-b", name: "B" }], next: null } };
    }
    return { data: { results: [], next: null } };
  };

  const batches: Array<Record<string, unknown>[]> = [];
  const since = new Date("2026-01-01T00:00:00Z");
  const state = await connector.fetchEntityChunk({
    entity: "survey_responses",
    since,
    maxIterations: 20,
    batchSize: 100,
    rateLimitDelay: 0,
    onBatch: async rows => {
      batches.push(rows as Record<string, unknown>[]);
    },
  });

  const responseCalls = calls.filter(c => c.url.includes("/responses/"));
  assert.ok(responseCalls.length >= 2);
  assert.equal(responseCalls[0].params.since, since.toISOString());
  assert.ok(responseCalls[0].url.includes("/surveys/surv-a/responses/"));
  assert.ok(responseCalls[1].url.includes("/surveys/surv-b/responses/"));

  const all = batches.flat();
  assert.equal(all.length, 2);
  assert.equal(all[0].id, "r1");
  assert.equal(all[0].survey_id, "surv-a");
  assert.equal(all[1].id, "r2");
  assert.equal(all[1].survey_id, "surv-b");
  assert.equal(state.hasMore, false);
  assert.equal(state.totalProcessed, 2);
}

async function testFetchSurveyResponsesResumesAcrossChunks() {
  const connector = createConnector();
  const client = (connector as any).getHttpClient();

  client.get = async (
    url: string,
    config?: { params?: Record<string, unknown> },
  ) => {
    if (url.includes("/responses/")) {
      return {
        data: {
          results: [
            {
              uuid: `r-${config?.params?.offset ?? 0}`,
              submitted_at: "2026-02-01T00:00:00Z",
            },
          ],
          has_more: (config?.params?.offset ?? 0) === 0,
        },
      };
    }
    const offset = Number(config?.params?.offset ?? 0);
    if (offset === 0) {
      return { data: { results: [{ id: "surv-a" }], next: null } };
    }
    return { data: { results: [], next: null } };
  };

  const first = await connector.fetchEntityChunk({
    entity: "survey_responses",
    maxIterations: 2, // pick survey + first response page
    batchSize: 1,
    rateLimitDelay: 0,
    onBatch: async () => undefined,
  });

  assert.equal(first.hasMore, true);
  assert.equal(first.metadata?.currentSurveyId, "surv-a");
  assert.equal(first.metadata?.responseOffset, 1);

  const rows: unknown[] = [];
  const second = await connector.fetchEntityChunk({
    entity: "survey_responses",
    maxIterations: 10,
    batchSize: 1,
    rateLimitDelay: 0,
    state: first,
    onBatch: async batch => {
      rows.push(...batch);
    },
  });

  assert.equal(second.hasMore, false);
  assert.ok(rows.length >= 1);
}

async function testHogqlEntityStillWorks() {
  const connector = createConnector({
    queries: [{ name: "events_7d", query: "SELECT event FROM events" }],
  });

  // Stub axios post used by executeQuery
  const client = (connector as any).getHttpClient();
  client.post = async () => ({
    data: {
      columns: ["event"],
      results: [["pageview"], ["click"]],
    },
  });

  const batches: unknown[][] = [];
  const state = await connector.fetchEntityChunk({
    entity: "events_7d",
    maxIterations: 1,
    batchSize: 10,
    rateLimitDelay: 0,
    onBatch: async rows => {
      batches.push(rows);
    },
  });

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [{ event: "pageview" }, { event: "click" }]);
  assert.equal(state.hasMore, false);
}

async function main() {
  testConfigValidationRequiresProjectAndKey();
  testBuiltinEntitiesAlwaysAvailable();
  testEntityMetadataIncludesSurveys();
  testSchemaResolution();
  testIncrementalCapabilitiesPerEntity();
  testTransferQueriesOptional();
  await testFetchSurveysChunkPaginatesAndFiltersSince();
  await testFetchSurveyResponsesNestsAndAppliesSince();
  await testFetchSurveyResponsesResumesAcrossChunks();
  await testHogqlEntityStillWorks();
}

main().catch((error: unknown) => {
  throw error;
});
