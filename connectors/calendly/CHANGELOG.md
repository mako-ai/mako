# Changelog

Releases of `mako/calendly`. Not released yet: no tag, no registry entry.

## 1.0.0 (unreleased)

- A fill read answered 401 or 403 lands the webhook record without the
  columns it lacks, instead of failing the event. RealAdvisor's token
  belongs to another organization than its subscription: 50 of 60 replayed
  events failed with 403 before this.
- The in-process Calendly connector ported to `@makoai/connector-sdk`, with
  the same 7 entities, schemas, layouts, incremental modes, requests,
  pagination and retry policy.
- Webhooks as the SDK's `webhooks` definition: Calendly's signature scheme
  as data (`t=…,v1=…`, HMAC-SHA256 of `t.body`, 180 s of skew), delivery ids
  `<created_at>:<payload.uri>`, and the in-process mapping in `handleBatch`.
- Webhook rows are whole. A scheduled event or event type a payload leaves
  partial is filled from `GET /scheduled_events/<uuid>` or
  `GET /event_types/<uuid>`. In-process writes those columns NULL: in
  RealAdvisor's warehouse, `calendar_event` on 29,901 of 29,984 webhook
  scheduled events, and `slug` and `profile` on 11 of 11 webhook event types.
- `api_base_url` accepts only `https://api.calendly.com` or a loopback
  address, so the token never follows a URL a connection editor typed.
- Each request times out after 60 s, and a process waits at most 4 minutes
  in backoff: a box kills a read after 10 minutes.
