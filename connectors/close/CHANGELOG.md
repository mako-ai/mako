# Changelog

Releases of `mako/close`. Not released yet: no tag, no registry entry.

## 1.0.0 (unreleased)

- The in-process Close connector ported to `@makoai/connector-sdk`, with the
  same 22 entities, schemas, cursors, pagination and rate-limit policy, and
  the webhook mapping as a `webhook` export.
- Search pages adapt their size. A page whose records serialize to more
  than 8 MiB is read again at half the size from the same cursor, down to
  10 rows, and the smaller size is kept in the state. `__page_size` lowers
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
