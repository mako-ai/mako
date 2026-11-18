# Calendly

Calendly as a Mako connector folder, on `@makoai/connector-sdk`. It is a port
of the in-process connector in `api/src/connectors/calendly/`. The parity
harness in `fixtures/` holds the two to the same rows, chunks and requests.

## Credential

| Field          | Required | What                                                                                                                                                                                                                                   |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access_token` | yes      | A personal access token or OAuth token. Scopes: `organizations:read`, `users:read`, `groups:read`, `event_types:read`, `scheduled_events:read`, `contacts:read`. Webhook provisioning also needs `webhooks:read` and `webhooks:write`. |
| `api_base_url` | no       | `https://api.calendly.com` (the default). Only that host or a loopback address is accepted.                                                                                                                                            |

## Entities

| Entity             | Source                                                                    | Incremental (`since`)                            | Partition    |
| ------------------ | ------------------------------------------------------------------------- | ------------------------------------------------ | ------------ |
| `organizations`    | `GET /users/me`, then the token's organization                            | none                                             | `created_at` |
| `users`            | `GET /organization_memberships`, the user flattened into `user_*` columns | rows updated at or after `since` (client filter) | `created_at` |
| `groups`           | `GET /groups`                                                             | client filter on `updated_at`                    | `created_at` |
| `event_types`      | `GET /event_types`, sorted by name                                        | client filter on `updated_at`                    | `created_at` |
| `scheduled_events` | `GET /scheduled_events`, sorted by start time                             | `min_start_time` (created-anchor)                | `start_time` |
| `invitees`         | `GET /scheduled_events/<uuid>/invitees` for every event                   | events from `min_start_time`                     | `created_at` |
| `contacts`         | `GET /contacts`                                                           | client filter on `updated_at`                    | `created_at` |

The client filter drops rows without `updated_at`. `scheduled_events` keys
on start time, so an event edited after it was scheduled is seen only by a
full read or a webhook.

Every row has `id`, the last segment of its `uri`. Lists page by `count`
(100, or `__page_size` from 1 to 100) and `page_token`. Invitees walk the
events by start time, 100 at a time, and read the invitees of 8 events at
once. An event with `invitees_counter.total` 0 costs no request. An event
whose invitees answer 400 or 404 is skipped. Requests retry 5 times on 429,
5xx and network errors, honouring `Retry-After`.

## Webhooks

Calendly delivers 5 events: `invitee.created`, `invitee.canceled`,
`invitee_no_show.created`, `event_type.created` and `event_type.updated`.

- An invitee event writes the invitee and its scheduled event.
- An event type event writes the event type.

Mako creates the subscription when a flow turns webhooks on: one
organization-scoped `POST /webhook_subscriptions` to the flow's URL, with the
events its entities need. Calendly answers with a signing key, which Mako
keeps as the flow's secret. No box sees it.

Mako checks every delivery in its API before storing it:
`Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex>`, HMAC-SHA256 of
`<t>.<raw body>` under the signing key, `t` within 180 s of now. A delivery's
id is `<created_at>:<payload.uri>`, so a resend is stored once.

Calendly's payloads leave columns out, so a row a webhook writes first
would land without them. So the handler fills a partial scheduled event or event type from
`GET /scheduled_events/<uuid>` or `GET /event_types/<uuid>`. Only the
columns the payload lacks or sends null are filled. A 404 drops the record.
A 403 (a token that may not read the object) lands the record without the
columns it lacks, so live values stay and no NULL is written. A 401 (a dead
token) fails the event for a retry.
Other failures retry the event. Invitee payloads are whole and cost no
request.

## Tests

```sh
# From api/: parity through SandboxedConnector, and the webhook handler.
node --import tsx src/connectors/calendly/folder-parity.test.ts
node --import tsx src/connectors/calendly/folder-webhook-batches.test.ts

# The parity tables; --record rebuilds the cassettes from fixtures/dataset.mjs.
pnpm --filter api exec tsx ../connectors/calendly/fixtures/parity.mjs

# `mako connector test` on the cassettes.
node connectors/calendly/fixtures/conformance.mjs
```

The cassettes come from a local Calendly emulator over a synthetic account.
They hold no token and no real data.
