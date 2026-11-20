# Changelog

Releases of `mako/posthog`. Not released yet: no tag, no registry entry.

## 1.0.0 (unreleased)

- The in-process PostHog connector (now deleted) ported to `@makoai/connector-sdk`, with
  the same 5 REST entities (`surveys`, `survey_responses`, `feature_flags`,
  `experiments`, `annotations`), schemas, offsets, pagination, `since`
  handling, retry policy and `check` probe.
- No entity declares a cursor field, so `_mako_source_ts` resolves as
  in-process. A response row has no update or creation field and gets the
  sync time on both paths.
- Not ported: HogQL query entities (a flow's `queries`). The SDK declares
  entities statically. 0 production flows used them. Live HogQL reads stay
  available through `call_connection` (`hogql`).
