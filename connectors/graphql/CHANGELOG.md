# Changelog

Releases of `mako/graphql`. Not released yet: no tag, no registry entry.

## 1.0.0 (unreleased)

- The endpoint check also covers every address the host name resolves to,
  and a redirect is refused rather than followed.

- The in-process GraphQL connector ported to `@makoai/connector-sdk`: one
  untyped entity per flow query (`queryEntities`, `source: "flow"`), the
  same credential and query forms, pagination, `$since` and client filter,
  count query, retry policy and `check` probe, on `fetch` with no
  dependency.
- The endpoint is checked once for metadata names and private or
  link-local IP literals. In-process guards every resolved address.
