# Control-plane backfill and cutover parity

Migration `0012` covers notification rules and deliveries, recorded workflow writes and counters, model catalog snapshots, and the box tracking marker. The release lead owns the write freeze, traffic switch, and production execution.

1. Verify the target has the reviewed `0012` DDL. Check for `notification_rules.imported_from_mongo`, a non-null delivery `rule_id` with no rule FK, and the resource index ending in `completed_at DESC NULLS LAST, created_at DESC NULLS LAST`. A preview that applied an earlier version of `0012` needs a fresh database to exercise this version.
2. Dry-run the CLI below against the selected Mongo and Postgres databases. Record its table counts and reasons for skips. Apply the initial copy with `--apply`. The ordinary copy can run while Mongo still takes writes.
3. For the final pass, quiesce both versions of the six collections' writers, including notification workers, dry-run producers, catalog refreshes and probes, and box tracking. Drain in-flight jobs or record the pending delivery keys for replay. Take a consistent Mongo snapshot after the drain and use it as the final read source. Pick one UTC timestamp at the freeze and pass it as `--as-of` on every final command. This keeps the 90-day and 7-day windows fixed while comparing data.
4. Dry-run with `--reconcile-deleted-rules`. Compare its count of missing imported rules with source deletions, then apply with both flags. The reconciliation removes only previously imported rules. It retains PG-created rules and each delivery's original rule ID.
5. Compare both stores in batches using the table below. Normalize ObjectIds through the ID codec, dates to UTC milliseconds, and JSON object keys to a stable order before comparing. Compare or hash sensitive fields in memory. Record aggregate mismatch counts only.
6. Repeat the final apply with the same source and timestamp. Require zero writes and deletions across all six tables, zero unexplained parity mismatches, and an explanation for every non-TTL skip. Keep the source frozen while the lead switches traffic. If parity fails, keep the current traffic owner and reconcile the discrepancy before switching.

```sh
pnpm --filter api exec tsx src/database/pg/cli/backfill-control-plane-small.ts \
  --as-of "$CUTOVER_UTC" --reconcile-deleted-rules
pnpm --filter api exec tsx src/database/pg/cli/backfill-control-plane-small.ts \
  --as-of "$CUTOVER_UTC" --reconcile-deleted-rules --apply
```

| Data | Comparison at the freeze |
| --- | --- |
| Rules | Compare imported and source rule IDs per workspace, resource, enabled state, triggers, creator, timestamps and encrypted channel fields. Account separately for PG-created rules. Check that rules deleted from Mongo disappeared from Postgres. |
| Deliveries | Compare by workspace and idempotency key for all rows created in the last 90 days, including rows whose rules were deleted. Compare original rule/resource/run IDs, status, attempts, last error, HTTP status and timestamps. Confirm pending keys have a queued event or a replay owner. Retried fan-out uses the same event ID. |
| Recorded runs and writes | For the last seven days, compare counters by workspace and run. Compare every retained sequence and its connection, user, flags, timestamp and request content, including sanitized keys and values. The cap applies to reservations, so compare counters with their source counters independently of the number of writes. |
| Model catalog | Compare the six snapshot keys present in either store. Check arrays and item counts against the newer full snapshot. For capabilities, compare the union of model keys with the newer mode on conflicts. For curation, verify every model, tier, visibility and default against the intended configuration, plus the latest refresh error. |
| Box policy | Compare each marker ID and its earliest recorded tracking date. |
