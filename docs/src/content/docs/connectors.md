---
title: Connectors
description: Sync data from external services into your databases.
---

:::caution[Experimental]
Connectors and data sync are experimental features under active development. The API and behavior may change.
:::

Connectors pull data from external services (Stripe, Close CRM, PostHog, REST APIs) and sync it into your connected databases. This lets you query third-party data with SQL alongside your own data.

## Available Connectors

| Connector | Source | Entities |
|---|---|---|
| **Stripe** | Stripe API | Customers, Subscriptions, Invoices, Charges, Products, Prices |
| **PostHog** | PostHog API | Events, Persons, Groups |
| **Close CRM** | Close API | Leads, Contacts, Activities, Opportunities |
| **REST** | Any REST API | Configurable endpoints |

## How It Works

1. **Configure** — Add a connector with API credentials and select which entities to sync
2. **Map** — Choose a destination database and table naming convention
3. **Sync** — Connectors fetch data in chunks with cursor-based pagination
4. **Resume** — If a sync fails, it resumes from the last saved cursor (idempotent upserts)

## Building Custom Connectors

See the [Building Connectors](/guides/building-connectors/) guide for implementing new data sources.

Each connector implements:

```typescript
interface Connector {
  fetchEntityChunk(entity: string, cursor?: string): Promise<{
    records: Record<string, any>[];
    nextCursor?: string;
    hasMore: boolean;
  }>;
  getEntities(): string[];
  getSchema(entity: string): SchemaDefinition;
}
```

## Configuration

Connectors are configured per-workspace through the UI or API. Credentials are encrypted at rest using the `ENCRYPTION_KEY` environment variable.
