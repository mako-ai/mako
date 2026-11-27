# Control-plane cutover

## Release 1 · prepare the Mongo writer

Use the standard CI rollout. Apply the reviewed additive migration `0012` and deploy the preparation image. It serves notification rules and deliveries, recorded workflow writes and counters, model catalog snapshots and box tracking from Mongo while the durable writer-fence owner is `mongo`. Preparation does not activate Postgres. Deploy the preparation image through the main and independent migration-canary workflows. Both templates mark prepared revisions with `MAKO_CONTROL_PLANE_FENCE_V1=1`, including revisions created by the workflow's environment update.

Rule mutations, delivery reservation/completion, recorded counter reservation plus request insertion, catalog refresh/probes/curation, and box marker initialization take a write lock on the same Mongo document. Each repository executes its Mongo mutation and lock update in one replica-set transaction. This includes work already running in an HTTP request, late Inngest completions and startup's `warmCatalog()`. An operation still computing when ownership changes resolves its store at the write. An operation already inside the transaction completes or aborts before activation can get the lock. Unrelated domains keep serving. [Mongo transaction locking](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/)

After both preparation rollouts, the lead records the revision, callback and job evidence in the [writer drain procedure](postgres-control-plane-writer-drain.md). Keep activation on hold while any writer is unaccounted for. Existing reviewed migration checks include the non-null delivery rule ID without a rule FK, imported rule provenance, and the resource history ordering index.

## Release 2 · activate in CI before the ordinary deploy

1. Require prepared revisions on all main and canary routes, including tags, and confirmed retirement for each unprepared revision on both services. The second release owns the executable pre-deploy check. Keep the ordinary CI traffic rollout.
2. After the schema step and before deploying, activation takes the same Mongo fence as the prepared writers. Once it holds the lock it copies eligible rows to PG and compares the six tables using the same source snapshot and UTC cutoff. The inventory from the earlier dry run is a baseline. Compare values and IDs, not only counts. Delivery history uses a 90-day window and recorded runs and writes use seven days.
3. An unexplained field difference, missing row, PG-only row, imported rule absent from Mongo, or non-TTL skip fails the gate. The PG staging transaction rolls back. Mongo retains ownership, waiting mutations can commit there, and CI stops before creating a serving revision. A timeout also stops the handoff. Keep the reports and investigate before repeating CI. Deletion reconciliation is audit-only.
4. On clean parity, PG commits before the Mongo transaction publishes PG ownership. Prepared instances recheck ownership at every mutation, including in-flight work and startup. They can use PG immediately, even if the subsequent deployment fails. CI then runs the standard serving deploy and environment update. Activation retries after a successful handoff recognize the durable PG owner and skip the copy. Only a prepared image or its successor is suitable for a code rollback after activation.
5. For a post-switch audit, use a read-only Mongo snapshot from the recorded cutover point (preserve TTL data), a SELECT-only PG connection, and the emitted UTC cutoff. The CLI uses a repeatable-read, read-only PG transaction. Exit 0 means parity, 2 reports drift or non-TTL skips, and 1 reports execution failure. Attribute source-only rows, PG-only rows and field mismatches to post-switch activity. PG edits and deletions survive replay. Production data reconciliation requires separate authorization.

```sh
pnpm --filter api exec tsx src/database/pg/cli/backfill-control-plane-small.ts --as-of "$CUTOVER_UTC" --replay
```

The comparator checks rule configuration and encrypted channels, delivery status/attempts and historical rule IDs, run counters, each recorded sequence and sanitized request, snapshot data/count/timestamp and the earliest box marker. Release logs contain aggregate counts and field names.
