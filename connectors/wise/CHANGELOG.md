# Changelog

Releases of `mako/wise`. Not released yet: no tag, no registry entry.

## 1.0.0 (unreleased)

- The in-process Wise connector ported to `@makoai/connector-sdk`, with the
  same 7 entities, schemas, requests, pagination, chunk positions, retry
  policy and SCA signing, on `fetch` with no dependency.
- Webhooks as the SDK's `webhooks` definition: Wise's RSA-SHA256 scheme with
  its two public keys, the test notification and `X-Delivery-Id` as data,
  and the in-process event mapping as the batch handler.
- Webhook rows are filled. A Wise event carries a state change, not the
  object, so in-process a webhook NULLs every other column of the row
  (RealAdvisor: 5 of 5 webhook-written transfers had `targetValue`,
  `sourceCurrency`, `created` and `user` NULL). The handler reads the
  object once and fills what the event lacks; the event's values win.
- `api_base_url` accepts only Wise's hosts (production or sandbox, https)
  or a loopback address, so the token never follows a typed URL.
