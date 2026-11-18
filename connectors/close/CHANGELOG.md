# Changelog

Releases of `mako/close`. Not released yet: no tag, no registry entry.

## 1.0.0 (unreleased)

- The in-process Close connector ported to `@makoai/connector-sdk`, with the
  same 22 entities, schemas, cursors, pagination and rate-limit policy, and
  the webhook mapping as a `webhook` export.
- Search pages adapt their size. A page whose records serialize to more
  than 8 MiB is read again at half the size from the same cursor, down to
  10 rows, and the smaller size is kept in the state. A full page within
  half the budget doubles the next page, back up to 200 rows. `__page_size` lowers
  the 200-row Search page. Fixes `activities:Email`, whose 200-row pages
  were over the 32 MiB chunk cap.
- `custom_fields` reads all 6 custom-field lists. Activity
  (`/custom_field/activity/`) and custom-object fields used to come only
  from webhooks, untyped; a poll now has them, with `custom_field_type`
  `activity` or `custom_object`.
- `users` reads the organization's memberships. Every user gets
  `is_active`. A deactivated user is marked deleted (`is_deleted`, and
  `_mako_deleted_at` = its `date_updated`, stable across polls), as the
  `membership.deactivated` webhook does in-process, but keeps name and
  email. Other users carry `_mako_deleted_at` null, so a reactivation
  clears the mark. A failed membership read fails the chunk.
- Meeting `notetaker_states` stays webhook-only: Close's REST API omits it
  from `/activity/meeting/`, `/activity/meeting/{id}/` and Search, even
  when `_fields` names it.
- `leads` gets `source` on polls and backfills. Close's Search leaves
  `source` out even when `_fields` names it. Search now requests the smart
  field `first_source`, which holds the same value, and stores it as
  `source`. An explicit `source` wins, so webhook payloads keep theirs. On
  `ch_close`, 300 of 300 leads searched by `source` (100 each of `import`,
  `api`, `ui`) had the same `first_source`. The in-process connector does
  the same.
- Search reads 3 more fields, as the workspace copy prod runs does:
  opportunity `note_html`, contact `timezone_source` and contact
  `lead_suggestions_operation_id`. `note_html` and
  `lead_suggestions_operation_id` are new schema columns, in both
  connectors. The in-process connector requests the same 3 fields.
- Meeting `calendar_event_link` is webhook-only on Search. Close answers
  it with null there, so a poll wrote null over the webhook value. The
  column stays in the schema. Both connectors leave it out of `_fields`.
