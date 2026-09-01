# Data Source Connectors

This directory contains the connector architecture for integrating various data sources into the platform.

## Architecture Overview

The connector system is designed to be extensible, allowing easy addition of new data source types. Each connector implements a common interface defined in `BaseConnector`.

### Directory Structure

```
connectors/
├── base/
│   └── BaseConnector.ts     # Abstract base class for all connectors
├── stripe/
├── close/
├── claap/
├── calendly/
├── pandadoc/
├── wise/
├── posthog/
├── graphql/
├── bigquery/
├── rest/
├── registry.ts              # Runtime connector discovery for the API server
└── README.md               # This file
```

Each connector directory follows the same shape: `connector.ts` (implementation),
`index.ts` (exports the `XxxConnector` class), `icon.svg`, and usually
`connector.test.ts` + `schema.ts` for typed entity schemas.

## Creating a New Connector

To add support for a new data source type:

1. Create a new directory for your connector (e.g., `salesforce/`)
2. Create a connector class that extends `BaseConnector`
3. Add an `index.ts` file to export your connector
4. Include an `icon.svg` file for the web interface
5. The connector will be discovered by the runtime registry used by the API or lazily loaded by the sync registry.

### Example Connector Implementation

```typescript
import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
} from "../base/BaseConnector";

export class MyConnector extends BaseConnector {
  getMetadata() {
    return {
      name: "My Data Source",
      version: "1.0.0",
      description: "Connector for My Data Source",
      supportedEntities: ["entity1", "entity2"],
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    // Implement connection test logic
    return {
      success: true,
      message: "Connection successful",
    };
  }

  getAvailableEntities(): string[] {
    return ["entity1", "entity2"];
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    const { entity, onBatch, onProgress, since } = options;

    // Implement data fetching logic
    // Call onBatch with each batch of records
    // Call onProgress to update progress
  }
}
```

### Connector Discovery

There are two registries:

- API runtime registry: scans subdirectories and dynamically imports connectors at runtime (`connectors/registry.ts`).
- Sync CLI registry: lazily imports connectors when needed (`sync/connector-registry.ts`).

Naming conventions are simplified; each connector exports a class named `XxxConnector` from its `index.ts`.

## Configuration

Data sources are stored in the database with encrypted credentials. Each data source has:

- **config**: Connection configuration (API keys, endpoints, etc.)
- **settings**: Sync settings (batch size, rate limits, etc.)
- **targetDatabases**: Target databases for syncing data

## Security

All sensitive configuration data (API keys, passwords, etc.) is encrypted before storage using AES-256-CBC encryption. The encryption key must be set in the `ENCRYPTION_KEY` environment variable.

## Available Connectors

See the [SaaS Connectors](/connectors/) docs page for the full, up-to-date
table of connectors and entities. Summary:

### Stripe

- Syncs payment data from Stripe
- Supported entities: customers, subscriptions, disputes, charges, invoices, products, prices, plans, payment intents
- Required config: `api_key`
- Supports backfill and CDC webhooks (auto-provisioning)

### Close

- Syncs CRM data from Close
- Supported entities: leads, opportunities, activities (10+ sub-types), contacts, users, custom_fields
- Required config: `api_key`

### Claap, Calendly, PandaDoc

- Fixed-entity connectors with backfill + CDC webhook support (auto-provisioned where the provider allows it)

### Wise

- Syncs Wise (TransferWise) financial data
- Supported entities: profiles, balances, balance_updates, transfers, recipients, activities
- Required config: `api_key` (personal API token); optional `profile_id`, `api_base_url` (sandbox)
- Webhooks verified with Wise's RSA-SHA256 public keys; provisioning is manual (personal tokens can't create subscriptions — register the webhook URL in the Wise Developer Hub)

### PostHog

- Hybrid connector: built-in REST entities (surveys, survey_responses, feature_flags, experiments, annotations) plus dynamic HogQL query entities configured on the Flow
- Required config: `project_id`, `api_key`

### GraphQL

- Generic GraphQL API connector
- Supports custom queries with offset or cursor pagination
- Required config: `endpoint`, `queries` (configured on the Flow, not the connector)

### Google Cloud Storage (`gcs`)

Import CSV files from a GCS bucket. Credentials (service account + bucket) live
on the data source; folder prefixes live on the flow via `transferQueries`.

- Sync discovers objects under a prefix matching a glob (default `*.csv`)
- Incremental runs only process objects with `updated > since` (new/changed files)
- Each row is tagged with `_source_key` / `_source_generation` / `_source_updated_at`

Required config: `service_account_json`, `bucket`  
Flow folders: `name`, `prefix`, `glob`, CSV options

## Future Connectors

The architecture supports easy addition of new connectors such as:

- Salesforce
- HubSpot
- PostgreSQL/MySQL (direct database connections)
- Azure Blob / S3 file imports
- Webhooks

## Contributing

When contributing a new connector:

1. Follow the existing patterns and interfaces
2. Include comprehensive error handling
3. Implement rate limiting and retry logic where appropriate
4. Add tests for your connector
5. Update this README with connector details
