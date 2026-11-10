/**
 * Scheduled refresh for Apps data bindings (Block 4 of the bindings plan).
 *
 * Schedules live IN the binding files ("-- schedule: <cron>" front matter on
 * main) — no Mongo copy of the DEFINITION. The apps index (rebuilt on every
 * push to main) carries each app's schedules as a derived column, so the
 * 15-minute tick reads one collection instead of opening every repo. It
 * emits ONE EVENT per due binding; the worker below materializes them with
 * bounded concurrency per workspace, reading the binding from git at that
 * point.
 *
 * It used to materialize inline, sequentially, inside the cron function. With
 * ~170 bindings due at once (the first sweep after a migration) and ~28 of
 * them on a 15-minute schedule, every tick re-ran those 28 first, spent the
 * whole tick on them, and never reached the tail: bindings late in project
 * order were never built while the log showed steady "materialized" lines.
 * A tick now finishes in seconds; the backlog drains in parallel; a slow or
 * broken binding delays nothing but itself.
 *
 * A release also sends these events, for the stale artifacts it went live on
 * (requestBindingRefreshes). They carry `afterPublish` and the release's
 * commit, jump the queue by the most Inngest allows, and are judged by the
 * artifact's own write time.
 */
import { inngest } from "../client";
import { loadAppsIndex } from "../../apps/app-index.service";
import { loggers } from "../../logging";
import {
  AppIndexEntry,
  AppProject,
  type IAppIndexEntry,
} from "../../database/workspace-schema";
import {
  getBindingState,
  materializeAppBinding,
  readCommittedBinding,
  type AppBinding,
  type AppBindingStateDoc,
} from "../../apps/bindings.service";
import { isCronDue, nextCronRunAt } from "../../services/cron-due";
import { pausedScheduleAppIds } from "../../apps/app-lifecycle.service";
import { isBindingArtifactReady } from "../../apps/deployment.service";
import { PUBLISH_ACTOR } from "../../apps/worktree.service";

import { APPS_BINDING_BUILD_CONCURRENCY } from "./apps-binding-concurrency";

const log = loggers.inngest();

export const APPS_BINDING_MATERIALIZE_EVENT = "apps/binding.materialize";

interface MaterializeEventData {
  workspaceId: string;
  projectId: string;
  binding: string;
  /** `${projectId}:${binding}` — the concurrency key (one build per binding). */
  key: string;
  /** Build the binding as of this commit instead of the head of main. */
  at?: string;
  /** A release went live on this binding's stale artifact. */
  afterPublish?: boolean;
  /** Which try of that rebuild this is, from 1. */
  attempt?: number;
  /** Which release queued it, so a later publish gets new event ids. */
  release?: number;
}

/**
 * Due = the binding's cron has a run after its last ATTEMPT (not its last
 * success): a binding whose query is broken would otherwise be due on every
 * tick and re-run its failing warehouse query every 15 minutes forever.
 *
 * `history` is NEWEST FIRST (recordBindingRun pushes at position 0), so the
 * last attempt is `history[0]`. Reading `history.at(-1)` here — the OLDEST
 * run — made every binding look overdue on every tick: all 173 scheduled
 * bindings re-ran their warehouse queries every 15 minutes.
 */
export function isBindingDueAt(
  binding: Pick<AppBinding, "schedule" | "timezone">,
  state: AppBindingStateDoc | null,
  now = new Date(),
): boolean {
  if (!binding.schedule) return false;
  const lastAttempt = state?.history?.[0]?.at ?? null;
  // Parse up front so an invalid cron/timezone throws even before the first
  // run (callers log-and-skip), instead of reading as "never ran → due".
  nextCronRunAt(binding.schedule, { timezone: binding.timezone });
  return isCronDue({
    cron: binding.schedule,
    timezone: binding.timezone,
    lastRunAt: lastAttempt ?? state?.lastMaterializedAt ?? null,
    now,
  });
}

export const appsBindingSchedulerFunction = inngest.createFunction(
  {
    id: "scheduled-apps-binding-refresh",
    name: "Scheduled Apps Binding Refresh",
    triggers: { cron: "*/15 * * * *" },
  },
  async ({ step }) => {
    // Only apps that have a project row are scheduled — the same set as
    // before the index existed (a row appears when an app is published,
    // restricted or shared). A scheduled binding in an app nobody has
    // published would otherwise re-run its warehouse query every tick for
    // no reader.
    const scheduled = (await step.run("list-scheduled", async () => {
      // The index is built on reads and pushes. A workspace nobody has
      // opened since this API deployed (its apps consumed through shares
      // only) has no rows yet, and its schedules would silently stop — so
      // bring every workspace with a published app up to date first. One
      // throttled fetch + rev-parse per workspace per tick; a no-op when
      // main has not moved.
      // Every workspace with a state row: restricted or shared apps are
      // scheduled too (a row appears when an app is published, restricted
      // or shared), not only published ones.
      const workspacesWithApps = await AppProject.distinct("workspaceId");
      for (const ws of workspacesWithApps) {
        try {
          await loadAppsIndex(ws.toString());
        } catch (error) {
          log.warn("Apps index refresh failed before scheduling", {
            workspaceId: ws.toString(),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const entries = await AppIndexEntry.find({
        "schedules.0": { $exists: true },
      })
        .select("workspaceId appId schedules")
        .lean();
      if (entries.length === 0) return [];
      const rows = await AppProject.find({
        _id: { $in: entries.map(e => e.appId) },
      })
        .select("_id")
        .lean();
      const withRow = new Set(rows.map(r => r._id.toString()));
      // Unviewed apps (nobody opened them in 30 days) have their schedules
      // paused by the lifecycle job until the next open — skipped here, the
      // binding's front matter untouched (app-lifecycle.service.ts).
      const paused = await pausedScheduleAppIds();
      if (paused.size > 0) {
        log.info("Skipping paused binding schedules", {
          apps: entries.filter(e => paused.has(e.appId)).length,
        });
      }
      return entries.filter(e => withRow.has(e.appId) && !paused.has(e.appId));
    })) as unknown as Array<
      Pick<IAppIndexEntry, "workspaceId" | "appId" | "schedules">
    >;

    const due = await step.run("find-due-bindings", async () => {
      const out: MaterializeEventData[] = [];
      for (const entry of scheduled) {
        const projectId = entry.appId;
        for (const schedule of entry.schedules) {
          const binding = {
            schedule: schedule.cron,
            timezone: schedule.timezone,
          };
          try {
            if (
              !isBindingDueAt(
                binding,
                await getBindingState(projectId, schedule.binding),
              )
            ) {
              continue;
            }
          } catch (error) {
            log.warn("Invalid binding schedule", {
              projectId,
              binding: schedule.binding,
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          out.push({
            workspaceId: entry.workspaceId.toString(),
            projectId,
            binding: schedule.binding,
            key: `${projectId}:${schedule.binding}`,
          });
        }
      }
      return out;
    });

    if (due.length > 0) {
      await step.sendEvent(
        "materialize",
        due.map(data => ({ name: APPS_BINDING_MATERIALIZE_EVENT, data })),
      );
    }
    log.info("Apps binding scheduler run", {
      projects: scheduled.length,
      triggered: due.length,
    });
    return { projects: scheduled.length, triggered: due.length };
  },
);

/** Rebuild attempts for a stale artifact a release went live on. */
export const AFTER_PUBLISH_MAX_ATTEMPTS = 3;
const AFTER_PUBLISH_RETRY_DELAY_MS = 10 * 60 * 1000;
/** Releases of one commit inside this window share their refresh events. */
const AFTER_PUBLISH_RELEASE_WINDOW_MS = 5 * 60 * 1000;

function afterPublishEvent(
  project: { _id: unknown; workspaceId: unknown },
  sha: string,
  binding: string,
  attempt: number,
  release: number,
) {
  const projectId = String(project._id);
  return {
    // Two landings of one release queue one refresh per binding, not two. A
    // later publish of the same commit is a new release with new ids: Inngest
    // would drop reused ones for 24 hours, even after 3 failed attempts.
    id: `binding-refresh-${projectId}-${sha}-${binding}-${release}-${attempt}`,
    name: APPS_BINDING_MATERIALIZE_EVENT,
    data: {
      workspaceId: String(project.workspaceId),
      projectId,
      binding,
      key: `${projectId}:${binding}`,
      at: sha,
      afterPublish: true,
      attempt,
      release,
    } satisfies MaterializeEventData,
  };
}

/**
 * A stale artifact is live and its rebuild failed. Say so on the app row, where
 * app_publish_status reads it, and retry while attempts remain: viewers are
 * reading old numbers until this succeeds or the commit stops being live.
 */
async function afterPublishRebuildFailed(
  project: { _id: unknown; workspaceId: unknown },
  data: MaterializeEventData,
  error: unknown,
): Promise<void> {
  const attempt = data.attempt ?? 1;
  const message = error instanceof Error ? error.message : String(error);
  try {
    await AppProject.updateOne(
      { _id: data.projectId },
      {
        $set: {
          [`bindingRefreshErrors.${data.binding}`]: {
            sha: data.at,
            message: message.slice(0, 2_000),
            attempts: attempt,
            at: new Date(),
          },
        },
      },
    );
  } catch (writeError) {
    log.warn("Could not record a failed binding refresh", {
      projectId: data.projectId,
      binding: data.binding,
      error:
        writeError instanceof Error ? writeError.message : String(writeError),
    });
  }
  if (attempt >= AFTER_PUBLISH_MAX_ATTEMPTS || !data.at) return;
  try {
    await inngest.send({
      ...afterPublishEvent(
        project,
        data.at,
        data.binding,
        attempt + 1,
        data.release ?? 0,
      ),
      ts: Date.now() + AFTER_PUBLISH_RETRY_DELAY_MS,
    });
  } catch (sendError) {
    log.warn("Could not queue a binding refresh retry", {
      projectId: data.projectId,
      binding: data.binding,
      error: sendError instanceof Error ? sendError.message : String(sendError),
    });
  }
}

/** A later success answers an earlier recorded failure of this binding. */
async function clearBindingRefreshError(
  projectId: string,
  binding: string,
): Promise<void> {
  try {
    await AppProject.updateOne(
      {
        _id: projectId,
        [`bindingRefreshErrors.${binding}`]: { $exists: true },
      },
      { $unset: { [`bindingRefreshErrors.${binding}`]: 1 } },
    );
  } catch (error) {
    log.warn("Could not clear a failed binding refresh", {
      projectId,
      binding,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Has a scheduled event nothing to do? State saying the binding ran is not
 * enough: state is per binding NAME, so a run of another text (an after-publish
 * refresh, a reverted query) must not stand in for this text's artifact. A
 * failed last attempt does stand: a broken query must not re-run every tick.
 */
async function isScheduledBuildMoot(
  projectId: string,
  binding: AppBinding,
): Promise<boolean> {
  const state = await getBindingState(projectId, binding.name);
  if (isBindingDueAt(binding, state)) return false;
  if (state?.history?.[0]?.status === "error") return true;
  return isBindingArtifactReady(binding, { projectId, sha: "main" });
}

/**
 * One binding build from an event. A scheduled event is judged by the
 * binding's scheduler state and artifact. An after-publish event is judged by
 * the artifact's write time, because scheduler state is per binding name and a
 * reverted query's artifact can be old while the state says it ran today
 * (#992). It stands down once its commit stops being live.
 */
export async function runBindingMaterializeEvent(
  data: MaterializeEventData,
): Promise<
  | {
      skipped: "project-gone" | "binding-gone" | "not-due" | "superseded";
    }
  | { ok: true; rowCount: number }
  | { ok: false }
> {
  const { projectId, binding: name, at, afterPublish } = data;
  const project = await AppProject.findById(projectId);
  if (!project) return { skipped: "project-gone" };
  if (afterPublish && project.publishedSha !== at) {
    return { skipped: "superseded" };
  }
  try {
    // This binding's file only: reading all of them costs ~100 ms per binding
    // in the app, per build.
    const binding = await readCommittedBinding(project, name, undefined, at);
    if (!binding) return { skipped: "binding-gone" };
    // A later tick may have queued this binding again while the backlog was
    // still draining; if a build landed in between, this one is moot.
    const moot = afterPublish
      ? await isBindingArtifactReady(binding, { projectId, sha: at ?? "main" })
      : await isScheduledBuildMoot(projectId, binding);
    if (moot) return { skipped: "not-due" };
    const result = await materializeAppBinding(
      project,
      name,
      afterPublish ? PUBLISH_ACTOR : "scheduler",
      { at, binding },
    );
    await clearBindingRefreshError(projectId, name);
    return { ok: true, rowCount: result.rowCount };
  } catch (error) {
    log.warn("Scheduled binding materialization failed", {
      projectId,
      binding: name,
      afterPublish: afterPublish ?? false,
      error: error instanceof Error ? error.message : String(error),
    });
    if (afterPublish) await afterPublishRebuildFailed(project, data, error);
    return { ok: false };
  }
}

export const appsBindingMaterializeFunction = inngest.createFunction(
  {
    id: "apps-binding-materialize",
    name: "Materialize Apps Data Binding",
    // A workspace's warehouse sees at most 4 builds at once and a binding is
    // never built twice concurrently — shared with on-demand async builds.
    concurrency: APPS_BINDING_BUILD_CONCURRENCY,
    // A viewer already reads this stale artifact, so it goes ahead of builds
    // nobody is waiting on. Seconds, and 600 is the most Inngest accepts.
    priority: { run: "event.data.afterPublish == true ? 600 : 0" },
    // materializeAppBinding records the failure in the binding's state and
    // the next due check backs off from it; retrying here would re-run a
    // broken warehouse query for nothing. An after-publish rebuild retries a
    // bounded number of times by sending itself again.
    retries: 0,
    triggers: { event: APPS_BINDING_MATERIALIZE_EVENT },
  },
  async ({ event, step }) =>
    step.run("materialize", () =>
      runBindingMaterializeEvent(event.data as MaterializeEventData),
    ),
);

/** Queue rebuilds for the stale artifacts a release of `sha` went live on. */
export async function requestBindingRefreshes(
  project: { _id: unknown; workspaceId: unknown },
  sha: string,
  names: string[],
): Promise<void> {
  if (names.length === 0) return;
  const release = Math.floor(Date.now() / AFTER_PUBLISH_RELEASE_WINDOW_MS);
  await inngest.send(
    names.map(binding => afterPublishEvent(project, sha, binding, 1, release)),
  );
}
