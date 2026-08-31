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
import { inngest } from "../client";
import { loggers } from "../../logging";
import { AppProject, type IAppProject } from "../../database/workspace-schema";
import { deployOneApp, appFolderChanged } from "../../apps/deploy-on-push";
import { repoForWorkspace } from "../../apps/worktree.service";
import { resolveCommit } from "../../apps/repository.service";

const log = loggers.inngest();

export const APPS_DEPLOY_EVENT = "apps/deploy.requested";

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
    // workspace keeps a 58-app push from starving everything else, and one
    // per app means a rapid double push builds in order, not in parallel.
    concurrency: [
      { key: "event.data.workspaceId", limit: 2 },
      { key: "event.data.workspaceId + '/' + event.data.slug", limit: 1 },
    ],
    retries: 2,
  },
  { event: APPS_DEPLOY_EVENT },
  async ({ event, step }) => {
    const data = event.data as AppsDeployEventData;
    const result = await step.run("deploy", () =>
      deployOneApp(data.workspaceId, data.slug, data.sha),
    );
    log.info("Apps deploy event handled", { ...data, ...result });
    return result;
  },
);

export const appsDeployReconcileFunction = inngest.createFunction(
  {
    id: "apps-deploy-reconcile",
    name: "Apps: reconcile published apps with main",
  },
  { cron: "17 * * * *" },
  async ({ step }) => {
    const published = (await step.run("list-published", async () =>
      AppProject.find({ publishedSha: { $ne: null } })
        .select("_id workspaceId slug publishedSha")
        .lean(),
    )) as Array<
      Pick<IAppProject, "_id" | "workspaceId" | "slug" | "publishedSha">
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
        )
          continue;
        try {
          if (
            await appFolderChanged(
              workspaceId,
              slug,
              project.publishedSha,
              head,
            )
          ) {
            out.push({ workspaceId, slug, sha: head, reason: "reconcile" });
          }
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
