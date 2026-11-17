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

- `state.mako.since`: on an incremental sync, the time to read from (ISO
  8601). Mako puts it in the stream state next to whatever the connector
  keeps there, on every chunk of the run, so the connector need not carry it
  forward. The `mako` key is reserved for Mako. Declare `incremental` on the
  entity to say how it is used.
- `config.__page_size` and `config.__rate_limit_delay_ms`: the connection's
  batch size and rate-limit delay, when it sets them. Like `__http`, these
  `__` keys come from Mako, never from the credential form.
- `--max-bytes`: a chunk ends after the page that takes its records past this
  many bytes, as it ends after `--max-iterations` pages. A page is never
  split, so a single page must fit Mako's 32 MiB chunk cap.
- `--session` (with `--since`): one process reads the whole entity, chunk
  after chunk, each chunk ending in its STATE as a separate process would.
  It first prints a `MAKO_SESSION` line once its inputs are read. Each chunk
  restarts `read` from the previous chunk's state, so a connector reads the
  same pages either way. Nothing changes for the connector author.

## Webhooks

A connector may handle its vendor's webhooks. Mako receives every delivery
and checks its signature in its own API, with the flow's signing secret. The
secret never reaches the connector. So the connector declares the vendor's
scheme as data, and Mako runs it:

```ts
webhooks: {
  verification: {
    scheme: "hmac-sha256",
    secretEncoding: "hex", // or "base64", "utf8"
    signedPayload: ["header:close-sig-timestamp", "body"], // or "literal:."
    signatureHeader: "close-sig-hash",
    signatureEncoding: "hex", // or "base64"
    // signaturePrefix: "sha256=",
    timestampHeader: "close-sig-timestamp", // Unix seconds; refuses replays
    toleranceSeconds: 300,
  },
  events: ["lead.updated" /* ... */],
  async handleBatch(ctx, events) {
    return events.map(e => ({ eventId: e.eventId, outcome: "unmapped" }));
  },
},
```

Stripe signs differently: one header carries `t=<unix seconds>` and one or
more `v1=<hex>`, each an HMAC-SHA256 of `<t>.<raw body>`. Declare it as
`stripe-v1`. The signed bytes are fixed by the scheme, and the timestamp is
always signed:

```ts
verification: {
  scheme: "stripe-v1",
  signatureHeader: "stripe-signature",
  secretEncoding: "utf8", // the whole `whsec_...` string is the key
  toleranceSeconds: 300,
},
```

Two more shapes for vendors that fit neither:

- A signature in a query parameter (PandaDoc's `?signature=`): add
  `signatureQuery: "signature"`. Mako reads it first, the header second.
- No signature at all, the secret itself in a header (Claap):
  `verification: { scheme: "shared-secret", secretHeader: "x-claap-webhook-secret" }`.
  Mako compares it in constant time and refuses a secret under 16 bytes.

Mako dedupes deliveries on their event id. Say where it sits with
`eventIdPath` (a dotted path into the JSON body, `"eventId"`, `"event.id"`)
and where the type sits with `eventTypePath` (`"event.type"`, `"0.event"`).
Without an id, Mako keys a delivery on a SHA-1 of its raw body.

Mako stores verified deliveries and hands them to `handleBatch` in batches
(`mako-connector webhook --config config.json --batch batch.json`), with
the connection's credential in `ctx.config`. Return one outcome per event,
in order. Its third argument holds `enabledEntities`, the entities the flow
syncs, when Mako sends them, so a handler can skip work whose records would
be dropped:

- `records`: the change records, `{ entity, recordId, operation, payload,
  sourceTs?, changeId? }`. `payload` must be the whole row, as `read` emits
  it: a missing column is written as NULL. When a vendor sends a partial
  object, re-fetch the row by id with `ctx`.
- `unmapped`: an event type the connector does not handle.
- `skipped`: nothing to write on purpose, with a `reason`.
- `extract_failed`: a handled type whose payload yielded nothing, or whose
  fill failed. Mako retries it, up to 5 attempts.
- `deferred`: not now, for example a request budget is spent. Mako retries
  it later without counting the attempt.

Mako drops records for undeclared entities, stamps `_dataSourceId` and
`_syncedAt`, applies the flow's entity selection and writes the rest.

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

A read may end its chunk early: return after a batch with `hasMore: true`
(a per-chunk cap of its own, a quota checkpoint). The next chunk starts from
that batch's state, which must have moved.

Every batch returned by `read` includes `hasMore`. This lets Mako distinguish
the final page from a stream paused exactly at its chunk limit. The pagination
helper calculates it; manual pagination should set it from the vendor's next
cursor or equivalent response field.
