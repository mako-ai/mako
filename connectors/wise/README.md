# Wise connector folder

Wise (TransferWise) on `@makoai/connector-sdk`: a port of the in-process
connector in `api/src/connectors/wise/`, run in a box. No flow uses it yet.
The parity harness in `fixtures/` holds the two to the same output.

## Entities

| Entity               | Source                                                       | Read state                                   | Incremental (`since`)                |
| -------------------- | ------------------------------------------------------------ | -------------------------------------------- | ------------------------------------ |
| `profiles`           | `GET /v2/profiles`                                           | none (one batch)                             | none                                 |
| `balances`           | `GET /v4/profiles/{id}/balances?types=STANDARD`              | `profileIds`, `profileIndex`                 | none                                 |
| `balance_updates`    | `balances#update` / `balances#credit` webhooks               | none (webhook-only, `read` yields nothing)   | none                                 |
| `transfers`          | `GET /v1/transfers?profile&limit&offset`                     | `profileIds`, `profileIndex`, `offset`       | `created-anchor`: `createdDateStart` |
| `recipients`         | `GET /v2/accounts?profile&size&seekPosition`                 | `profileIds`, `profileIndex`, `seekPosition` | none                                 |
| `activities`         | `GET /v1/profiles/{id}/activities?size&nextCursor`           | `profileIds`, `profileIndex`, `cursor`       | `native`: `since`                    |
| `balance_statements` | `GET /v1/profiles/{p}/balance-statements/{b}/statement.json` | the profile, balance and 90-day window walk  | `native`: from `since` less 7 days   |

Every entity's key is `id`. Columns, types and nullability are the
in-process schema's (`schema.ts`); unknown fields land as strings.

Pages: transfers 100, recipients 100 (Wise serves at most 20), activities
50, lowered by `__page_size`. A pause of `__rate_limit_delay_ms` (default
200 ms) follows each page. Requests retry 429, 5xx and network errors 5
times, waiting `Retry-After` (at most 5 minutes) or 1 s doubling to 60 s
with full jitter.

Balance statements need strong customer authentication on some profiles:
set `sca_private_key` to the PEM key whose public half is registered in Wise
(Settings → API tokens → Manage public keys). A 403 with `x-2fa-approval`
is answered once with the token signed SHA256withRSA. See
`api/src/connectors/wise/README.md` for what a personal token can see.

## Webhooks

Wise signs every delivery with its own RSA key (SHA256withRSA over the raw
body, base64 in `X-Signature-SHA256`). Mako's API checks it against the
two public keys the folder declares, production and sandbox, before it
stores anything. No secret is involved. A test notification
(`X-Test-Notification: true`, sent when a subscription is created) is
answered unsigned and stored under `wise#test-notification`, which nothing
maps. The event id is `X-Delivery-Id`.

| Event                           | Entity            |
| ------------------------------- | ----------------- |
| `transfers#state-change`        | `transfers`       |
| `transfers#refund`              | `transfers`       |
| `transfers#payout-failure`      | `transfers`       |
| `transfers#active-cases`        | `transfers`       |
| `balances#update`               | `balance_updates` |
| `balances#credit`               | `balance_updates` |
| `balances#account-state-change` | `balances`        |
| `profiles#state-change`         | `profiles`        |
| `recipients#state-change`       | `recipients`      |

Setup: on wise.com, Settings → Integrations and tools → Webhooks, add the
flow's webhook URL for each profile, one webhook per event. That screen
offers `transfers#state-change`, `balances#credit` and
`transfers#active-cases`. `balances#update` exists only for subscriptions
made over the API, and a read-only personal token cannot make one (403).

A Wise event carries a state change, not the object. The handler fills
each such record with one GET of the object (`/v1/transfers/{id}`,
`/v4/profiles/{p}/balances/{id}`, `/v2/profiles/{id}`, `/v2/accounts/{id}`),
shaped as `read` emits it, so the row never loses its other columns. The
event's non-null values win. A 404 drops the record, a spent 40 s budget
defers the event, and any other failure fails it for a retry.

## What differs from in-process

- Webhook rows are filled (above). In-process writes them partial, which
  NULLs every column the event lacks.
- `api_base_url` must be a Wise host over https or a loopback address.
- `sca_private_key` is a password field in the form, not a textarea. It is
  encrypted on both.
- Each request times out after 60 s, and one process waits at most 4
  minutes in backoff, because a box ends a command after 10 minutes.
- The box path reads a transfer's zone-less `created` as the API's local
  time for the source timestamp. In-process reads it as UTC. They agree
  when the API runs in UTC.

## Tests

```bash
# Parity tables, folder through the SDK runner (re-record with --record).
TZ=UTC pnpm --filter api exec tsx ../connectors/wise/fixtures/parity.mjs
# The same through SandboxedConnector, and the webhook fill.
cd api && node --import tsx src/connectors/wise/folder-parity.test.ts
cd api && node --import tsx src/connectors/wise/folder-webhook-batches.test.ts
# `mako connector test` against the cassettes.
node connectors/wise/fixtures/conformance.mjs
```
