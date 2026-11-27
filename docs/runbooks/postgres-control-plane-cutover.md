# Control-plane backfill and Cloud Run cutover

Migration `0012` covers notification rules and deliveries, recorded workflow runs and writes, model catalog snapshots, and the box tracking marker. The release lead owns production execution and traffic. At most one revision may accept writes to these domains at a time.

## Before the new revision starts

1. **Pin the old revision.** Record the project, region, old revision name and image digest. Hold the master release before the new container starts. The production job runs `pg:migrate`, deploys `mako`, then updates its environment, which can create a second revision. It has no control-plane copy or parity gate. Pin 100% of traffic to the old **named** revision and verify the allocation. Keep this pin through both revision-producing steps. [Deployment workflow](../../.github/workflows/deploy-app.yml) · [Cloud Run revision traffic](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration)

   ```sh
   run_service() { gcloud run services "$@" --project="$GCP_PROJECT_ID" --region="$GCP_REGION"; }
   run_service describe mako --format='yaml(status.traffic,status.latestReadyRevisionName)'
   run_service update-traffic mako --to-revisions="$OLD_REV=100"
   run_service describe mako --format='yaml(status.traffic)'
   ```

2. **Apply the schema.** Use the reviewed release checkout and the production job's direct Postgres connection. Verify the pending migration against the target journal, run `pnpm --filter api run pg:migrate`, and check all six tables. The reviewed `0012` has `notification_rules.imported_from_mongo`, non-null delivery `rule_id` without a rule FK, and a resource index ending in `completed_at DESC NULLS LAST, created_at DESC NULLS LAST`. A preview that applied an earlier `0012` needs a fresh database for rehearsal. An unexpected production journal or DDL stops the release.
3. **Freeze Mongo writers and drain in-flight work.** Keep the old revision serving unrelated traffic. Hold HTTP mutations, workflow recorded-write producers, notification fan-out and delivery workers, catalog refreshes/probes/curation and box tracking. Include scheduled jobs, tagged revision URLs and other direct callers. Let current transactions and outbound delivery attempts settle. Record the owner and event ID for each remaining pending delivery. Confirm the affected collections have stopped changing. Take a consistent Mongo snapshot and record the UTC freeze timestamp in `CUTOVER_UTC`. Bind the CLI's `DATABASE_URL` to that snapshot with read-only credentials. Keep the snapshot fixed through post-switch replay, including its TTL data. `--as-of` fixes the retention floor and does not freeze a live Mongo database.
4. **Copy and prove parity before boot.** Use the production Postgres direct connection and the same source and timestamp for all four commands below. Compare the dry run with the initial inventory, accounting for intervening writes and TTL expiry. Review skips. Run the copy, repeat it and require zero rows written on the repeat. Then run the read-only content comparison. Hold the switch for unexplained differences, non-TTL skips, or imported rules missing from Mongo. Investigate stale rules with the lead. Any production deletion requires separate authorization.

   ```sh
   control_plane() { pnpm --filter api exec tsx src/database/pg/cli/backfill-control-plane-small.ts --as-of "$CUTOVER_UTC" "$@"; }
   control_plane --reconcile-deleted-rules
   control_plane --apply
   control_plane --apply
   control_plane --replay
   ```

## Switch and replay

5. **Stage the exact release at zero traffic.** Keep old writers paused and new event consumers held. Run the deploy with the old traffic pin in place, using `--no-traffic` for a manually staged deploy. Finish the environment update. Verify 100% still routes to `$OLD_REV` and select the final ready `$NEW_REV` by its reviewed image digest and configuration. Check readiness and startup logs. Startup calls `warmCatalog()`, which can write a snapshot if the catalog cannot load. Run `control_plane --replay` again after startup, before moving traffic. Review any boot-time PG differences explicitly.
6. **Hand over writes once.** Route 100% to the verified new revision. Confirm the allocation, that no old requests or jobs can still write, and that direct and asynchronous callers use the new revision. Release the held writers and pending delivery events there using their original event IDs. Record the switch time and both revision names.

   ```sh
   run_service update-traffic mako --to-revisions="$NEW_REV=100"
   run_service describe mako --format='yaml(status.traffic,status.latestReadyRevisionName)'
   ```

7. **Replay read-only against live PG.** Keep the same frozen Mongo source and `CUTOVER_UTC`, bind the CLI's PG connection to a SELECT-only role, and run `control_plane --replay`. The CLI uses a repeatable-read, read-only PG transaction. It reports matched rows, content mismatches and affected field names, source rows missing in PG, PG-only rows and imported rules missing from Mongo. A PG deletion stays deleted and a PG edit stays intact. Exit 0 means parity, 2 means drift or a non-TTL skip, and 1 means a command or connection failure. Save the aggregate reports, classify each difference against the pre-switch report and post-switch activity, and escalate unexplained differences. Deletion reconciliation is audit-only in every CLI mode. Once PG accepts writes, keep PG authoritative. A return to Mongo requires another writer freeze and a lead-approved plan for the PG changes.

## Parity criteria

| Data                     | What to compare                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules                    | Rule IDs, workspace and resource, enabled state, triggers, creator, timestamps and encrypted channel fields. Account for PG-created rules and investigate imported rules absent from the snapshot.            |
| Deliveries               | Every idempotency key in the 90-day window, including orphaned rule history. Verify original rule/resource/run IDs, status, attempts, last error, HTTP status and timestamps. Account for each pending event. |
| Recorded runs and writes | Counters by workspace and run in the seven-day window. Check every sequence, connection, user, flags, timestamp and sanitized request. A reserved counter can exceed the number of persisted writes.          |
| Model catalog            | Every snapshot key present in either store, including its data, item count and timestamp. Inspect intentional merges of capabilities or curation when PG already held newer data.                             |
| Box policy               | Each marker ID and its earliest tracking date.                                                                                                                                                                |

Replay uses the same ID, timestamp and request normalization as the copy and compares nested JSON values. Reports contain field names and aggregate counts only. Keep channel settings, request bodies and catalog values out of release logs.
