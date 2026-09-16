/**
 * Deploy apps from `main` as Inngest work, not as detached request work.
 *
 * The GitHub webhook used to run the whole build loop after answering the
 * delivery — on Cloud Run that background CPU is throttled away, and a push
 * touching 58 app folders republished 13 apps and then simply stopped
 * (apps.md §15.4). The webhook now only decides WHICH apps changed and emits
 * one event per app; this function builds them with bounded concurrency,
 * durably, with Inngest's retries. An hourly reconcile catches anything a
 * missed delivery or a dead instance left behind: a published app whose
 * folder differs between `publishedSha` and the head of `main` is, by
 * definition, an app that needs deploying.
 */
import { NonRetriableError } from "inngest";
import { inngest } from "../client";
import { loggers } from "../../logging";
import { AppProject, type IAppProject } from "../../database/workspace-schema";
import {
  DeployBindingsError,
  deployOneApp,
  appFolderChanged,
} from "../../apps/deploy-on-push";
import { repoForWorkspace } from "../../apps/worktree.service";
import { resolveCommit } from "../../apps/repository.service";

const log = loggers.inngest();

export const APPS_DEPLOY_EVENT = "apps/deploy.requested";

/**
 * How long the hourly reconcile leaves an app alone after a deploy of the
 * SAME app content failed. Without it the reconcile re-enqueued a failing
 * app every hour: on 2026-09-14/15 one app whose binding query timed out
 * accumulated 25 deploy events, each re-running the query up to three times,
 * ~1,000 warehouse slot-hours in a day. A push that changes the app still
 * deploys at once (webhook); only the blind hourly retry waits.
 */
export const RECONCILE_FAILED_DEPLOY_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * Should the reconcile skip an app whose last deploy failed? Yes while the
 * failure is recent and nothing in the app's folder changed since the commit
 * that failed — the same content would fail the same way.
 */
export function shouldBackOffFromFailedDeploy(input: {
  lastDeployError?: { sha: string; at: Date | string } | null;
  appChangedSinceFailure: boolean;
  now?: Date;
}): boolean {
  const failure = input.lastDeployError;
  if (!failure || input.appChangedSinceFailure) return false;
  const failedAt = new Date(failure.at).getTime();
  if (!Number.isFinite(failedAt)) return false;
  const now = (input.now ?? new Date()).getTime();
  return now - failedAt < RECONCILE_FAILED_DEPLOY_BACKOFF_MS;
}

export interface AppsDeployEventData {
  workspaceId: string;
  /** The app's id. Older events in flight carried `slug`; both resolve. */
  appId: string;
  slug?: string;
  /** The commit of `main` to build and publish. */
  sha: string;
  /** Why: "push" (webhook), "reconcile" (hourly sweep), "manual". */
  reason: "push" | "reconcile" | "manual";
}

export const appsDeployFunction = inngest.createFunction(
  {
    id: "apps-deploy",
    name: "Apps: deploy an app from main",
    // A build is npm install + vite build in a sandbox: heavy. Two per
    // workspace keeps a 58-app push from starving everything else.
    concurrency: [{ key: "event.data.workspaceId", limit: 2 }],
    // One deploy per app, and the NEWEST request wins: a deploy exists to
    // publish the head of main, so a newer request makes an older one moot.
    // A per-app concurrency limit queued them instead — behind a failing
    // deploy that queue only grew (25 events for one app in a day).
    singleton: {
      key: "event.data.workspaceId + '/' + (event.data.appId ?? event.data.slug)",
      mode: "cancel",
    },
    retries: 2,
    triggers: { event: APPS_DEPLOY_EVENT },
  },
  async ({ event, step }) => {
    const data = event.data as AppsDeployEventData;
    const ref = data.appId ?? data.slug ?? "";
    const result = await step.run("deploy", async () => {
      try {
        return await deployOneApp(data.workspaceId, ref, data.sha);
      } catch (error) {
        // A binding that could not be materialized is a warehouse failure
        // (a broken or too slow query), not a flaky build: retrying runs the
        // same query again. It is recorded in lastDeployError; the reconcile
        // backs off and a push that changes the app retries it.
        if (error instanceof DeployBindingsError) {
          throw new NonRetriableError(error.message, { cause: error });
        }
        throw error;
      }
    });
    log.info("Apps deploy event handled", { ...data, ...result });
    return result;
  },
);

export const appsDeployReconcileFunction = inngest.createFunction(
  {
    id: "apps-deploy-reconcile",
    name: "Apps: reconcile published apps with main",
    triggers: { cron: "17 * * * *" },
  },
  async ({ step }) => {
    const published = (await step.run("list-published", async () =>
      AppProject.find({ publishedSha: { $ne: null } })
        .select("_id workspaceId slug path publishedSha lastDeployError")
        .lean(),
    )) as Array<
      Pick<
        IAppProject,
        | "_id"
        | "workspaceId"
        | "slug"
        | "path"
        | "publishedSha"
        | "lastDeployError"
      >
    >;

    const stale = await step.run("find-stale", async () => {
      const out: AppsDeployEventData[] = [];
      const trees = new Map<string, Promise<Map<string, string>>>();
      const repos = new Map<string, { dir: string; head: string | null }>();
      for (const project of published) {
        const workspaceId = project.workspaceId.toString();
        if (!repos.has(workspaceId)) {
          try {
            const dir = await repoForWorkspace(workspaceId);
            repos.set(workspaceId, {
              dir,
              head: await resolveCommit(dir, "refs/heads/main"),
            });
          } catch (error) {
            log.warn("Apps reconcile: repo unavailable", {
              workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
            repos.set(workspaceId, { dir: "", head: null });
          }
        }
        const repo = repos.get(workspaceId);
        if (
          !repo?.head ||
          (!project.path && !project.slug) ||
          !project.publishedSha ||
          repo.head === project.publishedSha
        ) {
          continue;
        }
        const appId = project._id.toString();
        try {
          if (
            !(await appFolderChanged(
              workspaceId,
              repo.dir,
              appId,
              project.publishedSha,
              repo.head,
              trees,
            ))
          ) {
            continue;
          }
          const failure = project.lastDeployError;
          if (failure) {
            const appChangedSinceFailure =
              failure.sha !== repo.head &&
              (await appFolderChanged(
                workspaceId,
                repo.dir,
                appId,
                failure.sha,
                repo.head,
                trees,
              ).catch(
                // The failed commit is unknown here (a rewritten branch):
                // treat the app as changed rather than block it forever.
                () => true,
              ));
            if (
              shouldBackOffFromFailedDeploy({
                lastDeployError: failure,
                appChangedSinceFailure,
              })
            ) {
              log.info("Apps reconcile: backing off a failed deploy", {
                workspaceId,
                appId,
                app: project.path,
                failedSha: failure.sha,
                stage: failure.stage,
                failedAt: failure.at,
              });
              continue;
            }
          }
          out.push({ workspaceId, appId, sha: repo.head, reason: "reconcile" });
        } catch (error) {
          log.warn("Apps reconcile: diff failed", {
            workspaceId,
            appId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return out;
    });

    if (stale.length > 0) {
      await step.sendEvent(
        "deploy",
        stale.map(data => ({ name: APPS_DEPLOY_EVENT, data })),
      );
    }
    log.info("Apps deploy reconcile run", {
      published: published.length,
      triggered: stale.length,
    });
    return { published: published.length, triggered: stale.length };
  },
);

/** Enqueue deploys for a set of apps at a commit (one event per app). */
export async function requestAppDeploys(
  workspaceId: string,
  appIds: string[],
  sha: string,
  reason: AppsDeployEventData["reason"],
): Promise<void> {
  if (appIds.length === 0) return;
  await inngest.send(
    appIds.map(appId => ({
      name: APPS_DEPLOY_EVENT,
      data: { workspaceId, appId, sha, reason } satisfies AppsDeployEventData,
    })),
  );
}
