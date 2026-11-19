# Changelog

Releases of `mako/rest`. Not released yet: no tag, no registry entry.

## 1.0.0 (unreleased)

- The in-process generic REST connector ported to `@makoai/connector-sdk`:
  one untyped entity per item of `config.entities` (`queryEntities` with
  `source: "connection"` and `key: "entities"`), the same config fields
  (`api_base_url`, encrypted `headers`, `entities`), request building,
  pagination (page, offset, cursor), client filter on `updated_at`, preview
  count request and `check` probe, on `fetch` with no dependency.
- Differences from in-process, all in the transport: a request times out
  after 30 s, redirects are followed by hand (up to 21, each hop checked),
  and loopback is reachable because a box is outside Mako's network.
