---
title: SaaS Sync (Connectors)
description: Pull data from SaaS tools like Stripe, Close CRM, Claap, Calendly, PandaDoc, PostHog, Wise, and more into your data warehouse.
---

:::caution[Experimental]
Connectors and data sync are experimental features under active development. The API and behavior may change.
:::

Connectors pull data from external services and sync it into your connected databases. This lets you query third-party data with SQL alongside your own data.

:::note[Vocabulary]
A **connector** is code: the thing that knows how to check a credential and read entities — Mako's built-ins below, or one your workspace ships under `connectors/<slug>/`. A **connection** is a credential your workspace configured with a connector. Connections come in two kinds: a *database* connection (BigQuery, Postgres, MongoDB, …) that Mako queries and that flows write to, and a *source* connection (a Stripe key, a Close account, …) that flows read from. The agent tools follow the same words: `list_connectors` is the catalog of code, `list_connections` is what is configured, of both kinds.
:::

## Available Connectors

| Connector     | Source          | Entities                                                                         |
| ------------- | --------------- | -------------------------------------------------------------------------------- |
| **Stripe**    | Stripe API      | Customers, Subscriptions, Disputes, Charges, Invoices, Products, Prices, Plans, Payment Intents. *Supports backfill and CDC webhooks (auto-provisioning via Stripe webhook endpoints).* |
| **Close CRM** | Close API       | Leads, Opportunities, Activities (10+ sub-types), Contacts, Users, Custom Fields. *Webhooks are automatically scoped to synced entities only.* |
| **Claap**     | Claap API       | Recordings, Workspace. *Supports backfill and CDC webhooks (auto-provisioning via "Create in Claap").* |
| **Calendly**  | Calendly API    | Organizations, Users, Groups, Event Types, Scheduled Events, Invitees, Contacts. *Real-time invitee + event-type webhooks (auto-provisioned); scheduled backfill covers the rest.* |
| **PandaDoc**  | PandaDoc API    | Documents, Templates, Contacts, Members. *Document + template webhooks (CDC, auto-provisioned); scheduled backfill covers contacts and members. Documents are hydrated with full detail (fields, tokens, pricing, products, recipients) during backfill.* |
| **Wise**      | Wise API        | Profiles, Balances, Balance Updates, Transfers, Recipients, Activities. *CDC webhooks verified with Wise's RSA-SHA256 public keys; auto-provisioning is not possible with personal API tokens — subscribe the Mako webhook URL manually in the Wise Developer Hub. Transfer polls only see newly created transfers; status changes arrive via webhooks.* |
| **PostHog**   | PostHog API + HogQL | Surveys, Survey Responses, Feature Flags, Experiments, Annotations — plus dynamic HogQL query entities |
| **GraphQL**   | Any GraphQL API | Dynamic — each configured query becomes an entity                                |
| **BigQuery**  | Google BigQuery | Dynamic — each configured query becomes an entity                                |
| **REST**      | Any REST API    | Configurable endpoints                                                           |

## How It Works

1. **Configure** — Add a source connection with API credentials and select which entities to sync
2. **Map** — Choose a destination database and table naming convention
3. **Sync** — Connectors fetch data in chunks with cursor-based pagination
4. **Resume** — If a sync fails, it resumes from the last saved cursor (idempotent upserts)

## Probing a Connection Live

A connector is defined once — check, entities, read — and a flow is only one of the things that can drive a connection made with it. The **live probe** runs a configured source connection, with the credential Mako holds, directly against its platform: the credential check, then one bounded page of an entity, written nowhere. Use it to confirm a new key works, to see the real shape of an entity before writing a flow, or to look at a platform's data before a flow lands it in the warehouse.

Three surfaces, one implementation, so they cannot drift on what "bounded", "read-only" and "no credential in the result" mean:

| Surface | How |
| --- | --- |
| MCP (any agent, or the in-product agent) | `probe_connection({ connectionId, entity?, limit?, fields?, since? })` — ids from `list_connections`, entity names from `inspect_connection` |
| CLI | `mako connection probe <id\|name> [--entity <name>] [--limit <n>] [--fields a,b] [--since <iso>] [--json]` |
| REST | `POST /api/workspaces/:wid/connections/sources/:id/probe` (legacy alias: `POST /api/workspaces/:wid/connectors/:id/probe`) with the same body fields |

The result carries the check outcome, then `entity.records`, `entity.schema` (declared field types), `entity.hasMore` (further pages exist on the platform), `entity.truncated` (the page held more than `limit`) and the connector's own log lines. Limits: at most `limit` records (default 20, max 200) from a single API page, and a 90-second budget for the whole probe — a connection whose connector is [workspace-authored](/guides/building-connectors/) runs in a sandbox, so its first probe can take tens of seconds. Every string value of the connection's config is scrubbed from the result, including from a vendor error that would echo the key back.

Nothing is written: no destination table, no sync cursor. The one side effect is the same one **Test connection** has — a workspace source connection's last-check mark, which is what moves its connector to *verified*.

## Building Custom Connectors

See the [Building Connectors](/guides/building-connectors/) guide for implementing new connectors.

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

Source connections are configured per-workspace through the UI or API. Credentials are encrypted at rest using the `ENCRYPTION_KEY` environment variable.
