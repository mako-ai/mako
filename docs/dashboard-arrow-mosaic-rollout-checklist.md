# Dashboard Arrow + Mosaic rollout checklist

Phase 1 keeps the main dashboard canvas on the new path while preserving a rollback switch and leaving embeddable/presentation surfaces on the legacy data/query path.

## Scope contract

- [x] Same-data-source-only cross-filtering on the Mosaic path
- [x] Relationship-aware filtering explicitly deferred
- [x] Global filter unification explicitly deferred
- [x] Dashboard-level engine flag supports `mosaic` and `legacy`

## Arrow export validation

- [ ] Verify `format=arrow` succeeds for a representative SQL data source
- [ ] Verify Arrow load succeeds in an OPFS-backed dashboard session
- [ ] Verify Arrow ingest falls back to NDJSON when schema or ingest fails
- [ ] Verify a large export path on realistic data before broad enablement

## Mosaic interaction validation

- [ ] Repeated click on the same mark deselects deterministically
- [ ] Multiple widgets on the same data source recompute together
- [ ] Widgets on different data sources do not cross-filter in Phase 1
- [ ] SQL edits on a mounted widget trigger a fresh coordinator query
- [ ] Refreshing a dashboard while selections are active preserves coordinator state
- [ ] Widget duplication/removal disconnects clients cleanly
- [ ] Session disposal destroys the coordinator and clears connected clients

## Follow-up surfaces

- [ ] Migrate `EmbeddableDashboard` after the main canvas path is validated
- [ ] Migrate `PresentationMode` after the main canvas path is validated
