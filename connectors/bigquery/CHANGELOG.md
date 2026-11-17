# Changelog

Releases of `mako/bigquery`. Not released yet: no tag, no registry entry.

## 1.0.0 (unreleased)

- The in-process BigQuery connector ported to `@makoai/connector-sdk`: one
  untyped entity per connection query (`queryEntities`, `source:
"connection"`), the same credential form, job start, polling, paging,
  cell mapping, job labels and `check`, on `fetch` and `node:crypto` with no
  dependency.
- Authenticates with the connection's service account only.
