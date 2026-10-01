---
title: Building Connectors
description: Learn how to create a new data connector.
---

Connectors allow Mako to ingest data from external sources. This guide walks you through creating a new connector.

## Key Principle: Separation of Concerns

- **Connections** store only credentials and connection settings (endpoint, API keys, auth headers). A **connector** is the code that uses them.
- **Flows** define what data to sync:
  - For connectors with fixed entities (Stripe, Close): use `entityFilter`
  - For query-based connectors (GraphQL, PostHog): use `queries` array on the flow

This separation allows reusing the same connection credentials for multiple transfers with different data configurations.

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

Nothing to edit in `registry.ts` — it auto-discovers connectors at boot by
scanning `api/src/connectors/*` for a subdirectory containing a
`connector.ts` (or `index.ts`) that exports a class ending in `Connector`.
Dropping your connector directory in place (with the `index.ts` export below)
is enough for it to register under the directory name as its `type`.

## Workspace-Authored Connectors

The connector above lives in this repo, in `api/src/connectors/`, and ships
with a Mako release. A workspace can also ship its **own** connector, from
its own repo, with no PR here at all.

### Where it lives

Put the connector in `connectors/<slug>/` in your workspace repo and push to
the default branch. Mako indexes it automatically: it runs `spec`, builds the
credential form from the result, and offers the connector in the picker.
Nothing about the engine changes to support this — it cannot tell whether a
connector is a class in `api/src` or a folder it runs in a sandbox.

Each connector folder needs:

- `connector.yaml` — the only file Mako reads without running anything:

  ```yaml
  runtime: node
  entry: connector.ts # optional; this is the default
  ```

  Today `runtime` must be `node`. `entry` defaults to `connector.ts`.

- The connector code itself (`connector.ts` by default), written against
  `@makoai/connector-sdk`:

  ```ts
  // connectors/acme/connector.ts
  import { defineConnector } from "@makoai/connector-sdk";

  export default defineConnector({
    name: "acme",
    version: "1.0.0",
    config: {
      required: ["apiKey"],
      properties: {
        apiKey: { type: "string", title: "API key", airbyte_secret: true },
      },
    },
    check: async ctx => {
      await ctx.http.get("https://api.acme.com/v1/me", {
        headers: { Authorization: `Bearer ${ctx.config.apiKey}` },
      });
      return true;
    },
    entities: {
      widgets: {
        primaryKey: ["id"],
        cursorField: "updated_at",
        schema: { id: "string", name: "string", updated_at: "timestamp" },
        async *read(ctx, state) {
          for await (const page of ctx.paginate(/* ... */)) {
            yield {
              records: page.records,
              state: { cursor: page.cursor },
              hasMore: page.hasMore,
            };
          }
        },
      },
    },
  });
  ```

  `check`, `discover` and a per-entity `read` generator are the whole
  contract. The SDK handles HTTP retries (respecting `Retry-After`) and the
  pagination shapes most REST APIs use, and speaks Airbyte's JSON-Lines
  protocol underneath so a future runtime is a runtime, not a translator.

  `config.properties` is not optional, even for a connector that needs no
  credential (`properties: {}` is fine). It is the field list Mako encrypts
  by — an omitted list is refused at push time rather than guessed at, because
  guessing risks storing a customer's API key in plaintext. Mark every secret
  field `airbyte_secret: true`.

  The runner needs Node 22.6+ to import a `.ts` connector with no build step
  (unflagged from 22.18; with `--experimental-strip-types` from 22.6). Mako's
  own sandbox satisfies this; test locally on anything older and the runner
  refuses with a message saying so.

### Test it before you push

```
npx @makoai/cli connector test connectors/<slug>
```

This runs the same four commands (`spec`, `check`, `discover`, `read`) the
engine runs, in the same order, against a local credential file — including
that a bounded `read` reports a resumable position and resuming from it does
not repeat or skip a row. Without `--config` only the offline checks run
(`spec`, the config schema, the connector's shape), which is what CI can do
without a secret.

### `indexed` vs. `verified`

A push carries no credential, so `check`, `discover` and `read` have nothing
to run against — only `spec` runs. A connector whose spec succeeds is
`indexed`: enough to appear in the picker so someone can enter a key. It only
becomes `verified` once a real connection (a credential entered in the UI)
passes a live check. A connector whose `spec` fails is `blocked`, with the
reason, and cannot back a data source.

### Where the code actually runs

A workspace connector runs in a sandbox dedicated to that workspace's syncs,
separate from anyone's session sandbox. Three things are deliberate there:

- The sandbox never clones the workspace repo. Cloning would require a
  workspace-scoped token capable of pushing back to that repo — apps, flows,
  dbt models, every other connector. The API copies the connector folder in
  instead, so the sandbox holds no Mako token at all.
- A credential is written to a per-run file and deleted in a `finally`,
  because a paused sandbox snapshots its disk and a credential must not
  persist in that snapshot.
- Only a bounded protocol stream comes back out of the sandbox — never
  unbounded output.

### Probing a live connection

Once a connection exists, `npx @makoai/cli connection probe <id|name>
[--entity <name>]` runs it live against the platform: the connector's `check`
plus one bounded page, written nowhere. The same probe backs the
`probe_connection` MCP tool and `POST /connectors/:id/probe` — a flow is not
the only thing that can drive it.

## Best Practices

- **Idempotency**: Ensure that running the sync twice for the same data doesn't create duplicates. Use `upsert` operations in the destination.
- **Rate Limiting**: Respect the API limits of the source. Use `this.sleep()` if necessary.
- **Typing**: Define interfaces for the API responses you expect.
