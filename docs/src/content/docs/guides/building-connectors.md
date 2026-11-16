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

### Dependencies

A connector may use npm packages. Put a `package.json` and a
`package-lock.json` in its folder:

```
connectors/acme/
├── connector.yaml
├── connector.ts
├── package.json        # "dependencies": { "date-fns": "4.1.0" }
└── package-lock.json   # from `npm install` in this folder
```

- **Commit the lockfile, never `node_modules/`.** Mako refuses a connector
  folder that contains `node_modules/` and says how to fix it: `git rm -r
--cached connectors/<slug>/node_modules`, add `node_modules/` to
  `.gitignore`, push. The workspace's root `.gitignore` already ignores it.
- **npm only.** Mako installs with `npm ci`, so the lockfile must be
  `package-lock.json`. A folder with `pnpm-lock.yaml` or `yarn.lock` and no
  `package-lock.json` is refused with that message.
- **Registry packages only.** Every package in `package-lock.json` must come
  from `https://registry.npmjs.org/`. A git dependency, a tarball from another
  host, or a `file:` or `link:` path is refused. So is a `.npmrc` or an
  `npm-shrinkwrap.json` in the folder.
- **Mako builds; you deploy nothing.** On push to main, Mako hashes the folder,
  its lockfile and the `@makoai/connector-sdk` version, installs the lockfile
  with `npm ci --ignore-scripts` in a build sandbox (network, no credentials,
  a fresh sandbox for every build, destroyed after it), and bundles the entry with esbuild into one file, dependencies inlined.
  The bundle is stored under that hash and runs in place of the TypeScript
  entry. The next push with the same hash reuses it.
- **Build status.** A failed build blocks the connector, with npm's or
  esbuild's message as the reason, next to `indexed` and `verified`.
  `list_connectors` and `inspect_connector` return it as `build` (`built` or
  `failed`, with `error`); `mako connector test <folder> --remote` prints it.
- `@makoai/connector-sdk` is never bundled. The sandbox provides it, at the
  version the hash was computed with.
- A folder without `package.json` runs exactly as before: no build step.

This is behind the `CONNECTOR_BUNDLES_ENABLED` flag while it is rolled out.
With the flag off, a `package.json` in the folder is just a file and only the
SDK can be imported. The `node_modules/` refusal applies with the flag off too.

### Installing a Mako connector by reference

Mako's own connectors are published to a registry, one immutable bundle per
version. A workspace installs one without copying any code: it commits a
folder holding only `connector.yaml` with a `source:` line.

```yaml
# connectors/stripe/connector.yaml
source: mako/stripe@1
```

- **The reference.** `mako/<slug>@<range>`. The range is a major (`1`), a
  minor (`1.4`), a caret (`^1.4.2`), a tilde (`~1.4.2`) or an exact version
  (`1.4.2`). `source` and `entry` are mutually exclusive.
- **Resolution.** On push, Mako picks the newest published version in the
  range, runs its `spec`, and records that version on the connector. Every
  `check`, `discover` and `read` runs the recorded version. The connection
  type is `ws:<slug>`, as for any workspace connector.
- **Upgrades.** A patch or minor release inside the range applies on the next
  push. A new major is outside the range: Mako only reports it as
  `upgradeAvailable`. To take it, change the range (`@2`) and push.
- **Agents.** `list_connectors` lists registry connectors as `mako/<slug>`
  with their versions, auth type and changelog. A connector installed by
  reference carries `registry` with the version it runs.

This is behind the `CONNECTOR_REGISTRY_ENABLED` flag while it is rolled out.
With the flag off, Mako ignores `source:`, and the folder is refused for
holding no code.

### Ejecting a connector

```
npx @makoai/cli connector eject <slug>
```

Eject turns a connector installed by reference into this workspace's own
code. It reads `connectors/<slug>/connector.yaml`, asks Mako which version the
reference resolved to, and writes that version's source into the folder.
The new `connector.yaml` names an `entry` and has no `source:`. Commit and push
the folder.

- The connector no longer upgrades. Its code is now yours to change.
- Its connections keep the type `ws:<slug>`, so flows need no edit.
- `--version <x.y.z>` ejects another published version. `--force` overwrites
  files already in the folder.
- Run `npm install` in the folder before `mako connector test` on it.

### Publishing Mako's connectors

Each top-level `connectors/<slug>/` folder of the Mako repository is a
registry connector. To release one, set the version in `defineConnector` and
`package.json`, add a `## <version>` section to its `CHANGELOG.md`, merge, and
push a tag `connector-<slug>-v<version>` on a master commit.
`.github/workflows/connector-release.yml` then builds the folder with the same
bundler workspace connectors use, runs `spec` and `discover` on the bundle,
and publishes it to the dev and production buckets. Every pull request that
touches `connectors/` runs the same steps as a dry run.

Storage layout, under `connector-registry/` in the artifact bucket:

```
connector-registry/catalog.json                 every connector and version
connector-registry/<slug>/bundles/<hash>.mjs    the built bundle
connector-registry/<slug>/sources/<hash>.json   its source files, for eject
```

`<hash>` is the bundle's source hash. A published version never changes.
Re-tagging identical content is a no-op, and different content under a
published version fails the release.

### Test it before you push

```
npx @makoai/cli connector test connectors/<slug>
```

This runs the same four commands (`spec`, `check`, `discover`, `read`) the
engine runs, in the same order, against a local credential file — including
that a bounded `read` reports a resumable position and resuming from it does
not repeat or skip a row. Without `--config` only the offline checks run
(`spec`, the config schema, the connector's shape, its dependency files),
which is what CI can do without a secret. Run `npm install` in the folder
first when it has dependencies. `--remote` also asks Mako for the connector's
indexed status and last build.

### `indexed` vs. `verified`

A push carries no credential, so `check`, `discover` and `read` have nothing
to run against — only `spec` runs. A connector whose spec succeeds is
`indexed`: enough to appear in the picker so someone can enter a key. It only
becomes `verified` once a real connection (a credential entered in the UI)
passes a live check. A connector whose `spec` fails, or whose dependencies
fail to build, is `blocked`, with the reason, and cannot back a data source.

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
