---
name: add-connector
description: Scaffold a new data source connector for the Mako sync system with backfill, CDC webhooks, tests, and deployment checks. Use when creating a new connector, adding a data source integration, or implementing a new sync provider.
---

# Add a New Data Source Connector

## Overview

Connectors are pluggable, self-contained integrations under `api/src/connectors/<type>/`. They extend `BaseConnector` and are auto-discovered by the registry. For production CDC flows, follow the **Close** reference implementation (`api/src/connectors/close/`) — not the minimal Stripe stub alone.

## Checklist

```
- [ ] Create api/src/connectors/<name>/ (connector.ts, schema.ts, index.ts, icon.svg)
- [ ] Implement getConfigSchema() — credentials only; wire every field at runtime
- [ ] Implement supportsResumableFetching + fetchEntityChunk (required for Inngest CDC backfill)
- [ ] Implement supportsWebhooks + verifyWebhook + getWebhookEventMapping + extractWebhookData
- [ ] Optional: resolveSchema() + schema.ts for typed CDC / schema-health
- [ ] Add connector.test.ts (mocked HTTP/webhooks; no committed secrets)
- [ ] pnpm --filter api run lint && tsx api/src/connectors/<name>/connector.test.ts
- [ ] Manual: data source → CDC webhook flow → backfill → live webhook
```

## Directory layout

```bash
mkdir -p api/src/connectors/<name>
```

```
api/src/connectors/<name>/
├── connector.ts      # Main class *Connector extends BaseConnector
├── schema.ts         # resolve<Entity>Schema + ConnectorEntitySchema maps
├── index.ts          # export { XxxConnector } from "./connector"
├── connector.test.ts # node assert tests (see close/connector.test.ts)
└── icon.svg          # optional; copied by api build
```

Registry auto-discovers `*Connector` in `connector.ts` or `index.ts` — no manual registration.

## Config schema (credentials only)

```typescript
static getConfigSchema() {
  return {
    fields: [
      {
        name: "api_key",
        label: "API Key",
        type: "password",
        required: true,
        helperText: "Provider API key",
      },
      {
        name: "api_base_url",
        label: "API Base URL",
        type: "string",
        required: false,
        default: "https://api.example.com",
      },
    ],
  };
}
```

- **Do not** put webhook secrets in connector config. Webhook verification uses `flow.webhookConfig.secret` passed into `verifyWebhook({ secret })` when Claap/Stripe/Close deliver events.
- Query-based connectors: use `transferQueries` at **Flow** level, not in connector config.

## Required methods

| Method | Purpose |
|--------|---------|
| `testConnection()` | Validate credentials (lightweight GET) |
| `getAvailableEntities()` / `getEntityMetadata()` | Entity list + optional layout hints |
| `fetchEntity()` | Full sync fallback |
| `fetchEntityChunk()` + `supportsResumableFetching(): true` | **Required** for Inngest chunked CDC backfill |
| `validateConfig()` | Provider-specific required fields |

## Resumable backfill pattern

`performSyncChunk` in `api/src/sync/sync-orchestrator.ts` **requires** `supportsResumableFetching()`. Without `fetchEntityChunk`, CDC backfill fails.

```typescript
async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
  const { entity, onBatch, onProgress, since, state } = options;
  const maxIterations = options.maxIterations ?? 10;
  let cursor = state?.metadata?.cursor as string | undefined;
  let recordCount = state?.totalProcessed ?? 0;
  let iterations = 0;

  while (iterations < maxIterations) {
    const page = await this.fetchPage(entity, { cursor, since });
    if (page.records.length > 0) {
      await onBatch(page.records);
      recordCount += page.records.length;
      onProgress?.(recordCount, page.totalCount);
    }
    cursor = page.nextCursor;
    iterations++;
    if (!cursor) {
      return {
        totalProcessed: recordCount,
        hasMore: false,
        iterationsInChunk: iterations,
        metadata: { cursor: null },
      };
    }
    await this.sleep(this.getRateLimitDelay());
  }

  return {
    totalProcessed: recordCount,
    hasMore: true,
    iterationsInChunk: iterations,
    metadata: { cursor },
  };
}
```

- Store pagination cursor in `FetchState.metadata` (not only top-level `cursor` unless your API matches).
- Support `since` → provider incremental filter (`createdAfter`, `date_updated__gte`, etc.).
- Handle **429** / **5xx**: respect `Retry-After`, exponential backoff; do not log auth headers.

## Webhooks + CDC

| Method | Production use |
|--------|----------------|
| `supportsWebhooks()` | Gate in `api/src/routes/webhooks.ts` |
| `verifyWebhook()` | Signature/secret check; return parsed event |
| `getWebhookEventMapping()` | Map `eventType` → `{ entity, operation }` |
| `extractWebhookData()` | `{ id, data }` for CDC ingest |
| `normalizeBackfillRecord()` | Align webhook payload with backfill shape when they differ |
| `extractWebhookCdcRecords()` | Override for tests; production uses mapping + extract |

**Webhook callback URL** (generated per flow):

```
{BASE_URL}/api/webhooks/{workspaceId}/{flowId}
```

- Local dev: `pnpm dev:tunnel` and set `BASE_URL` / `PUBLIC_URL` to the public HTTPS tunnel origin.
- Register that URL in the provider; paste provider webhook secret into the **Mako flow** webhook secret field.

**Normalize event type for Mako:** `webhooks.ts` sets `eventType` from `event.type` first. If the provider nests type (e.g. Claap `event.event.type`), flatten in `verifyWebhook`:

```typescript
return {
  valid: true,
  event: {
    ...parsed,
    type: parsed.event?.type ?? parsed.type,
    id: parsed.eventId ?? parsed.id,
  },
};
```

Claap verifies `X-Claap-Webhook-Secret` against `flow.webhookConfig.secret` (shared secret header, not HMAC).

Auto-provisioning (`createWebhookSubscription`) is optional — only if the provider API supports it (Close does; Claap is manual).

## Typed schema (recommended)

Add `schema.ts` with `ConnectorEntitySchema` per entity + `resolveSchema(entity)`:

- Include `MAKO_SYSTEM_FIELDS` from `BaseConnector`.
- `unknownFieldPolicy: "string"` for forward-compatible APIs.
- `getEntityMetadata()` may set `layoutSuggestion: { partitionField: "createdAt", partitionGranularity: "day", clusterFields: ["_dataSourceId", "id"] }`.

Used by sync orchestrator (`normalizePayloadBySchema`), CDC consumer, and `GET .../flows/:flowId/schema`.

## Tests

Mirror `api/src/connectors/close/connector.test.ts`:

```bash
tsx api/src/connectors/<name>/connector.test.ts
```

Cover: config validation, webhook verify pass/fail, event mapping, `extractWebhookData`, CDC record shape, schema resolution, pagination state — all with **mocked** HTTP (no real API keys in repo).

## Verify before PR

```bash
pnpm --filter api run lint
tsx api/src/connectors/<name>/connector.test.ts
pnpm run lint:all   # includes connector-agnosticism check
```

Live smoke (credentials in UI/env only, never commit):

1. Create data source with API key → Test connection
2. CDC flow (`syncEngine: cdc`) + warehouse destination → enable `recordings` (or your entities)
3. Backfill one entity → confirm rows in destination
4. Register webhook URL in provider; set flow webhook secret → trigger event → `webhookConfig.lastReceivedAt` updates within ~2 min (CDC cron ingest)

## Reference files

- Base: `api/src/connectors/base/BaseConnector.ts`
- Registry: `api/src/connectors/registry.ts`
- Complex reference: `api/src/connectors/close/connector.ts`, `close/schema.ts`, `close/connector.test.ts`
- Simple reference: `api/src/connectors/stripe/connector.ts`
- Webhook route: `api/src/routes/webhooks.ts`
- Endpoint helper: `api/src/utils/webhook.utils.ts`
- Rules: `.cursor/rules/15-connector-agnostic.mdc`

## Rules

- 100% self-contained under `api/src/connectors/<type>/` — no `if (type === "<name>")` outside that folder.
- UI is schema-driven; no app changes for new connectors.
- Every `getConfigSchema()` field must be read in the connector client.
