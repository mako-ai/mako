/**
 * dbt run orchestration.
 *
 * - dbtRunExecutorFunction: executes a queued DbtRun. One step.run per
 *   command (each must finish inside the Cloud Run request timeout), with
 *   batched log writes into dbt_runs.logs and artifact upload to the
 *   artifact store. Secrets never cross step boundaries — every step loads
 *   the project snapshot + decrypted profile itself. Concurrency (lanes and
 *   the per-job lock) is described in dbt/dbt-run-queue.ts.
 * - dbtSchedulerFunction: cron sweep over due dbt_jobs with the same
 *   optimistic claim pattern as scheduled-query.ts.
 * - dbtRunCancelFunction: companion that finalizes runs killed by cancelOn.
 */

import { Types } from "mongoose";
import {
  claimScheduledRun,
  findDueScheduledRuns,
} from "../../services/scheduled-run-claim";
import { inngest } from "../client";
import {
  DbtJob,
  DbtProject,
  DbtRun,
  type DbtRunStatus,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { parseDbtCommand } from "../../dbt/commands";
import { loadDbtProjectSnapshot } from "../../dbt/dbt-project.service";
import { loadLocalOverlay } from "../../dbt/local-overlay";
import {
  collectProfileSecrets,
  createSecretRedactor,
} from "../../dbt/log-redaction";
import {
  parseSourceFreshness,
  parseStepResults,
  runDbt,
  type DbtLogLine,
} from "../../dbt/runner.service";
import {
  autoDisableDbtJob,
  DBT_AUTO_DISABLE_AFTER_FAILURES,
  DbtJobDefinitionMissingError,
  DbtJobNotScheduledAtCommitError,
  finalizeCancelledDbtRun,
  promotesProdManifest,
  triggerDbtJobRun,
} from "../../dbt/dbt-run.service";
import { dbtRunLabelEnv } from "../../dbt/dbt-run-labels";
import {
  emitDbtJobAutoDisabledEvent,
  emitDbtRunTerminalEvent,
} from "../../dbt/dbt-run-notify";
import {
  dbtProjectRunConcurrency,
  dbtRunFallbackQueueKeys,
  dbtRunWarmDirOwner,
} from "../../dbt/dbt-run-queue";
import { resolveProdLikeEnvironmentName } from "../../dbt/dbt-environments.service";
import {
  registerActiveRun,
  unregisterActiveRun,
  type ActiveRunControl,
} from "../../dbt/dbt-run-registry";
import {
  cancelBigQueryJobs,
  extractBigQueryJobIds,
  type ParsedBigQueryJob,
} from "../../dbt/bigquery-cancel.service";
import {
  computePackagesHash,
  loadDbtCaches,
  saveParseCache,
  savePackagesCache,
} from "../../dbt/dbt-cache.service";
import {
  warmDirsEnabled,
  withProjectDir,
} from "../../dbt/workspace-dir.service";
import { getArtifactStore } from "../../services/artifact-store.service";

const logger = loggers.inngest("dbt");

const MAX_LOG_LINES = 5000;
const LOG_FLUSH_INTERVAL_MS = 2000;

function extractShowPreview(logs: DbtLogLine[]): string {
  const infoLines = logs
    .filter(log => log.level === "info")
    .map(log => log.line);
  const markerIndex = infoLines.findIndex(line => line.includes("Previewing"));
  return (markerIndex >= 0 ? infoLines.slice(markerIndex) : infoLines)
    .join("\n")
    .slice(0, 8_000);
}

/** Buffered writer for dbt_runs.logs — capped, batched $push. */
function createLogWriter(runId: Types.ObjectId) {
  let buffer: DbtLogLine[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = Promise.resolve();

  const flush = () => {
    if (buffer.length === 0) return flushing;
    const lines = buffer;
    buffer = [];
    flushing = flushing.then(async () => {
      await DbtRun.updateOne(
        { _id: runId },
        {
          $push: {
            logs: {
              $each: lines.map(line => ({
                ts: line.ts,
                level: line.level,
                line: line.line.slice(0, 2000),
              })),
              $slice: -MAX_LOG_LINES,
            },
          },
          // The absolute line count, so a follower's cursor survives the
          // $slice above (GET /dbt/local-runs/:id).
          $inc: { logTotal: lines.length },
        },
      ).catch(error => {
        logger.warn("dbt log flush failed", { error, runId: runId.toString() });
      });
    });
    return flushing;
  };

  return {
    onLog: (line: DbtLogLine) => {
      buffer.push(line);
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, LOG_FLUSH_INTERVAL_MS);
      }
    },
    finish: async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
    },
  };
}

interface DbtRunRequestedEvent {
  workspaceId: string;
  projectId: string;
  runId: string;
  jobId?: string;
  /** Concurrency keys (dbtRunQueueKeys). Absent on events sent before lanes. */
  laneKey?: string;
  lockKey?: string;
}

/**
 * Runs of one project and lane that execute at once. Read once at load:
 * Inngest takes the limit from the function definition, not per event.
 */
const DBT_PROJECT_RUN_CONCURRENCY = dbtProjectRunConcurrency();

/**
 * Mutable, process-local state backing a run's {@link ActiveRunControl}. The
 * BigQuery credentials are filled in lazily once the executor loads the project
 * snapshot inside the command step (so the registry can cancel warehouse jobs
 * even though the registration happens before the snapshot is available).
 */
interface DbtRunCancelState {
  bqJobs: Map<string, ParsedBigQueryJob>;
  bqCredentials?: Record<string, unknown>;
  bqLocation?: string;
}

/**
 * Scan a streamed dbt log line for BigQuery job ids and remember them so a
 * cancel can stop the warehouse query, not just the local subprocess.
 */
function captureBigQueryJobs(state: DbtRunCancelState, line: string): void {
  for (const job of extractBigQueryJobIds(line)) {
    state.bqJobs.set(job.jobId, job);
  }
}

/** Read an artifact key into a Buffer, or undefined if missing/unreadable. */
async function readArtifactBuffer(
  key: string | undefined,
): Promise<Buffer | undefined> {
  if (!key) return undefined;
  try {
    const stream = await getArtifactStore().openReadStream(key);
    if (!stream) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    logger.warn("dbt restore artifact read failed", { error, key });
    return undefined;
  }
}

export const dbtRunExecutorFunction = inngest.createFunction(
  {
    id: "dbt-run-executor",
    name: "Execute dbt Run",
    retries: 0,
    concurrency: [
      // Per project and lane: jobs and builds in one, validation runs
      // (parse / compile / show) in the other, so neither waits on the other.
      { key: "event.data.laneKey", limit: DBT_PROJECT_RUN_CONCURRENCY },
      // Never two runs of the same job, whatever the lane limit is.
      { key: "event.data.lockKey", limit: 1 },
    ],
    cancelOn: [
      {
        event: "dbt/run.cancel",
        if: "async.data.runId == event.data.runId",
      },
    ],
    triggers: { event: "dbt/run.requested" },
  },
  async ({ event, step }) => {
    const data = event.data as DbtRunRequestedEvent;
    const runObjectId = new Types.ObjectId(data.runId);

    // An event sent before lanes shipped carries no concurrency keys, so
    // every such event of every project holds the same empty key. Send it
    // again with its own keys and stop: the copy queues where it belongs.
    // The copy always carries both keys, so this never loops.
    if (!data.laneKey || !data.lockKey) {
      const keys = await step.run("derive-queue-keys", async () => {
        const run = await DbtRun.findById(runObjectId)
          .select("jobId lane status")
          .lean();
        // Cancelled or timed out while it waited: nothing left to queue.
        if (!run || run.status !== "queued") return null;
        return dbtRunFallbackQueueKeys(data, run);
      });
      if (!keys) return { runId: data.runId, status: "skipped" };
      await step.sendEvent("requeue-with-queue-keys", {
        // One copy per run, whatever retries the step.
        id: `dbt-run-requeue:${data.runId}`,
        name: "dbt/run.requested",
        data: { ...data, ...keys },
      });
      logger.info("Requeued a dbt run that carried no queue keys", {
        runId: data.runId,
        projectId: data.projectId,
        ...keys,
      });
      return { runId: data.runId, status: "requeued" };
    }

    const runInfo = await step.run("mark-running", async () => {
      const run = await DbtRun.findOneAndUpdate(
        { _id: runObjectId, status: "queued" },
        { $set: { status: "running", startedAt: new Date() } },
        { returnDocument: "after" },
      ).lean();
      if (!run) return null;

      // Slim CI: resolve the project's last prod manifest so the executor can
      // run `--defer --state`. Applies to (a) scheduled/deploy jobs that opt in
      // via deferToProduction, (b) PR CI runs (unless the project's CI config
      // disables defer), and (c) ad-hoc/agent runs that set the run-level
      // deferToProduction flag (fast iteration in personal dev schemas).
      let deferStateKey: string | null = null;
      const job = run.jobId
        ? await DbtJob.findById(run.jobId)
            .select("slug deferToProduction")
            .lean()
        : null;
      // Job runs carry the defer flag of the definition they were triggered
      // from (the job file at the run's commit). Only a run queued before
      // that was stored falls back to the row.
      const wantsDefer =
        run.deferToProduction ??
        (run.jobId ? Boolean(job?.deferToProduction) : false);
      if (wantsDefer) {
        const project = await DbtProject.findById(run.projectId)
          .select("lastProdManifestKey")
          .lean();
        deferStateKey =
          (project as { lastProdManifestKey?: string })?.lastProdManifestKey ??
          null;
      }

      return {
        environment: run.environment,
        commands: run.commands,
        gitBranch: run.gitBranch ?? null,
        workingTreeUserId: run.workingTreeUserId ?? null,
        sourceSha: run.sourceSha ?? null,
        localOverlayKey: run.localOverlay?.key ?? null,
        // A laptop run builds in its owner's own warm dir, like a
        // working-tree build: never the shared committed-deploy dir.
        triggeredBy: run.triggeredBy,
        trigger: run.trigger,
        lane: run.lane ?? "job",
        jobId: run.jobId?.toString(),
        jobSlug: job?.slug,
        // Per-run vars of a manual trigger. Not secrets: they are stored on
        // the run and echoed back by the run APIs.
        overrideVars: run.overrides?.vars ?? null,
        restoreArtifactKeys: run.restoreArtifactKeys
          ? {
              runResults: run.restoreArtifactKeys.runResults,
              manifest: run.restoreArtifactKeys.manifest,
            }
          : null,
        deferStateKey,
      };
    });

    if (!runInfo) {
      // Already cancelled or duplicate delivery.
      return { skipped: true };
    }

    let failed = false;
    let errorMessage: string | undefined;
    let unexpectedError: unknown;
    const allStepResults: ReturnType<typeof parseStepResults> = [];

    // Cancellation plumbing: an AbortController whose signal is passed into
    // every runDbt call so a cancel can SIGTERM/SIGKILL the dbt subprocess, and
    // a registry handle the cancel API path uses to reach this process. The
    // BigQuery credentials are populated lazily from the snapshot below.
    const controller = new AbortController();
    const cancelState: DbtRunCancelState = { bqJobs: new Map() };
    const runControl: ActiveRunControl = {
      abort: reason => controller.abort(reason),
      cancelWarehouseJobs: async () => {
        if (!cancelState.bqCredentials || cancelState.bqJobs.size === 0) return;
        await cancelBigQueryJobs({
          credentials: cancelState.bqCredentials,
          defaultLocation: cancelState.bqLocation,
          jobs: [...cancelState.bqJobs.values()],
        });
      },
    };
    registerActiveRun(data.runId, runControl);

    try {
      for (let i = 0; i < runInfo.commands.length; i++) {
        const commandText = runInfo.commands[i];

        const stepOutcome = await step.run(`exec-cmd-${i}`, async () => {
          // Snapshot (files + decrypted profile) is loaded inside the step so
          // credentials never land in Inngest step state.
          const snapshot = await loadDbtProjectSnapshot({
            workspaceId: data.workspaceId,
            projectId: data.projectId,
            environmentName: runInfo.environment,
            // Deploy/CI runs build a branch's COMMITTED base tree; agent
            // verification builds set workingTreeUserId to include that
            // user's draft overlay. Default: the project default branch.
            branch: runInfo.gitBranch ?? undefined,
            userId: runInfo.workingTreeUserId ?? undefined,
            // The commit pinned at trigger time, so every command builds the
            // same tree whichever instance runs it.
            commit: runInfo.sourceSha ?? undefined,
            // `mako dbt run`: the developer's uploaded files over their base.
            overlay: runInfo.localOverlayKey
              ? await loadLocalOverlay(runInfo.localOverlayKey)
              : undefined,
          });
          // Stash BigQuery credentials so a cancel can stop in-flight warehouse
          // jobs (best-effort; no-op for non-BigQuery adapters).
          if (snapshot.profile.adapterPackage === "dbt-bigquery") {
            const keyfile = snapshot.profile.keyfiles[0]?.content;
            if (keyfile) {
              try {
                cancelState.bqCredentials = JSON.parse(keyfile) as Record<
                  string,
                  unknown
                >;
              } catch {
                /* malformed keyfile — dbt surfaces its own error */
              }
            }
          }
          const parsed = parseDbtCommand(commandText);
          const logWriter = createLogWriter(runObjectId);
          // What the runner injects (DBT_SECRET_* values, keyfile secrets)
          // never reaches the stored log — dbt code, a laptop's included,
          // could otherwise print it straight back to whoever started the run.
          const redact = createSecretRedactor(
            collectProfileSecrets(snapshot.profile),
          );
          // Tee the log stream to both the DB writer and the BQ job scraper.
          const onLog = (line: DbtLogLine) => {
            captureBigQueryJobs(cancelState, line.line);
            logWriter.onLog({ ...line, line: redact(line.line) });
          };

          onLog({
            ts: new Date(),
            level: "info",
            line: `$ dbt ${parsed.argv.join(" ")}`,
          });

          // Retry runs seed the prior run_results.json into target/ so
          // `dbt retry` resumes at the failed/skipped nodes.
          const restoreKeys = runInfo.restoreArtifactKeys;
          const restoreTarget = restoreKeys
            ? {
                runResults: await readArtifactBuffer(restoreKeys.runResults),
                manifest: await readArtifactBuffer(restoreKeys.manifest),
              }
            : undefined;
          const deferState = await readArtifactBuffer(
            runInfo.deferStateKey ?? undefined,
          );

          // Warm caches: skip a full re-parse (and `dbt deps` when packages are
          // unchanged) by seeding the previous command/run's state. Best-effort.
          const cacheScope = {
            workspaceId: data.workspaceId,
            projectId: data.projectId,
            environment: runInfo.environment,
          };
          const packagesHash = computePackagesHash(snapshot.files);
          const caches = await loadDbtCaches(cacheScope, packagesHash);

          try {
            // Deploy builds run in a warm dir (role=run), separate from the
            // interactive (adhoc) dir so the two never block each other. The
            // artifact caches above seed a cold instance; thereafter target/ and
            // dbt_packages/ stay warm on disk across steps and runs.
            const runOnce = (workingDir?: string) =>
              runDbt({
                files: snapshot.files,
                profile: snapshot.profile,
                commands: [parsed],
                dbtVersion: snapshot.project.dbtVersion,
                // Run overrides win over the environment's vars, for this
                // run only.
                vars: runInfo.overrideVars
                  ? { ...snapshot.environment.vars, ...runInfo.overrideVars }
                  : snapshot.environment.vars,
                // Run identity for warehouse job labels (non-secret).
                extraEnv: dbtRunLabelEnv({
                  runId: data.runId,
                  trigger: runInfo.trigger,
                  jobId: runInfo.jobId,
                  jobSlug: runInfo.jobSlug,
                }),
                // Cloud Run services deploy with --timeout=3600; leave buffer for
                // snapshot loading + artifact upload within the step request.
                commandTimeoutMs: 50 * 60 * 1000,
                restoreTarget,
                deferState,
                seedPartialParse: caches.partialParse,
                seedPackagesArchive: caches.packages,
                skipDeps: caches.packagesFresh,
                packagesHash,
                workingDir,
                signal: controller.signal,
                onLog,
              });

            let result: Awaited<ReturnType<typeof runDbt>> | undefined;
            if (warmDirsEnabled()) {
              try {
                result = await withProjectDir(
                  {
                    ...cacheScope,
                    role: "run",
                    // Working-tree (agent verification) builds materialize a
                    // user's draft overlay — isolate them in a per-user dir so
                    // they can never reconcile the shared committed-deploy dir
                    // into a draft state. Runs that may execute at once
                    // (the interactive lane, parallel jobs) never share a
                    // dir either: see dbtRunWarmDirOwner.
                    userId: dbtRunWarmDirOwner(
                      { ...runInfo, runId: data.runId },
                      DBT_PROJECT_RUN_CONCURRENCY,
                    ),
                  },
                  dir => runOnce(dir),
                );
                // Positive signal so warm-dir engagement on the executor is
                // observable; pairs with the fallback warn for a success rate.
                logger.info("dbt warm dir used", {
                  event: "dbt_warm_dir",
                  outcome: "hit",
                  role: "run",
                  projectId: cacheScope.projectId,
                  environment: cacheScope.environment,
                });
              } catch (warmError) {
                logger.warn(
                  "Warm dir run failed; falling back to throwaway dir",
                  {
                    event: "dbt_warm_dir",
                    outcome: "fallback",
                    role: "run",
                    error: String(warmError),
                    projectId: cacheScope.projectId,
                    environment: cacheScope.environment,
                  },
                );
              }
            }
            if (!result) result = await runOnce(undefined);

            // Persist refreshed caches for the next command/run.
            // Skip the re-upload when nothing changed (the seeded cache is still
            // current); the msgpack's embedded timestamps would otherwise make
            // every hourly run re-push an effectively identical blob.
            if (
              result.artifacts.partialParse &&
              (result.projectChanged || !caches.partialParse)
            ) {
              await saveParseCache(cacheScope, result.artifacts.partialParse);
            }
            if (result.artifacts.packagesArchive && packagesHash) {
              await savePackagesCache(
                cacheScope,
                result.artifacts.packagesArchive,
                packagesHash,
              );
            }

            const commandResult = result.commandResults[0];
            const stepResults = [
              ...parseStepResults(commandResult?.runResults),
              ...parseSourceFreshness(result.artifacts.sources),
            ].map(step =>
              step.message ? { ...step, message: redact(step.message) } : step,
            );

            // Upload artifacts after every command — the last successful
            // upload wins, which matches dbt's own target/ behavior.
            const store = getArtifactStore();
            const prefix = `dbt-artifacts/${data.workspaceId}/${data.runId}`;
            const artifactKeys: Record<string, string> = {};
            const uploads: Array<[string, Buffer | undefined, string]> = [
              ["manifest", result.artifacts.manifest, "manifest.json"],
              ["runResults", result.artifacts.runResults, "run_results.json"],
              ["catalog", result.artifacts.catalog, "catalog.json"],
              ["sources", result.artifacts.sources, "sources.json"],
            ];
            for (const [kind, buffer, filename] of uploads) {
              if (!buffer) continue;
              const key = `${prefix}/${filename}`;
              try {
                await store.putBuffer(buffer, key, "application/json");
                artifactKeys[kind] = key;
              } catch (uploadError) {
                logger.warn("dbt artifact upload failed", {
                  error: uploadError,
                  key,
                });
              }
            }

            const update: Record<string, unknown> = {};
            for (const [kind, key] of Object.entries(artifactKeys)) {
              update[`artifactKeys.${kind}`] = key;
            }
            if (parsed.subcommand === "show" && commandResult?.logLines) {
              update.output = {
                kind: "show-preview",
                text: extractShowPreview(commandResult.logLines),
              };
            }
            // dbt's invocation id joins this command to the
            // `dbt_invocation_id` label on its warehouse jobs. Pushed per
            // command, so the array is in command order.
            const push: Record<string, unknown> = {
              ...(stepResults.length > 0
                ? { stepResults: { $each: stepResults } }
                : {}),
              ...(commandResult?.invocationId
                ? { invocationIds: commandResult.invocationId }
                : {}),
            };
            if (
              Object.keys(push).length > 0 ||
              Object.keys(update).length > 0
            ) {
              await DbtRun.updateOne(
                { _id: runObjectId },
                {
                  ...(Object.keys(update).length > 0 ? { $set: update } : {}),
                  ...(Object.keys(push).length > 0 ? { $push: push } : {}),
                },
              );
            }

            return {
              exitCode: commandResult?.exitCode ?? 1,
              success: result.success,
              stepResultCount: stepResults.length,
              failedSteps: stepResults.filter(
                stepResult =>
                  stepResult.status === "error" || stepResult.status === "fail",
              ).length,
            };
          } finally {
            await logWriter.finish();
          }
        });

        if (!stepOutcome.success) {
          failed = true;
          errorMessage = `dbt command "${commandText}" exited with code ${stepOutcome.exitCode}`;
          break;
        }
      }
    } catch (error) {
      // A step threw instead of returning a non-zero dbt exit code: snapshot
      // load, artifact upload, the post-command DbtRun.updateOne, a per-command
      // timeout, etc. Without catching here the function would reject and the
      // "finalize-run" step below would never run, leaving the doc stuck on
      // "running" (logs show dbt finished, but the status pill never flips).
      // Route the failure through the same finalizer so the run always
      // terminates, then rethrow after finalize for Inngest observability
      // (mirrors scheduled-query.ts).
      failed = true;
      errorMessage =
        error instanceof Error
          ? error.message
          : "dbt run executor failed unexpectedly";
      unexpectedError = error;
      logger.error("dbt run executor step threw; finalizing as error", {
        runId: data.runId,
        error,
      });
    } finally {
      unregisterActiveRun(data.runId, runControl);
    }

    const finalizeResult = await step.run("finalize-run", async () => {
      const completedAt = new Date();
      // Set when this run's failure auto-disabled its job.
      let autoDisabledAfter: number | null = null;
      const run = await DbtRun.findById(runObjectId)
        .select("startedAt status cancelledAt cancelledBy")
        .lean();

      // Detect cancellation from the PERSISTED marker, not the in-memory
      // AbortController: Inngest replays the function body (and recreates the
      // controller) on each step, so `controller.signal.aborted` is only true
      // in the invocation that ran the subprocess — not in the later
      // finalize-run replay. requestDbtRunCancel stages cancelledAt/cancelledBy
      // (or flips status to "cancelled") before aborting, so the marker is
      // durable. Without this a cancelled run would finalize as "error".
      if (run?.status === "cancelled" || run?.cancelledAt) {
        await finalizeCancelledDbtRun(runObjectId, run?.cancelledBy);
        logger.info("dbt run cancelled; finalized", { runId: data.runId });
        return false;
      }

      const durationMs = run?.startedAt
        ? completedAt.getTime() - new Date(run.startedAt).getTime()
        : undefined;

      const terminalWrite = await DbtRun.updateOne(
        { _id: runObjectId, status: "running" },
        {
          $set: {
            status: failed ? "error" : "success",
            completedAt,
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(errorMessage ? { error: errorMessage } : {}),
          },
        },
      );
      // Someone else already wrote the terminal status (the stale-run
      // sweeper, or a cancel that landed after the read above). That writer
      // owns the job stats and the notification: doing them again here would
      // count the run twice and notify twice.
      if (terminalWrite.modifiedCount === 0) {
        logger.warn("dbt run already finalized elsewhere; skipping", {
          runId: data.runId,
        });
        return false;
      }

      if (runInfo.jobId) {
        const updatedJob = await DbtJob.findOneAndUpdate(
          { _id: new Types.ObjectId(runInfo.jobId) },
          {
            $set: {
              "scheduledRun.lastAt": completedAt,
              "scheduledRun.lastStatus": failed ? "error" : "success",
              "scheduledRun.lastError": failed ? errorMessage : undefined,
              ...(durationMs !== undefined
                ? { "scheduledRun.lastDurationMs": durationMs }
                : {}),
              ...(failed ? {} : { "scheduledRun.consecutiveFailures": 0 }),
            },
            $inc: {
              "scheduledRun.runCount": 1,
              ...(failed ? { "scheduledRun.consecutiveFailures": 1 } : {}),
            },
          },
          { returnDocument: "after" },
        );

        // Stop a broken scheduled job from hammering the warehouse forever:
        // after a threshold of consecutive failures, disable the schedule and
        // surface why. Re-enabling the job resets the count
        // (applyJobScheduleChange), so it gets a full threshold again.
        const failures = updatedJob?.scheduledRun?.consecutiveFailures ?? 0;
        if (
          failed &&
          updatedJob?.enabled &&
          updatedJob.schedule?.cron &&
          DBT_AUTO_DISABLE_AFTER_FAILURES > 0 &&
          failures >= DBT_AUTO_DISABLE_AFTER_FAILURES
        ) {
          // Flips the row first, so a failed yml commit cannot leave the job
          // enabled.
          await autoDisableDbtJob(updatedJob, failures, errorMessage);
          autoDisabledAfter = failures;
        }
      }

      // Keep the last successful prod manifest as the state artifact for
      // --defer / state:modified+ (Slim CI, later phase).
      if (!failed) {
        const finishedRun = await DbtRun.findById(runObjectId)
          .select(
            "artifactKeys environment gitBranch workingTreeUserId localOverlay",
          )
          .lean();
        if (finishedRun?.artifactKeys?.manifest) {
          const project = await DbtProject.findById(
            new Types.ObjectId(data.projectId),
          )
            .select("environments defaultEnvironment prodEnvironment")
            .lean();
          // Single source of truth for what counts as production (explicit
          // prodEnvironment setting > "prod" by name > project default).
          const prodLike =
            project != null &&
            finishedRun.environment === resolveProdLikeEnvironmentName(project);
          // Only a build of committed main is prod state: never a laptop
          // overlay, a working tree or a PR head (promotesProdManifest).
          if (promotesProdManifest(finishedRun, prodLike)) {
            await DbtProject.updateOne(
              { _id: new Types.ObjectId(data.projectId) },
              {
                $set: {
                  lastProdManifestKey: finishedRun.artifactKeys.manifest,
                },
              },
            );
          }
        }
      }
      return { autoDisabledAfter };
    });
    const finalized = finalizeResult !== false;

    // Notification rules on the job or its project. Its own step, after the
    // terminal status is stored, so a retry of anything above never emits
    // twice. Only the writer of the terminal status emits.
    if (finalized) {
      await step.run("emit-terminal-event", () =>
        emitDbtRunTerminalEvent(data.runId),
      );
    }

    // The job stops running from here on, so its failure rules would hear
    // nothing more. Tell them once that it was disabled, and why. A rule on
    // the default cadence got no post for this run (the previous one had
    // failed too), so this is the one message that says the job is off.
    const autoDisabledAfter =
      finalizeResult !== false ? finalizeResult.autoDisabledAfter : null;
    if (autoDisabledAfter) {
      await step.run("emit-job-auto-disabled-event", () =>
        emitDbtJobAutoDisabledEvent(data.runId, autoDisabledAfter),
      );
    }

    // Surface unexpected executor failures (a thrown step rather than a clean
    // non-zero dbt exit) to Inngest after the run doc has been finalized as
    // "error", so alerting still fires without leaving the run "running".
    if (unexpectedError) {
      throw unexpectedError instanceof Error
        ? unexpectedError
        : new Error(String(unexpectedError));
    }

    return {
      runId: data.runId,
      status: failed ? "error" : "success",
      stepResults: allStepResults.length,
    };
  },
);

/**
 * Finalize runs whose executor was killed by cancelOn. Waits briefly so the
 * in-flight subprocess SIGTERM (queued runs are finalized synchronously by
 * requestDbtRunCancel) settles, then flips any still-active status.
 */
export const dbtRunCancelFunction = inngest.createFunction(
  {
    id: "dbt-run-cancel-finalizer",
    name: "Finalize cancelled dbt Run",
    retries: 1,
    triggers: { event: "dbt/run.cancel" },
  },
  async ({ event, step }) => {
    const { runId, cancelledBy } = event.data as {
      runId: string;
      cancelledBy?: string;
    };
    await step.sleep("allow-executor-teardown", "10s");
    await step.run("finalize-cancelled", async () => {
      await finalizeCancelledDbtRun(new Types.ObjectId(runId), cancelledBy);
    });
    return { runId };
  },
);

export const dbtSchedulerFunction = inngest.createFunction(
  {
    id: "dbt-job-scheduler",
    name: "Run Scheduled dbt Jobs",
    triggers: { cron: "*/1 * * * *" },
  },
  async ({ step }) => {
    const now = new Date();

    const dueJobs = await step.run("fetch-due-dbt-jobs", () =>
      findDueScheduledRuns(DbtJob, now, { enabled: true }),
    );

    let triggered = 0;
    for (const dueJob of dueJobs) {
      if (!dueJob.schedule?.cron || !dueJob.schedule?.timezone) continue;

      // Optimistic claim — only the instance that flips nextAt triggers.
      const updateResult = await step.run(
        `claim-${dueJob.id}-${dueJob.nextAt?.toString() ?? "none"}`,
        () => claimScheduledRun(DbtJob, dueJob, now),
      );

      if (updateResult.modifiedCount === 0) continue;

      const outcome = await step.run(`trigger-${dueJob.id}`, async () => {
        const job = await DbtJob.findById(new Types.ObjectId(dueJob.id));
        if (!job) return null;
        try {
          // Returns the active run when the tick collapsed onto it; the
          // service counts that tick on the job.
          const run = await triggerDbtJobRun({
            workspaceId: dueJob.workspaceId,
            job,
            trigger: "schedule",
            triggeredBy: "scheduler",
          });
          return { runId: run._id.toString() };
        } catch (error) {
          // The job file is gone at the commit the run would build. Not a
          // failure to retry: the tick is skipped (and counted) and the
          // config sync removes the row.
          if (error instanceof DbtJobDefinitionMissingError) {
            return { skipped: "definition_missing", reason: error.message };
          }
          // The job file at that commit turned the schedule off (disabled,
          // or no schedule) and the row has not caught up. Same handling:
          // the tick is skipped and counted, and the sync fixes the row.
          if (error instanceof DbtJobNotScheduledAtCommitError) {
            return { skipped: error.reason, reason: error.message };
          }
          throw error;
        }
      });
      if (outcome && "runId" in outcome) triggered++;
    }

    return { checked: dueJobs.length, triggered };
  },
);

/**
 * Sweep dbt runs whose executor died (instance crash/recycle mid-step).
 * With retries: 0 Inngest never re-invokes the executor, so the run doc
 * would stay "running" forever. A live run always has log activity (2s
 * flush cadence) and a 50m per-command timeout, so >60m of log silence
 * means the process is gone.
 */
const DBT_RUN_STALL_MS = 60 * 60 * 1000;
const DBT_RUN_QUEUED_STALL_MS = 6 * 60 * 60 * 1000;

/**
 * dbt prints a terminal summary on its final stdout lines when the process
 * exits ("Completed successfully" / "Done. PASS=.. ERROR=.. .. TOTAL=.."). When
 * those lines are present the subprocess has definitively finished, so a
 * "running" doc with no completedAt means the executor died during post-run
 * finalization (artifact upload, the status write, or an instance recycle
 * between steps). These can be finalized within minutes — and with the real
 * success/error recovered from the summary — instead of waiting out the full
 * DBT_RUN_STALL_MS log-silence window.
 */
const DBT_RUN_DONE_GRACE_MS = 2 * 60 * 1000;

/**
 * Recover a run outcome from the tail of dbt's streamed logs. Returns the
 * detected status, or null when dbt has not clearly finished (so the slow
 * log-silence rule still applies).
 */
function detectDbtTerminalOutcome(
  logs: Array<{ line?: string }> | undefined,
): DbtRunStatus | null {
  if (!logs?.length) return null;
  // Newest lines are last; a small tail is enough to catch the summary block.
  const tail = logs
    .map(entry => entry.line ?? "")
    .slice(-8)
    .join("\n");
  // `dbt build/run/test` summary, e.g. "Done. PASS=133 WARN=0 ERROR=0 ...".
  const doneMatch = tail.match(/Done\.\s+PASS=\d+[^\n]*?ERROR=(\d+)/);
  if (doneMatch) {
    return Number(doneMatch[1]) > 0 ? "error" : "success";
  }
  // Non-build commands (compile/debug/parse) end with a plain banner.
  if (/Completed successfully/.test(tail)) return "success";
  if (/Encountered an error|Completed with \d+ error/.test(tail)) {
    return "error";
  }
  return null;
}

/**
 * Run-history retention. dbt_runs embed capped logs + stepResults and would
 * otherwise grow unbounded. The parent job preserves last status/error in
 * `scheduledRun`, so pruning completed history rows past the window is safe.
 * Override with DBT_RUN_RETENTION_DAYS.
 */
const DBT_RUN_RETENTION_DAYS = Number(
  process.env.DBT_RUN_RETENTION_DAYS ?? "30",
);

export const dbtRunSweeperFunction = inngest.createFunction(
  {
    id: "dbt-run-sweeper",
    name: "Cleanup Abandoned dbt Runs",
    triggers: { cron: "*/5 * * * *" },
  },
  async ({ step }) => {
    const swept = await step.run("sweep-abandoned-dbt-runs", async () => {
      const now = Date.now();

      // Active runs are rare; fetch and filter in JS so we can look at the
      // last log timestamp (capped array — $slice: -1 keeps this cheap).
      const activeRuns = await DbtRun.find({
        status: { $in: ["queued", "running"] },
      })
        .select({
          status: 1,
          startedAt: 1,
          createdAt: 1,
          jobId: 1,
          logs: { $slice: -8 },
        })
        .lean();

      // Classify each active run that needs sweeping, recovering the real
      // outcome from dbt's terminal log summary where possible.
      const abandoned: Array<{
        run: (typeof activeRuns)[number];
        status: DbtRunStatus;
        error: string;
        recoveredFromLogs: boolean;
      }> = [];

      for (const run of activeRuns) {
        if (run.status === "queued") {
          // Queued runs can legitimately wait for a lane slot or behind a
          // run of their own job — only sweep clearly lost events.
          if (now - run.createdAt.getTime() > DBT_RUN_QUEUED_STALL_MS) {
            abandoned.push({
              run,
              status: "error",
              error:
                "Run abandoned — queued event never executed (lost event or stuck behind concurrency lock)",
              recoveredFromLogs: false,
            });
          }
          continue;
        }

        const lastLine = run.logs?.[run.logs.length - 1];
        const lastActivity = lastLine?.ts ?? run.startedAt ?? run.createdAt;
        const idleMs = now - new Date(lastActivity).getTime();

        // Fast path: dbt printed its terminal summary, so the subprocess
        // finished and only finalization was lost. Recover the true outcome
        // after a short grace instead of waiting out DBT_RUN_STALL_MS.
        const terminalOutcome = detectDbtTerminalOutcome(run.logs);
        if (terminalOutcome && idleMs > DBT_RUN_DONE_GRACE_MS) {
          abandoned.push({
            run,
            status: terminalOutcome,
            error:
              terminalOutcome === "error"
                ? "Run finalized from dbt output — executor died after dbt reported errors"
                : "",
            recoveredFromLogs: true,
          });
          continue;
        }

        // Slow path: no terminal summary — prolonged log silence means the
        // executor process is gone (instance crash/deploy mid-step).
        if (idleMs > DBT_RUN_STALL_MS) {
          abandoned.push({
            run,
            status: "error",
            error:
              "Run abandoned — executor terminated without finalizing (instance crash or deploy)",
            recoveredFromLogs: false,
          });
        }
      }

      const sweptRunIds: string[] = [];
      for (const { run, status, error, recoveredFromLogs } of abandoned) {
        const failedRun = status === "error";
        const completedAt = new Date();
        const updated = await DbtRun.updateOne(
          { _id: run._id, status: { $in: ["queued", "running"] } },
          {
            $set: {
              status,
              completedAt,
              ...(error ? { error } : {}),
              ...(run.startedAt
                ? {
                    durationMs:
                      completedAt.getTime() - new Date(run.startedAt).getTime(),
                  }
                : {}),
            },
          },
        );
        // Finalized concurrently by the executor or cancel finalizer.
        if (updated.modifiedCount === 0) continue;

        // Mirror finalize-run so job health stats don't silently drift.
        if (run.jobId) {
          await DbtJob.updateOne(
            { _id: run.jobId },
            {
              $set: {
                "scheduledRun.lastAt": completedAt,
                "scheduledRun.lastStatus": status,
                "scheduledRun.lastError": failedRun
                  ? error || "Run abandoned by executor"
                  : undefined,
                ...(failedRun ? {} : { "scheduledRun.consecutiveFailures": 0 }),
              },
              $inc: {
                "scheduledRun.runCount": 1,
                ...(failedRun ? { "scheduledRun.consecutiveFailures": 1 } : {}),
              },
            },
          );
        }

        logger.warn("Swept abandoned dbt run", {
          runId: run._id.toString(),
          jobId: run.jobId?.toString(),
          status,
          recoveredFromLogs,
        });
        sweptRunIds.push(run._id.toString());
      }

      // Only runs THIS sweep finalized: one the executor or the cancel
      // finalizer got to first is theirs to notify about.
      return sweptRunIds;
    });

    // A run the executor died on never reached its own emit step, so a job
    // that fails this way would otherwise fail silently. One step per run:
    // a retry of the sweep never notifies twice.
    for (const runId of swept) {
      await step.run(`emit-terminal-event-${runId}`, () =>
        emitDbtRunTerminalEvent(runId),
      );
    }

    const pruned = await step.run("prune-old-dbt-runs", async () => {
      if (
        !Number.isFinite(DBT_RUN_RETENTION_DAYS) ||
        DBT_RUN_RETENTION_DAYS <= 0
      ) {
        return 0;
      }
      const cutoff = new Date(
        Date.now() - DBT_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );
      const result = await DbtRun.deleteMany({
        status: { $in: ["success", "error", "cancelled"] },
        completedAt: { $lt: cutoff },
      });
      if (result.deletedCount) {
        logger.info("Pruned old dbt runs", {
          deleted: result.deletedCount,
          retentionDays: DBT_RUN_RETENTION_DAYS,
        });
      }
      return result.deletedCount ?? 0;
    });

    return { swept: swept.length, pruned };
  },
);
