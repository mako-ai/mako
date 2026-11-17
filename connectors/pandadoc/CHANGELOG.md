# Changelog

Releases of `mako/pandadoc`. Not released yet: no tag, no registry entry.

## 1.0.0 (unreleased)

- The in-process PandaDoc connector ported to `@makoai/connector-sdk`, with
  the same 4 entities, schemas, pagination, document hydration, retry
  policy and incremental modes.
- Webhooks as the SDK's `webhooks` definition. A partial upsert is filled
  from `/details` before it is answered, so a webhook never writes NULL
  over a column a backfill holds.
