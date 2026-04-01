---
name: add-connector
description: Scaffold a new data source connector for the Mako sync system. Use when creating a new connector, adding a data source integration, or implementing a new sync provider.
---

# Add a New Data Source Connector

## Overview

Connectors are pluggable, self-contained integrations under `api/src/connectors/<type>/`. They extend `BaseConnector` and are auto-discovered by the registry.

## Steps

### 1. Create the connector directory

```bash
mkdir -p api/src/connectors/<name>
```

### 2. Implement the connector class

Create `api/src/connectors/<name>/connector.ts` (the registry looks for `connector.ts` first, then `index.ts`):

```typescript
import {
  BaseConnector,
  FetchOptions,
  ConnectionTestResult,
} from "../base/BaseConnector";
import { IConnector } from "../../database/workspace-schema";

export class MySourceConnector extends BaseConnector {
  constructor(dataSource: IConnector) {
    super(dataSource);
  }

  getMetadata() {
    return {
      name: "My Source",
      version: "1.0.0",
      description: "Syncs data from My Source",
      supportedEntities: ["entity1", "entity2"],
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    // Validate credentials from this.dataSource.connection
    return { success: true, message: "Connected" };
  }

  getAvailableEntities(): string[] {
    return this.getMetadata().supportedEntities;
  }

  async fetchEntity(options: FetchOptions): Promise<void> {
    const { entityName, onBatch, onProgress, signal } = options;
    // Fetch data and call onBatch() with each batch of records
    // Respect signal for cancellation
  }

  static getConfigSchema() {
    return {
      fields: [
        { name: "apiKey", label: "API Key", type: "password", required: true },
        {
          name: "endpoint",
          label: "Endpoint URL",
          type: "string",
          required: true,
        },
      ],
      // For query-based connectors, add transferQueries (configured at Flow level):
      // transferQueries: {
      //   label: "Queries",
      //   required: true,
      //   fields: [
      //     { name: "name", label: "Entity Name", type: "string", required: true },
      //     { name: "query", label: "Query", type: "textarea", required: true, rows: 8 },
      //   ],
      // },
    };
  }
}
```

### 3. Verify auto-registration

The registry at `api/src/connectors/registry.ts` auto-discovers connectors by scanning subdirectories. It finds the first export ending with `"Connector"` in `connector.ts` or `index.ts`. No manual registration needed.

Verify by checking that `connectorRegistry.hasConnector("<name>")` returns `true` after restart.

### 4. Test the connector

1. Start the dev server: `pnpm dev`
2. Create a data source in the UI with the new connector type
3. Verify the config schema renders correctly (schema-driven, no UI changes needed)
4. Create a Flow using the new data source and test sync

## Key Rules

- Connector must be **100% self-contained** under its folder. No `if (type === "<name>")` checks in shared code.
- Credential/connection fields go in `getConfigSchema()`. Query definitions go at the **Flow level** via `transferQueries`.
- UI is **schema-driven** — the frontend reads the schema and renders forms dynamically.
- Support both full and incremental sync modes where applicable.
- Use `this.dataSource.connection` to access stored (decrypted) credentials.

## Reference Files

- Base class: `api/src/connectors/base/BaseConnector.ts`
- Registry: `api/src/connectors/registry.ts`
- Existing example: `api/src/connectors/stripe/connector.ts`
- Schema rules: `.cursor/rules/15-connector-agnostic.mdc`
