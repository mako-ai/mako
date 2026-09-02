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
connectors/<slug>`. Once it is configured in Mako (a credential entered in
the UI), `npx @makoai/cli connector probe <name> --entity <entity>` runs it
live against the platform — the check plus one bounded page, written
nowhere — and the same probe is the `probe_connector` MCP tool and
`POST /connectors/:id/probe`, so a flow is not the only thing that can ever
drive it.

## `config.properties` is not optional

Declare `config: { properties: { ... } }` even when the connector needs no
credential (`properties: {}` is fine). That object is the list Mako encrypts
by: a spec that omits it is refused at push time, because an absent field list
cannot be told apart from one that failed to parse, and guessing would store a
customer's API key in plaintext. Mark every secret `airbyte_secret: true`.

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
