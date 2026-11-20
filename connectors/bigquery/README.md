# BigQuery connector folder

Google BigQuery on `@makoai/connector-sdk`: a port of the in-process
connector (removed), run in a box. No flow uses it yet.
`fixtures/conformance.mjs` replays recorded BigQuery responses against it.

## Connection

| Field                  | Form                        | Notes                                             |
| ---------------------- | --------------------------- | ------------------------------------------------- |
| `service_account_json` | encrypted textarea, 10 rows | Needs `client_email` and `private_key`.           |
| `project_id`           | text, required              | The project the jobs run in.                      |
| `location`             | text                        | Sent with the job when set.                       |
| `api_base_url`         | text                        | `https://bigquery.googleapis.com` by default.     |
| `queries`              | list, required              | Name, SQL, legacy SQL, batch size (`maxResults`). |

`check` runs `SELECT 1 AS one`. A connection with no query fails it, as
in-process.

## Credential

The folder authenticates with the connection's service account and nothing
else. It signs a JWT (RS256, scope `bigquery.readonly`, one hour) with the
account's key and exchanges it at the account's `token_uri`. It reads no
environment variable, no metadata server and no gcloud file, and it has no
Google client library. The box gets the connection's config plus
`__connection_id` and `__workspace_id`, which name the job labels. The
parity test runs it with a decoy `GOOGLE_APPLICATION_CREDENTIALS` and checks
that only the connection's account reaches the token endpoint.

## Entities

Each connection query is an entity (`queryEntities`, `source:
"connection"`), in the connection's order. Entities are untyped: rows land
as they come, as in-process. Cells map as in-process: numbers to numbers,
`BOOL` to booleans, `TIMESTAMP` to `YYYY-MM-DD HH:MM:SS.sss UTC`, `RECORD`
to objects and `REPEATED` to arrays. Other types stay strings.

## Reads

The first chunk starts the job (`jobs.query`, labelled `mako_source:
flow`, `mako_connector` and `mako_workspace`), polls it every second while
it is not complete (5 minutes at most) and reads its first page. Later
pages follow `pageToken` with the job's own location. Read state:
`{ pageToken, jobId, jobLocation, schema, totalRows, totalProcessed }`.

Page size: the query's `batch_size`, else the engine's batch size
(`__page_size`), else 100. A pause of `__rate_limit_delay_ms` (200 ms by
default) follows each page. No request is retried: a 429 or 5xx fails the
chunk, and the engine runs it again from its last state, as in-process.

No incremental: `since` is ignored and every run re-reads the query.

## Not replicated

- Job labels carry `mako_source`, `mako_connector` and `mako_workspace`.
  In-process also merges any labels set on the calling context
  (`withQueryLabels`). The sync path sets none today.
- In-process caches the access token per connector instance; the engine
  makes one instance per chunk, so both sides exchange one token per chunk.
- The legacy-SQL flag renders as a checkbox (`boolean`). In-process
  declares `checkbox`, which the form does not render as one.
- Each request times out after 60 s. In-process has no timeout.

## Tests

```
cd api && node --import tsx scripts/run-tsx-tests.mjs bigquery-folder
node connectors/bigquery/fixtures/conformance.mjs
```

The cassettes come from `dataset.mjs` through a local BigQuery emulator.
The token endpoint is emulated, with a key generated per run. No key or
token is committed.
