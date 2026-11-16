# @makoai/connector-sdk

Write a Mako connector: `check`, `discover` and `read`, with HTTP retries and
pagination handled.

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

Alongside it, a `connector.yaml` — the only file Mako reads without running
anything:

```yaml
runtime: node
entry: connector.ts # optional; this is the default
```

Push `connectors/<slug>/` to your workspace repo's default branch and Mako
indexes it: it runs `spec`, captures the credential form, and offers the
connector in the picker. Test it first with `npx @makoai/cli connector test
connectors/<slug>`. A connector is code; a *connection* is a credential a
workspace configures with it. Once a connection exists (a credential entered
in the UI), `npx @makoai/cli connection probe <name> --entity <entity>` runs
it live against the platform — the check plus one bounded page, written
nowhere — and the same probe is the `probe_connection` MCP tool and
`POST /connectors/:id/probe`, so a flow is not the only thing that can ever
drive it.

## What Mako passes to `read`

- `state.since`: on an incremental sync, the time to read from (ISO 8601). It
  sits in the stream state next to whatever the connector keeps there, on
  every chunk. Carry it forward or ignore it. Declare `incremental` on the
  entity to say how it is used.
- `config.__page_size` and `config.__rate_limit_delay_ms`: the connection's
  batch size and rate-limit delay, when it sets them. Like `__http`, these
  `__` keys come from Mako, never from the credential form.
- `--max-bytes`: a chunk ends after the page that takes its records past this
  many bytes, as it ends after `--max-iterations` pages. A page is never
  split, so a single page must fit Mako's 32 MiB chunk cap.

## `config.properties` is not optional

Declare `config: { properties: { ... } }` even when the connector needs no
credential (`properties: {}` is fine). That object is the list Mako encrypts
by: a spec that omits it is refused at push time, because an absent field list
cannot be told apart from one that failed to parse, and guessing would store a
customer's API key in plaintext. Mark every secret `airbyte_secret: true`.

## Dependencies

A workspace connector may import npm packages. Commit `package.json` and
`package-lock.json` in its folder, never `node_modules/`. Mako installs the
lockfile and bundles the connector into one file per source hash on push, with
this SDK left as an import the sandbox provides (behind
`CONNECTOR_BUNDLES_ENABLED` while it rolls out). A connector without
`package.json` needs no build.

## Node 22.6 or newer

A connector is TypeScript and is imported with no build step, so the Node that
runs it has to strip types: unflagged from 22.18, and from 22.6 with
`--experimental-strip-types` (which the runner adds for itself). On anything
older the runner refuses with a message saying so rather than failing as an
unknown file extension. Mako's own sandbox satisfies this; a laptop running
`mako connector test` needs it too.

Every batch returned by `read` includes `hasMore`. This lets Mako distinguish
the final page from a stream paused exactly at its chunk limit. The pagination
helper calculates it; manual pagination should set it from the vendor's next
cursor or equivalent response field.
