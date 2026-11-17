# Claap connector folder

The in-process Claap connector (`api/src/connectors/claap/`), ported to
`@makoai/connector-sdk` so it can run in a box. No flow uses it yet.
Production runs the in-process connector on 1 flow.

## Entities

| Entity                  | Read                                                                | Incremental                                                       |
| ----------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `recordings`            | list pages of 50 (`sort=created_asc`), then each recording's detail | `createdAfter` = `since` minus `recordings_lookback_days` (max 7) |
| `recording_transcripts` | list pages of 50, then every language's transcript                  | `createdAfter` = `since` minus 2 days                             |
| `workspace`             | `GET /v1/workspaces/mine`, one row                                  | none                                                              |

- Columns, types and keys are the in-process schema's (`schema.ts`).
- Detail reads wait at least 350 ms each (3 requests a second).
- The daily quota: below 500 calls left, `recordings` checkpoints mid-page
  (`cursor` plus `pageOffset`) and ends the chunk with `hasMore: true`;
  `recording_transcripts` ends the chunk after the pages it read. A chunk
  that could read nothing fails, as in-process.
- A detail that answers 404, or a Ready recording without `aiFields`, is
  skipped. Any other detail failure fails the chunk.
- Transcripts come from the signed link first (https only, no private
  address, at most 3 redirects, 50 MB), else from
  `/v1/recordings/{id}/transcript`. A failed download is a `failed` row.
- Retries: 5, on 429, 5xx and network errors, as in-process.

## Webhooks

- Claap sends the secret itself in `X-Claap-Webhook-Secret`. Mako's API
  compares it with the flow's secret (`scheme: "shared-secret"`). The
  secret never reaches the box.
- The event id is the body's `eventId`, the type `event.type`.
- A recording payload has every backfilled column but, now and then,
  `source`. A partial upsert reads the detail once and fills only absent
  keys. `crmInfo` and `deal` do not trigger a read: no Claap read returns
  them.
- When the flow syncs `recording_transcripts`, the handler downloads the
  transcripts now, as in-process, since the links expire after 24 hours.
- 404: the record is dropped. Ready without `aiFields`: `extract_failed`.
  Past 40 s of reads in a batch: `deferred`.

## Parity

`fixtures/` replays a synthetic workspace (23 recordings, 29 transcripts)
against both connectors, signed links included.

```sh
pnpm --filter api exec tsx ../connectors/claap/fixtures/parity.mjs           # table
pnpm --filter api exec tsx ../connectors/claap/fixtures/parity.mjs --record  # re-record
node connectors/claap/fixtures/conformance.mjs                               # mako connector test
(cd api && node --import tsx --test src/connectors/claap/folder-parity.test.ts)  # the API test
```
