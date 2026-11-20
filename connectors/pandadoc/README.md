# PandaDoc connector folder

PandaDoc on `@makoai/connector-sdk`, run in a box. It replaces the in-process
connector, which is deleted. Production runs it on the 4 `*-shadow-*` flows
(ch, es, fr, it).

## Entities

| Entity      | Read                                                                                 | Incremental                    |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------ |
| `documents` | `?count=&page=`, `order_by=date_modified`, then `/details` per document, 5 at a time | native: `modified_from`        |
| `templates` | `?count=&page=`                                                                      | keeps `date_modified >= since` |
| `contacts`  | one response                                                                         | none                           |
| `members`   | one response; `id` copied from `membership_id`                                       | keeps `date_modified >= since` |

- Columns, types and keys are the in-process schema's (`schema.ts`).
- A hydrating `documents` chunk reads at most 2 pages, then ends with
  `hasMore: true`. `fetch_document_details: false` turns hydration off.
- A failed detail read keeps the list projection, as in-process.
- Retries: 5, on 429, 5xx and network errors, `Retry-After` first (capped at
  5 minutes), else full jitter from 1 s to 60 s. A box adds 60 s per attempt
  and 4 minutes of backoff per process.
- Deletions come only from webhooks (`document_deleted`, `template_deleted`),
  as in-process.

## Webhooks

- Mako's API checks every delivery from the declaration in `webhooks.ts`:
  HMAC-SHA256 of the raw body under the shared key, hex, in `?signature=`,
  else a `signature` header. The key never reaches the box.
- A delivery has no event id. Mako keys it on a SHA-1 of the raw body, as
  in-process. Its type is the first item's `event`.
- A document payload lacks 5 schema columns (`date_completed`, `date_sent`,
  `total`, `approvers`, `date_status_changed`). The handler reads
  `/details` once for a partial upsert and fills only absent keys. A column
  the details omit too is NULL, as a backfill stores it.
- 404: the record is dropped. Other failures: `extract_failed`. Past 40 s of
  reads in a batch: `deferred`.
- The API provisions the subscription with the built-in's own code
  (`api/src/connectors/workspace/webhook-provisioners.ts`).

## Fixtures

`fixtures/` replays a synthetic account (25 documents, 12 templates, 5
contacts, 4 members). `fixtures/golden/` holds the rows the folder reads from
the recorded responses, one file per entity.

```sh
node connectors/pandadoc/fixtures/conformance.mjs         # mako connector test
node connectors/pandadoc/fixtures/golden.mjs --write      # rewrite the golden rows
(cd api && node --import tsx --test src/connectors/workspace/pandadoc-folder-golden.test.ts)  # the API test
```
