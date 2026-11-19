# Changelog

Releases of `mako/rest`. Not released yet: no tag, no registry entry.

## 1.0.0 (unreleased)

- The in-process generic REST connector ported to `@makoai/connector-sdk`:
  one untyped entity per item of `config.entities` (`queryEntities` with
  `source: "connection"` and `key: "entities"`), the same config fields
  (`api_base_url`, encrypted `headers`, `entities`), request building,
  pagination (page, offset, cursor), client filter on `updated_at`, preview
  count request and `check` probe, on `fetch` with no dependency.
- Differences from in-process, all in the transport. It sends through the
  SDK's `safeRequest`: the socket's own lookup checks every address and the
  connection uses the one it checked, so DNS rebinding finds no window. Only
  public unicast and loopback are allowed (a box is outside Mako's network).
  Each redirect hop is checked (up to 21 are followed), https to http with a
  credential is refused, the connection's custom headers are dropped on a
  hop off the original host, and the body is capped at 100 MB. A request
  times out after 120 s. The count preview runs for GET entities only.
