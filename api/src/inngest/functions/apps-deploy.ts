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
 * failure is recent and nothing under `apps/<slug>/` changed since the commit
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
  slug: string;
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
      key: "event.data.workspaceId + '/' + event.data.slug",
      mode: "cancel",
    },
    retries: 2,
    triggers: { event: APPS_DEPLOY_EVENT },
  },
  async ({ event, step }) => {
    const data = event.data as AppsDeployEventData;
    const result = await step.run("deploy", async () => {
      try {
        return await deployOneApp(data.workspaceId, data.slug, data.sha);
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
        .select("_id workspaceId slug publishedSha lastDeployError")
        .lean(),
    )) as Array<
      Pick<
        IAppProject,
        "_id" | "workspaceId" | "slug" | "publishedSha" | "lastDeployError"
      >
    >;

    const stale = await step.run("find-stale", async () => {
      const out: AppsDeployEventData[] = [];
      const heads = new Map<string, string | null>();
      for (const project of published) {
        const workspaceId = project.workspaceId.toString();
        if (!heads.has(workspaceId)) {
          try {
            const repoDir = await repoForWorkspace(workspaceId);
            heads.set(
              workspaceId,
              await resolveCommit(repoDir, "refs/heads/main"),
            );
          } catch (error) {
            log.warn("Apps reconcile: repo unavailable", {
              workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
            heads.set(workspaceId, null);
          }
        }
        const head = heads.get(workspaceId);
        const slug = project.slug;
        if (
          !slug ||
          !head ||
          !project.publishedSha ||
          head === project.publishedSha
        ) {
          continue;
        }
        try {
          if (
            !(await appFolderChanged(
              workspaceId,
              slug,
              project.publishedSha,
              head,
            ))
          ) {
            continue;
          }
          const failure = project.lastDeployError;
          if (failure) {
            const appChangedSinceFailure =
              failure.sha !== head &&
              (await appFolderChanged(
                workspaceId,
                slug,
                failure.sha,
                head,
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
                slug,
                failedSha: failure.sha,
                stage: failure.stage,
                failedAt: failure.at,
              });
              continue;
            }
          }
          out.push({ workspaceId, slug, sha: head, reason: "reconcile" });
        } catch (error) {
          log.warn("Apps reconcile: diff failed", {
            workspaceId,
            slug: project.slug,
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
  slugs: string[],
  sha: string,
  reason: AppsDeployEventData["reason"],
): Promise<void> {
  if (slugs.length === 0) return;
  await inngest.send(
    slugs.map(slug => ({
      name: APPS_DEPLOY_EVENT,
      data: { workspaceId, slug, sha, reason } satisfies AppsDeployEventData,
    })),
  );
}
