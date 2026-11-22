# Changelog

Releases of `mako/claap`. Not released yet: no tag, no registry entry.

## 1.0.0 (unreleased)

- The former in-process Claap connector (deleted) ported to
  `@makoai/connector-sdk`, with the same 3 entities, schemas, pagination,
  quota checkpoints, transcript downloads and incremental anchors.
- Webhooks as the SDK's `webhooks` definition, transcripts downloaded with
  the recording. A partial upsert is filled from the recording's detail
  before it is answered.
