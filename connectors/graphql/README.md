# GraphQL connector folder

Any GraphQL endpoint on `@makoai/connector-sdk`, run in a box. It replaces
the in-process connector, which is deleted. Production runs it on the
`ws:graphql` connections. The golden rows in `fixtures/golden/` hold the
output the in-process connector was checked against.

## Connection

| Field      | Form                       | Notes                                                                        |
| ---------- | -------------------------- | ---------------------------------------------------------------------------- |
| `endpoint` | text, required             | `http` or `https`. A metadata name or a non-public IP is refused. |
| `headers`  | encrypted textarea, 6 rows | A JSON object of headers, e.g. `Authorization` or `x-hasura-admin-secret`.   |

`check` sends one introspection query (`__schema { queryType { name } }`).
GraphQL `errors`, a non-2xx answer or headers that are not JSON fail it.

## Entities

Each flow query is an entity (`queryEntities`, `source: "flow"`). The flow
form asks for a name, the query, `data_path` and optionally
`total_count_path`, `has_next_page_path`, `cursor_path` and `batch_size`
(100 by default). Mako puts the flow's queries in `config.queries`, as it
does in-process. A connection with no flow has no entity.

Entities are untyped: rows land as they come, with no declared schema, so
the destination types each column from its values, as in-process.

## Pagination

Chosen from the query text, as in-process:

- `$after` or `$cursor` in the query: variables `first` and `after`.
  `after` starts at `"1970-01-01"` when `$after` is a timestamp or string,
  else `0`, then follows `cursor_path`.
- Otherwise `limit` and `offset`; the offset grows by the page size.

A page has a next one when `has_next_page_path` holds a truthy value, or,
without it, when the page came back full. The page size is a probe's batch
size (`__requested_page_size`), else the query's `batch_size`, else 100.
The connection's `sync_batch_size` never applies, as in-process.

The first chunk sends the query once more with empty pages when
`total_count_path` is set, as in-process does for its progress count. A
failure there is ignored.

## Incremental

A client filter: rows whose `updated_at`, `updatedAt` or `modified_at` is
after `since` are kept; rows without one are dropped. A query that declares
`$since` also gets it as ISO 8601. Read state: `{ offset, cursor,
totalProcessed, totalCount }` and Mako's `mako.since`.

## Retries

Up to 3 retries on 429, 5xx and network errors. A 429 waits `Retry-After`
seconds, else 2^n s; others wait 500 ms × 2^n. Each request times out after
30 s. GraphQL `errors` and a response without `data` fail at once. A pause
of `__rate_limit_delay_ms` (200 ms by default) follows each page.

## Not replicated

- The folder sends through the SDK's `safeRequest`. The socket's own
  lookup checks every address a name resolves to and the connection uses
  the address it checked, as in-process, so a DNS answer that changes
  between two lookups finds no window. Only public unicast and loopback
  pass (loopback reaches only the box): private, link-local, CGNAT,
  multicast, reserved, documentation, NAT64, 6to4 over a private IPv4,
  site-local and translated IPv6 forms are blocked, and so is any
  metadata name (a trailing dot included). The response is capped at
  100 MB decompressed.
- A redirect is refused. In-process follows it, checking each hop.
- `settings.timeout_ms` and `settings.max_retries` are not read: 30 s and 3
  retries, the in-process defaults.
- The in-process capability carries a warning text about `$since`. The
  folder's capability is the same mode with no text.
- `hasMore` is a boolean in the folder's state. In-process keeps whatever
  `has_next_page_path` held (a count, for Hasura aggregates).

## Fixtures

`fixtures/cassettes/` holds the recorded responses, one file per query.
`fixtures/golden/` holds the rows the folder reads from them in 3 scenarios
(`default`, `since`, `chunked`) for each of the 5 queries.

```
node connectors/graphql/fixtures/conformance.mjs         # mako connector test
node connectors/graphql/fixtures/golden.mjs --record     # rebuild the cassettes
node connectors/graphql/fixtures/golden.mjs --write      # rewrite the golden rows
(cd api && node --import tsx --test src/connectors/workspace/graphql-folder-golden.test.ts)
```

`--record` runs the folder against a local emulator of `dataset.mjs`.
Nothing calls a real API.
