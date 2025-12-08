---
title: Building Connectors
description: Learn how to create a new data connector.
---

Connectors allow Mako to ingest data from external sources. This guide walks you through creating a new connector.

## Key Principle: Separation of Concerns

- **Connectors** store only credentials and connection settings (endpoint, API keys, auth headers).
- **Flows** define what data to sync:
  - For connectors with fixed entities (Stripe, Close): use `entityFilter`
  - For query-based connectors (GraphQL, PostHog): use `queries` array on the flow

This separation allows reusing the same connector credentials for multiple transfers with different data configurations.

## Structure

Connectors live in `api/src/connectors/<source-name>`. Each connector must have:

1.  `connector.ts`: The implementation extending `BaseConnector`.
2.  `index.ts`: Exports the connector and metadata.
3.  `icon.svg`: A visual icon for the UI.

## Step-by-Step Implementation

### 1. Create the Connector Class

Create `api/src/connectors/my-service/connector.ts`:

```typescript
import {
  BaseConnector,
  FetchOptions,
  FetchState,
  ResumableFetchOptions,
} from "../base/BaseConnector";

export class MyServiceConnector extends BaseConnector {
  // 1. Define Metadata
  getMetadata() {
    return {
      name: "My Service",
      version: "1.0.0",
      description: "Integration with My Service API",
      supportedEntities: ["users", "orders"],
    };
  }

  // 2. Implement Connection Test
  async testConnection() {
    try {
      await this.client.ping(); // Your API call
      return { success: true, message: "Connected successfully" };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  // 3. Implement Chunked Fetching
  async fetchEntityChunk(options: ResumableFetchOptions): Promise<FetchState> {
    const { entity, state } = options;
    const page = state?.page || 1;

    // Fetch data from your API
    const response = await this.client.getUsers({ page });

    // Process and save batch
    await options.onBatch(response.data);

    // Return new state
    return {
      totalProcessed: (state?.totalProcessed || 0) + response.data.length,
      hasMore: response.hasMore,
      page: page + 1,
      iterationsInChunk: (state?.iterationsInChunk || 0) + 1,
    };
  }

  // 4. Enable Resumable Fetching
  supportsResumableFetching() {
    return true;
  }
}
```

### 2. Register the Connector

Add your connector to `api/src/connectors/registry.ts`:

```typescript
import { MyServiceConnector } from "./my-service";

// ... existing registrations
export const connectorRegistry = {
  // ...
  "my-service": MyServiceConnector,
};
```

## Best Practices

- **Idempotency**: Ensure that running the sync twice for the same data doesn't create duplicates. Use `upsert` operations in the destination.
- **Rate Limiting**: Respect the API limits of the source. Use `this.sleep()` if necessary.
- **Typing**: Define interfaces for the API responses you expect.
