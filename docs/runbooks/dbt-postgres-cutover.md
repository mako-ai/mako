# dbt Postgres cutover

The release keeps serving dbt from Mongo until the final copy and verification commit. It leaves other Cloud Run features online. The maintainer who owns production runs these commands on the released SHA, with the production Mongo and direct Postgres environment already configured. Use a private working directory on persistent storage for the recovery files.

## Establish the writer boundary

1. Merge the dbt release, including migration 0013, after the canonical control-plane 0012. Its ordinary master deployment prepares `mako`. After it completes, dispatch `deploy-prod-canary.yml` from the same master revision to prepare `mako-canary`. These workflows deploy the Mongo-serving bridge. The lead runs activation separately after both deployments. Each service has its own endpoint and both use the production Mongo database. Capture both deployment run IDs and approved image digests. Match the serving revisions to those digests and verify that the pooled and direct Postgres secret versions on both target the activation database. The new image implements `MAKO_DBT_FENCE_V1=1`.
2. Send every traffic split, tag and Inngest callback to a prepared revision. Check the actual registered destinations of queued and retrying dbt run steps, scheduler and sweeper invocations, and workers flushing logs. Laptop clients write through the API. Record any additional process or one-off job with direct access, its prepared image or terminal execution ID, and where future invocations will go. Confirm the historical Mongo migrations, in particular `2026-09-01-000000_dbt_into_workspace_repo`, have finished. Drain executions from both older deployment workflows and hold rollout and rollback changes through activation.
3. Resolve `GCP_PROJECT_ID` from the production workflow’s `GCP_PROD_DEPLOY_CONFIG.project_id`, and `GCP_MIGRATION_PROJECT_ID` and `GCP_REGION` from the canary workflow variables. The repository also defines a legacy `GCP_PROJECT_ID` for a different project. Run the read-only check below and retain its output. It reads both services, including every page of revisions. It checks latest, tagged and traffic-receiving revisions for the dbt capability, and requires Cloud Run retirement evidence for each older revision. Cloud Run can report `Active/RETIRED` and `TrafficShutDown` while existing requests are still running. The dbt verifier waits for the separate `ResourcesAvailable/RETIRED` condition on every unprepared revision. Operators can corroborate the drain in Cloud Monitoring using `run.googleapis.com/container/instance_count` by service, revision and state. Missing access, incomplete retirement, or a service generation change stops the cutover. The importer repeats this check before publishing. The release lead owns production execution.

```sh
node scripts/check-control-plane-revisions.mjs --dbt
```

A prepared writer reads the Mongo fence generation, then checks the Postgres store marker under a short shared advisory lock. Its Mongo mutation and its conditional update of that exact generation commit in one majority-acknowledged Mongo transaction. This includes status changes, log appends and compound operations such as finishing a run and updating its job.

The final importer holds the exclusive Postgres admission lock and increments the Mongo generation. Mongo waits for every mutation already inside the old generation's transaction. A delayed writer attempting to start afterwards finds its generation expired and retries through the bridge. Losing a Postgres connection after dispatch cannot invalidate either guarantee. The importer checks both serving services immediately before and after the parity scan, and requires their inventories to match. Save both records with the cutover result. [Cloud Run revision conditions](https://docs.cloud.google.com/run/docs/reference/rest/v2/Condition)

If deployment verification or parity fails, Postgres rolls back and fresh admissions can continue in Mongo using the current generation. On an interrupted activation, rerun `--apply` against the same databases. A committed switch is one-way. New dbt operations wait outside the PG connection pool during the switch, then use Postgres. Other Cloud Run features stay online. A run may remain active across the handoff.

## Reconcile and activate

From the API package, save the absolute paths and run the CLI in the private directory. The default plan reads both stores without writing. Use read-only Mongo access for plan, pre-copy and verification. Activation additionally needs insert and update permission on the single migration fence collection. All four source collections require read access only. The release identity also needs read access to Cloud Run services and revisions in both projects and a working gcloud login.

```sh
cli="$PWD/src/database/pg/cli/backfill-dbt.ts"
tsx="$PWD/node_modules/.bin/tsx"
cd "$private_cutover_directory"
"$tsx" "$cli"
"$tsx" "$cli" --apply
```

An optional `--precopy` before activation copies eligible rows while Mongo continues serving. The shared lock prevents it from racing an activation. It never switches stores. A source ID deleted between passes is reported as target-only and blocks the switch until the operator reconciles it. The single-pass `--apply` above avoids staging rows that may subsequently be removed.

The final pass reads every extant project, preference, job and run under the exclusive fence. It reconciles runs in batches of up to 128 documents or 4 MiB of source BSON. A larger document is processed alone. It reads back persisted rows and chunks before counting them as verified. These batch boundaries are inside the activation transaction, so a late failure also rolls back earlier batches. It compares every modeled column, the absolute log cursor, contiguous chunk ranges, and all retained timestamps, levels and full line texts. The report lists source and verified run and line counts separately for older terminal runs and recent or active runs. If a source document contains more than 5,000 physical lines, the live table keeps the normal retained window and absolute cursor. The report counts its older prefix in that cohort’s `sourceLinesOutsideWindow` and the private recovery file preserves the complete original document. Valid older terminal runs enter the live table. The normal runtime sweeper keeps its existing retention policy after activation.

The CLI updates a previously imported row only if its current columns and logs still match the SHA-256 receipt from its previous import. Distinct physical Mongo documents in the same collection can map to one Postgres ID, for example a BSON ObjectId and its hex string. The CLI reports `duplicateSourceId` and blocks activation even if their contents match. Independent target edits, secondary-key collisions, skipped source IDs or target-only IDs also prevent activation. The report includes affected IDs and differing fields. The switch and all writes roll back together on failed parity. Reconcile the reported IDs before retrying. The importer never deletes a Mongo row. A detached job reference is recorded and its run and logs are retained with a null job ID.

On apply, a mode-0600 `dbt-backfill-exceptions-*.jsonl` file preserves each exception as canonical MongoDB Extended JSON, with its source ID, reasons and conflicting target ID when available. Store it with the migration evidence. A preference with an unresolvable user, such as the historic API-key sentinel, can be preserved only in this archive. To accept that disposition for a specific reviewed source ID, append `--accept-preference=SOURCE_ID` to the apply command. This exception cannot waive run parity, a key collision, or any other missing parent.

Success requires `switched=true`, `parity=true`, zero unaccounted records, and matching source and verified counts in both run cohorts. Save this output as the authoritative cutover result. On a later invocation `--verify` performs a read-only comparison and exits nonzero on divergence. A repeated `--apply` after activation also verifies without writing. Legitimate Postgres activity and runtime pruning can change those later counts.

## Verify the serving paths

Before activation, use an authorized workspace session on each service to read the dbt history list, a completed run with retained logs and a naturally active scheduled run. Save the completed run’s status, absolute log cursor and a local digest of its retained lines. Retain the active run’s cursor for the next read. Repeat those GETs on both services immediately after activation, using the original identifiers. The completed run should match on both services. Follow the active run with `logsSince` set to its saved cursor until it finishes, and verify the Postgres status and advancing log cursor while the Mongo copy stays at its cutover state.

For scheduled BigQuery builds, establish the production environment and cron from the live job. Use the Mako run’s stored run results to match successful model adapter job IDs to regional BigQuery job metadata. Check the destination table or partition update time as well as the terminal job status. Repeat for the first scheduled build after deploy and after activation if these occur in different schedule windows. Use bounded aggregate reads and keep tenant identifiers, SQL and log contents out of release reports.
