# Changelog

Releases of `mako/stripe`. A workspace installs it with
`source: mako/stripe@1` in `connectors/<slug>/connector.yaml`.

## 1.1.0

- Webhooks. The folder declares Stripe's signature scheme as data
  (`stripe-v1`: `Stripe-Signature`, `t=` and `v1=`, HMAC-SHA256 over
  `<t>.<body>`, 300 s window). Mako's API checks it with the flow's secret.
  The secret never reaches a box.
- 72 events map to 19 entities, the same table as the in-process
  connector. A record is the event's `data.object`, unchanged when whole.
- A partial upsert, or a thin event that only names its object, is filled
  by one GET of that object. The webhook's own values win. A 404 skips the
  event. A spent 40 s fill budget defers it. Any other failure fails it for
  a retry. No partial row is ever written.

## 1.0.0

- First release: the in-process Stripe connector ported to
  `@makoai/connector-sdk`, with the same 22 entities, schemas, cursors and
  pagination.
