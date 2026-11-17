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
