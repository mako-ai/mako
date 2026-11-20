# Changelog

Releases of `mako/graphql`. Not released yet: no tag, no registry entry.

## 1.0.0 (unreleased)

- Security: an endpoint URL with credentials or a query string never
  appears in an error. The redirect error names the origin and path only.
  Needs `@makoai/connector-sdk` 0.2.1: secret headers now stay only on the
  same host and port, and a stacked or unknown content-encoding is refused.

- Security: the request goes through `safeRequest` in
  `@makoai/connector-sdk` 0.2.1. The guard runs inside the socket's own
  lookup, so DNS rebinding (a public answer for a check, then 169.254.169.254
  or a private IP for the connection) is refused with no header sent. The
  separate resolve-then-fetch check is gone. The policy is an allowlist of
  public unicast and loopback. A redirect is refused rather than followed,
  and the decompressed response is capped at 100 MB.

- The in-process GraphQL connector ported to `@makoai/connector-sdk`: one
  untyped entity per flow query (`queryEntities`, `source: "flow"`), the
  same credential and query forms, pagination, `$since` and client filter,
  count query, retry policy and `check` probe, on `fetch` with no
  dependency.
