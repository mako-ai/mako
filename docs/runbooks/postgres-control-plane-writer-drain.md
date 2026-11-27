# Verify the six Mongo control-plane writers have drained

The release lead collects this evidence after both production services have completed their preparation deployments, including the main service’s environment update. The preparation image keeps serving Mongo. These checks read deployment and migration metadata. The activation release performs the fenced copy later.

## Verify Cloud Run retirement

The main service `mako` and the independently deployed `mako-canary` both receive `PROD_DATABASE_URL`. Each owns its own endpoint and traffic split. The canary accepts API requests and runs startup catalog writes even with scheduled sync and webhook processing disabled. Prepare main through the standard production deployment and canary through the existing production migration canary workflow, using the reviewed preparation revision on master. Record both completed run IDs. Until the canary receives a prepared image through its own release, activation stays on hold.

From the preparation checkout, use the main project from `GCP_PROD_DEPLOY_CONFIG.project_id`, the canary project from `GCP_MIGRATION_PROJECT_ID`, and the workflows’ `GCP_REGION`. Run the verifier with an identity that can read services and revisions and save its JSON output in the release record.

```sh
GCP_PROJECT_ID="$PROD_PROJECT" GCP_MIGRATION_PROJECT_ID="$CANARY_PROJECT" GCP_REGION="$PROD_REGION" \
  node scripts/check-control-plane-revisions.mjs
```

The verifier reads every page of revisions, checks each service generation is fully reconciled, then rechecks both etags. Missing metadata or access to either target stops verification. The record includes the latest ready revision, traffic percentages and tags, every prepared revision and each retired unprepared revision. Check each routable prepared revision’s image digest against its approved build in the corresponding project. Confirm that its pinned pooled and direct PG secret versions resolve to the same production database and branch used by the activation job. Record secret version identifiers and the verified database/branch, without logging credentials. Zero traffic can coexist with an in-flight request. Require Cloud Run's `RETIRED` condition for each unprepared revision so old request handlers and startup/background work have lost their instances. A nonzero exit, a changed generation or an unknown revision holds activation. Activation CI repeats this read before acquiring the writer fence. [Cloud Run revision status](https://docs.cloud.google.com/run/docs/managing/revisions)

```sh
gcloud run revisions describe "$REVISION" --project="$SERVICE_PROJECT" \
  --region="$PROD_REGION" --format='value(status.imageDigest)'
```

## Account for every writer

Record the deployed owner, destination and evidence for each path. Use the release's service URL, Inngest app registration, worker configuration and job execution history. A code search identifies the expected paths. Deployment evidence establishes which binaries can actually write.

| Mongo data                        | Producers and evidence                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notification rules and deliveries | Trace rule CRUD to the prepared API. Check the Inngest registration and pending/retrying `flow-run-notification-fanout` and `notification-deliver` invocations. Their callbacks must reach the prepared service's `/api/inngest`. Record any revision-specific callback destinations and match them to the verified routes.                                                                                         |
| Recorded runs and writes          | Trace the deployed workflow/sandbox connection proxy URL to the prepared API. That API reserves the counter and inserts the write. Check running worker configurations and retries for an old direct DB writer or revision-specific endpoint.                                                                                                                                                                       |
| Catalog snapshots                 | Verify the catalog administration route, `system/model-catalog-refresh` callback and thinking-mode probes run in the prepared API. Include startup's `warmCatalog()` on every instance. Confirm the completed preparation workflow ran Mongo migrations and the `migrations` record for `2026-04-23-180000_seed_model_curation` has a `ran_at` date and no error. The historical seed writes catalog rows directly. |
| Box policy                        | Verify the app lifecycle routes and the `apps-box-idle-sweep` callback reach the prepared API. Check any scheduled or one-off box maintenance against the same deployment.                                                                                                                                                                                                                                          |

For source references see the [API and Inngest registration](../../api/src/index.ts), [connection proxy](../../api/src/connections/proxy.service.ts) and [job definitions](../../api/src/inngest/functions).

Both production deploy jobs share a concurrency group for their releases. Check for earlier pending or running jobs created from a pre-preparation workflow, including canary dispatches. Require those runs to finish and retain the two-service revision evidence afterwards. A historical pre-fence build cannot be used for a rollback.

Inventory other deployments, jobs, cron schedules and operator scripts with direct write access to this Mongo database. Match each identity and running image to a producer above or record why it cannot mutate these collections. For a separately deployed writer, verify its replacement uses the fence and that every old execution or pod has terminated. Check its schedule and retry destination too. For a Cloud Run job, inspect all executions of that job in its project and region. Keep execution IDs and terminal status in the release record. [Cloud Run job executions](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/executions/list)

```sh
gcloud run jobs executions list --job="$JOB" --project="$SERVICE_PROJECT" \
  --region="$PROD_REGION" --format='table(metadata.name,status.startTime,status.completionTime)'
```

Proceed to activation review when each writer has a verified prepared destination or a recorded terminal execution with future invocations routed to the replacement. Hold for an outstanding old execution, an unknown owner, or an unverified target. Requests and callbacks already using the prepared image may continue. The activation transaction waits for any prepared mutation already inside the Mongo fence, then compares the stores before transferring ownership.
