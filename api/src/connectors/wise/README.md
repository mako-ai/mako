# Wise connector: what a personal token can and cannot see

Wise's API gives a personal API token everything needed to keep balances
close to Wise's own, but **not everything needed to reconcile them exactly**.
This file records where the limit is, how it was verified, and the
workarounds.

## What syncs

| Entity            | Source                                   | How it stays current                         |
|-------------------|------------------------------------------|----------------------------------------------|
| `profiles`        | `GET /v2/profiles`                        | poll + resync                                |
| `balances`        | `GET /v4/profiles/{id}/balances`          | poll + resync (live amount per currency)     |
| `transfers`       | `GET /v1/transfers`                       | poll (new ones) + `transfers#*` webhooks     |
| `recipients`      | `GET /v2/accounts`                        | poll + resync                                |
| `activities`      | `GET /v1/profiles/{id}/activities`        | poll + resync                                |
| `balance_updates` | `balances#update` / `balances#credit`     | webhooks only (no REST backfill)             |
| `balance_statements` | `GET /v1/profiles/{id}/balance-statements/{balanceId}/statement.json` | refused to personal tokens, see below |

## The activity feed is (almost) a ledger

`activities` lists every card payment, transfer, batch transfer and card
refund. For each one, `secondaryAmount` (or `primaryAmount` when there is no
second amount) is **exactly what left or reached the balance, Wise's fee
included**: a 222.79 USD card payment reads `222.79 USD` / `198.77 EUR`, and
the statement debits 198.77 EUR. Incoming amounts are wrapped in
`<positive>+ … </positive>`.

Checked against a statement export (October 2026, one business account):
53 of 56 card payments matched the statement to the cent; one currency
balance rebuilt from the feed equalled Wise's live balance exactly.

## Where it stops being exact

1. **A card payment drawn on two balances.** When a small balance (a refund
   sitting in CHF or USD) pays part of a card payment and another balance
   pays the rest, the feed says `secondaryAmount: "EUR, CHF"` with **no
   amounts**. Only the statement has the split (e.g. CHF 86.59 + EUR
   310.74). Rare, but it happens whenever a refund lands in a minor currency.
2. **Fees as their own figure.** Amounts include Wise's fee, so balances
   still tie, but the fee itself is only itemised in the statement
   (`totalFees`, or separate `FEE-…` lines in an export).
3. **Conversions between own balances** are not itemised per balance in the
   feed either.

## Statements are closed to personal tokens

Balance statements require strong customer authentication. Wise's documented
route for personal tokens is: upload an RSA public key (Settings → API tokens
→ Manage public keys), then answer the 403 by signing the
`x-2fa-approval` one-time token with the private key (SHA256withRSA, base64,
retried with `x-2fa-approval` + `X-Signature`). The connector implements
exactly that (`withSca`, set `sca_private_key`).

In practice Wise answers a correct signature with
`403 x-2fa-approval-result: REJECTED` for EU/CH business profiles: verified
2026-10-10 with a token created after the key was registered and Wise's own
sample code (`transferwise/digital-signatures-examples`), and again
2026-10-17 through `probe_connection` (the error names the signing key's
fingerprint, to compare with the key listed in Wise). `/v1/one-time-token/status`
answered `ott_not_found`. Treat statements as unavailable over the API.

## Webhooks

Wise's own webhook screen (Settings → Integrations and tools → Webhooks)
offers three profile events, one per webhook, schema 2.0.0: transfer updates
(`transfers#state-change`), account deposits (`balances#credit`) and transfer
issues (`transfers#active-cases`). The connector maps all three.

`balances#update` (every credit and debit, card spend included) exists for
profile subscriptions in Wise's docs but is **not offered on that screen**,
and creating it over the API with a read-only personal token returns 403. So
card spend does not arrive by webhook; the activity poll and the scheduled
resync carry it. Card transaction events (`cards#transaction-state-change`)
are application-level only.

Wise's test notifications (`X-Test-Notification: true`) are acknowledged
and recorded under an event type no entity maps, so they never land in a
table.

## Workarounds

- **Bridge between statements.** Use the latest statement export as the
  source of truth and add the feed's completed transfers and card payments
  after its last line, leaving out the multi-balance ones. Balances stay
  within those rare splits of Wise's; the next export supersedes the bridge.
- **Statement export.** wise.com → Your account → Statements and reports →
  Statements → CSV, every currency, "Display transactions with fees shown
  separately". Wise asks for a fresh login (passkey) first. One CSV per
  balance, each line with its running balance, so it can be checked line by
  line before loading.
- **Recurring statement.** The same screen can schedule a recurring
  statement that Wise emails; an agent can pick it up from the mailbox and
  load it, so no export goes stale.
- **Full access.** A partner (OAuth) integration or `balances#update` would
  remove the gap; neither is available to a personal token today.
