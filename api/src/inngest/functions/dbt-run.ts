/**
 * dbt run orchestration.
 *
 * - dbtRunExecutorFunction: executes a queued DbtRun. One step.run per
 *   command (each must finish inside the Cloud Run request timeout), with
 *   batched log writes into dbt_runs.logs and artifact upload to the
 *   artifact store. Secrets never cross step boundaries — every step loads
 *   the project snapshot + decrypted profile itself.
 * - dbtSchedulerFunction: cron sweep over due dbt_jobs with the same
 *   optimistic claim pattern as scheduled-query.ts.
 * - dbtRunCancelFunction: companion that finalizes runs killed by cancelOn.
 */

import { Types } from "mongoose";
import { inngest } from "../client";
import { DbtJob, DbtProject, DbtRun } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { parseDbtCommand } from "../../dbt/commands";
import { loadDbtProjectSnapshot } from "../../dbt/dbt-project.service";
import {
  parseStepResults,
  runDbt,
  type DbtLogLine,
} from "../../dbt/runner.service";
import { triggerDbtJobRun } from "../../dbt/dbt-run.service";
import { getNextScheduledConsoleRunAt } from "../../services/scheduled-query-schedule.service";
import { getDashboardArtifactStore } from "../../services/dashboard-artifact-store.service";

const logger = loggers.inngest("dbt");

const MAX_LOG_LINES = 5000;
const LOG_FLUSH_INTERVAL_MS = 2000;

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
}

/** Read an artifact key into a Buffer, or undefined if missing/unreadable. */
async function readArtifactBuffer(
  key: string | undefined,
): Promise<Buffer | undefined> {
  if (!key) return undefined;
  try {
    const stream = await getDashboardArtifactStore().openReadStream(key);
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
    concurrency: {
      key: "event.data.projectId",
      limit: 1,
    },
    cancelOn: [
      {
        event: "dbt/run.cancel",
        if: "async.data.runId == event.data.runId",
      },
    ],
  },
  { event: "dbt/run.requested" },
  async ({ event, step }) => {
    const data = event.data as DbtRunRequestedEvent;
    const runObjectId = new Types.ObjectId(data.runId);

    const runInfo = await step.run("mark-running", async () => {
      const run = await DbtRun.findOneAndUpdate(
        { _id: runObjectId, status: "queued" },
        { $set: { status: "running", startedAt: new Date() } },
        { new: true },
      ).lean();
      if (!run) return null;
      return {
        environment: run.environment,
        commands: run.commands,
        jobId: run.jobId?.toString(),
        restoreArtifactKeys: run.restoreArtifactKeys
          ? {
              runResults: run.restoreArtifactKeys.runResults,
              manifest: run.restoreArtifactKeys.manifest,
            }
          : null,
      };
    });

    if (!runInfo) {
      // Already cancelled or duplicate delivery.
      return { skipped: true };
    }

    let failed = false;
    let errorMessage: string | undefined;
    const allStepResults: ReturnType<typeof parseStepResults> = [];

    for (let i = 0; i < runInfo.commands.length; i++) {
      const commandText = runInfo.commands[i];

      const stepOutcome = await step.run(`exec-cmd-${i}`, async () => {
        // Snapshot (files + decrypted profile) is loaded inside the step so
        // credentials never land in Inngest step state.
        const snapshot = await loadDbtProjectSnapshot({
          workspaceId: data.workspaceId,
          projectId: data.projectId,
          environmentName: runInfo.environment,
        });
        const parsed = parseDbtCommand(commandText);
        const logWriter = createLogWriter(runObjectId);

        logWriter.onLog({
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

        try {
          const result = await runDbt({
            files: snapshot.files,
            profile: snapshot.profile,
            commands: [parsed],
            dbtVersion: snapshot.project.dbtVersion,
            // Cloud Run services deploy with --timeout=3600; leave buffer for
            // snapshot loading + artifact upload within the step request.
            commandTimeoutMs: 50 * 60 * 1000,
            restoreTarget,
            onLog: logWriter.onLog,
          });

          const commandResult = result.commandResults[0];
          const stepResults = parseStepResults(commandResult?.runResults);

          // Upload artifacts after every command — the last successful
          // upload wins, which matches dbt's own target/ behavior.
          const store = getDashboardArtifactStore();
          const prefix = `dbt-artifacts/${data.workspaceId}/${data.runId}`;
          const artifactKeys: Record<string, string> = {};
          const uploads: Array<[string, Buffer | undefined, string]> = [
            ["manifest", result.artifacts.manifest, "manifest.json"],
            ["runResults", result.artifacts.runResults, "run_results.json"],
            ["catalog", result.artifacts.catalog, "catalog.json"],
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
          if (stepResults.length > 0 || Object.keys(update).length > 0) {
            await DbtRun.updateOne(
              { _id: runObjectId },
              {
                ...(Object.keys(update).length > 0 ? { $set: update } : {}),
                ...(stepResults.length > 0
                  ? { $push: { stepResults: { $each: stepResults } } }
                  : {}),
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

    await step.run("finalize-run", async () => {
      const completedAt = new Date();
      const run = await DbtRun.findById(runObjectId).select("startedAt").lean();
      const durationMs = run?.startedAt
        ? completedAt.getTime() - new Date(run.startedAt).getTime()
        : undefined;

      await DbtRun.updateOne(
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
          { new: true },
        );

        // Stop a broken scheduled job from hammering the warehouse forever:
        // after a threshold of consecutive failures, disable the schedule and
        // surface why. A manual run (which resets consecutiveFailures on
        // success) re-enables normal cadence after the user re-enables it.
        const failures = updatedJob?.scheduledRun?.consecutiveFailures ?? 0;
        if (
          failed &&
          updatedJob?.enabled &&
          updatedJob.schedule?.cron &&
          DBT_AUTO_DISABLE_AFTER_FAILURES > 0 &&
          failures >= DBT_AUTO_DISABLE_AFTER_FAILURES
        ) {
          await DbtJob.updateOne(
            { _id: updatedJob._id },
            {
              $set: {
                enabled: false,
                "scheduledRun.lastError": `Auto-disabled after ${failures} consecutive failures. Last error: ${errorMessage ?? "unknown"}`,
              },
              $unset: { "scheduledRun.nextAt": "" },
            },
          );
          logger.warn("Auto-disabled dbt job after repeated failures", {
            jobId: updatedJob._id.toString(),
            consecutiveFailures: failures,
          });
        }
      }

      // Keep the last successful prod manifest as the state artifact for
      // --defer / state:modified+ (Slim CI, later phase).
      if (!failed) {
        const finishedRun = await DbtRun.findById(runObjectId)
          .select("artifactKeys environment")
          .lean();
        if (finishedRun?.artifactKeys?.manifest) {
          const project = await DbtProject.findById(
            new Types.ObjectId(data.projectId),
          ).select("defaultEnvironment");
          const prodLike =
            finishedRun.environment === "prod" ||
            finishedRun.environment === project?.defaultEnvironment;
          if (prodLike) {
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
    });

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
  },
  { event: "dbt/run.cancel" },
  async ({ event, step }) => {
    const runId = (event.data as { runId: string }).runId;
    await step.sleep("allow-executor-teardown", "10s");
    await step.run("finalize-cancelled", async () => {
      await DbtRun.updateOne(
        {
          _id: new Types.ObjectId(runId),
          status: { $in: ["queued", "running"] },
        },
        {
          $set: {
            status: "cancelled",
            completedAt: new Date(),
            error: "Cancelled by user",
          },
        },
      );
    });
    return { runId };
  },
);

export const dbtSchedulerFunction = inngest.createFunction(
  {
    id: "dbt-job-scheduler",
    name: "Run Scheduled dbt Jobs",
  },
  { cron: "*/1 * * * *" },
  async ({ step }) => {
    const now = new Date();

    const dueJobs = await step.run("fetch-due-dbt-jobs", async () => {
      const jobs = await DbtJob.find({
        enabled: true,
        "schedule.cron": { $exists: true, $ne: "" },
        "scheduledRun.nextAt": { $lte: now },
      })
        .select("_id workspaceId schedule scheduledRun")
        .lean();

      return jobs.map(job => ({
        id: job._id.toString(),
        workspaceId: job.workspaceId.toString(),
        nextAt: job.scheduledRun?.nextAt ?? null,
        schedule: job.schedule,
      }));
    });

    let triggered = 0;
    for (const dueJob of dueJobs) {
      if (!dueJob.schedule?.cron || !dueJob.schedule?.timezone) continue;

      const nextAt = getNextScheduledConsoleRunAt(
        { cron: dueJob.schedule.cron, timezone: dueJob.schedule.timezone },
        now,
      );

      // Optimistic claim — only the instance that flips nextAt triggers.
      const updateResult = await step.run(
        `claim-${dueJob.id}-${dueJob.nextAt?.toString() ?? "none"}`,
        async () =>
          DbtJob.updateOne(
            {
              _id: new Types.ObjectId(dueJob.id),
              "scheduledRun.nextAt": dueJob.nextAt,
            },
            { $set: { "scheduledRun.nextAt": nextAt } },
          ),
      );

      if (updateResult.modifiedCount === 0) continue;

      await step.run(`trigger-${dueJob.id}`, async () => {
        const job = await DbtJob.findById(new Types.ObjectId(dueJob.id));
        if (!job) return null;
        const run = await triggerDbtJobRun({
          workspaceId: dueJob.workspaceId,
          job,
          trigger: "schedule",
          triggeredBy: "scheduler",
        });
        return run._id.toString();
      });
      triggered++;
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
 * Run-history retention. dbt_runs embed capped logs + stepResults and would
 * otherwise grow unbounded. The parent job preserves last status/error in
 * `scheduledRun`, so pruning completed history rows past the window is safe.
 * Override with DBT_RUN_RETENTION_DAYS.
 */
const DBT_RUN_RETENTION_DAYS = Number(
  process.env.DBT_RUN_RETENTION_DAYS ?? "30",
);

/**
 * Auto-disable a scheduled job after this many consecutive failures so a
 * persistently broken job stops re-running on every tick. 0 disables the
 * behavior. Override with DBT_AUTO_DISABLE_AFTER_FAILURES.
 */
const DBT_AUTO_DISABLE_AFTER_FAILURES = Number(
  process.env.DBT_AUTO_DISABLE_AFTER_FAILURES ?? "10",
);

export const dbtRunSweeperFunction = inngest.createFunction(
  {
    id: "dbt-run-sweeper",
    name: "Cleanup Abandoned dbt Runs",
  },
  { cron: "*/5 * * * *" },
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
          logs: { $slice: -1 },
        })
        .lean();

      const abandoned = activeRuns.filter(run => {
        if (run.status === "queued") {
          // Queued runs can legitimately wait behind the per-project
          // concurrency lock — only sweep clearly lost events.
          return now - run.createdAt.getTime() > DBT_RUN_QUEUED_STALL_MS;
        }
        const lastActivity =
          run.logs?.[0]?.ts ?? run.startedAt ?? run.createdAt;
        return now - new Date(lastActivity).getTime() > DBT_RUN_STALL_MS;
      });

      for (const run of abandoned) {
        const completedAt = new Date();
        const updated = await DbtRun.updateOne(
          { _id: run._id, status: { $in: ["queued", "running"] } },
          {
            $set: {
              status: "error",
              completedAt,
              error:
                "Run abandoned — executor terminated without finalizing (instance crash or deploy)",
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
                "scheduledRun.lastStatus": "error",
                "scheduledRun.lastError": "Run abandoned by executor",
              },
              $inc: {
                "scheduledRun.runCount": 1,
                "scheduledRun.consecutiveFailures": 1,
              },
            },
          );
        }

        logger.warn("Swept abandoned dbt run", {
          runId: run._id.toString(),
          jobId: run.jobId?.toString(),
          status: run.status,
        });
      }

      return abandoned.length;
    });

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

    return { swept, pruned };
  },
);
