---
title: SaaS Sync (Connectors)
description: Pull data from SaaS tools like Stripe, PostHog, Close CRM, and more into your data warehouse.
---

:::caution[Experimental]
Connectors and data sync are experimental features under active development. The API and behavior may change.
:::

Connectors pull data from external services and sync it into your connected databases. This lets you query third-party data with SQL alongside your own data.

## Available Connectors

| Connector     | Source          | Entities                                                                         |
| ------------- | --------------- | -------------------------------------------------------------------------------- |
| **Stripe**    | Stripe API      | Customers, Subscriptions, Charges, Invoices, Products, Plans                     |
| **Close CRM** | Close API       | Leads, Opportunities, Activities (10+ sub-types), Contacts, Users, Custom Fields |
| **PostHog**   | PostHog HogQL   | Dynamic — each configured HogQL query becomes an entity                          |
| **GraphQL**   | Any GraphQL API | Dynamic — each configured query becomes an entity                                |
| **BigQuery**  | Google BigQuery | Dynamic — each configured query becomes an entity                                |
| **REST**      | Any REST API    | Configurable endpoints                                                           |

## How It Works

1. **Configure** — Add a connector with API credentials and select which entities to sync
2. **Map** — Choose a destination database and table naming convention
3. **Sync** — Connectors fetch data in chunks with cursor-based pagination
4. **Resume** — If a sync fails, it resumes from the last saved cursor (idempotent upserts)

## Building Custom Connectors

See the [Building Connectors](/guides/building-connectors/) guide for implementing new data sources.

Each connector extends `BaseConnector` and implements:

```typescript
class MyConnector extends BaseConnector {
  // Declare available entities and their BigQuery layout hints
  getEntityMetadata(): EntityMetadata[];

  // Fetch a chunk of data with resumable state (cursor-based)
  fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState>;

  // Test connectivity
  testConnection(): Promise<ConnectionTestResult>;

  // Validate configuration
  validateConfig(): { valid: boolean; errors: string[] };
}
```

## Configuration

Connectors are configured per-workspace through the UI or API. Credentials are encrypted at rest using the `ENCRYPTION_KEY` environment variable.
