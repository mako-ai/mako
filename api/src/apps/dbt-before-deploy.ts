/**
 * Build changed dbt models before deploying the apps that read them.
 *
 * On 18 Nov 2026 one push to main changed a dbt model (a new column) and an
 * app binding that selects it. The app deployed at once, its binding ran
 * against the morning's prod build, failed at the bindings stage, and the
 * app sat 19 hours behind until the daily dbt job rebuilt the model.
 *
 * By default (APPS_DBT_BEFORE_DEPLOY=0 rolls it back), a push whose diff touches dbt models, seeds
 * or snapshots holds back the changed apps whose bindings read dbt models.
 * One run of the existing dbt executor builds, in the prod-like environment,
 * the changed models upstream of the models those held apps read. Apps
 * outside the push do not redeploy, so their models stay out of the
 * selection: the daily build covers them. The run's end
 * (success, failure or cancel) requests the held deploys. Everything else
 * deploys at once, as before. The hourly apps reconcile stays the backstop.
 */
import { Types } from "mongoose";
import {
  DbtProject,
  DbtRun,
  type DbtRunStatus,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { DBT_ROOT, dbtResourcePaths } from "../dbt/dbt-working-tree.service";
import { resolveProdLikeEnvironmentName } from "../dbt/dbt-environments.service";
import { dbtModelNameOf } from "../dbt/ontology/model-readers";
import { loadAppsIndex, type AppIndexRow } from "./app-index.service";
import {
  diffNameStatus,
  log as commitLog,
  readBlob,
} from "./repository.service";
import { pushInfoFromCommit, type DbtRunPushInfo } from "../dbt/run-actor";
import { markDeployQueued } from "./deploy-progress";

const logger = loggers.api("apps-dbt-before-deploy");

/**
 * On by default. APPS_DBT_BEFORE_DEPLOY is the rollback only: "0" or "false"
 * turns it off, anything else (unset included) leaves it on. Read here only.
 */
export function dbtBeforeDeployEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.APPS_DBT_BEFORE_DEPLOY ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

/** The dbt_project.yml keys whose files a pre-deploy build reacts to. */
const BUILD_PATH_KEYS = ["model-paths", "seed-paths", "snapshot-paths"];

/** Does any changed repo path sit under the dbt project's models, seeds or snapshots? */
export function changesDbtBuildFiles(
  changedPaths: readonly string[],
  projectYml: string | undefined,
): boolean {
  const roots = dbtResourcePaths(projectYml, BUILD_PATH_KEYS).map(
    p => `${DBT_ROOT}/${p}/`,
  );
  return changedPaths.some(path => roots.some(root => path.startsWith(root)));
}

/** A name dbt's selector and our command tokenizer both take as is. */
const SAFE_MODEL_NAME = /^[a-z0-9_]+$/;

/** The dbt models an app's bindings read through `{{ dbt_schema }}`. */
export function dbtModelsReadBy(
  app: Pick<AppIndexRow, "bindingTables">,
): string[] {
  const out = new Set<string>();
  for (const binding of app.bindingTables ?? []) {
    for (const table of binding.tables) {
      const model = dbtModelNameOf(table);
      if (model && SAFE_MODEL_NAME.test(model)) out.add(model);
    }
  }
  return [...out];
}

/**
 * `build --select state:modified+,+m1 state:modified+,+m2 ...`. Each value is
 * an intersection: nodes changed against the prod manifest (and their
 * children) that are also `m` or upstream of it. The values are a union, in
 * one multi-value --select, which commands.ts already accepts.
 */
export function preDeployBuildCommand(models: readonly string[]): string {
  const selectors = [...new Set(models)]
    .sort()
    .map(model => `state:modified+,+${model}`);
  return `build --select ${selectors.join(" ")}`;
}

/** The models a preDeployBuildCommand selects: its inverse. */
export function modelsSelectedBy(command: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const token of (command ?? "").split(/\s+/)) {
    const model = /^state:modified\+,\+([a-z0-9_]+)$/.exec(token)?.[1];
    if (model) out.add(model);
  }
  return out;
}

export interface DbtBeforeDeployPlan {
  projectId: string;
  environment: string;
  /** Changed apps whose bindings read a dbt model: deploy after the run. */
  held: string[];
  /** Every other changed app: deploy now. */
  now: string[];
  /** The models the held apps' bindings read, sorted and deduped. */
  models: string[];
}

function isDiffableSha(sha: string | undefined): sha is string {
  return !!sha && /^[0-9a-f]{40}$/.test(sha) && !/^0+$/.test(sha);
}

/**
 * Should this push's deploys wait for a dbt build? Null means "deploy all of
 * them now, as before": the flag is off, the push cannot be diffed (first
 * push, force push), the workspace has no single dbt project with a prod
 * manifest to defer to, the diff touches no model/seed/snapshot file, or no
 * changed app reads a dbt model.
 */
export async function planDbtBeforeDeploy(input: {
  workspaceId: string;
  repoDir: string;
  before?: string;
  after: string;
  appIds: readonly string[];
}): Promise<DbtBeforeDeployPlan | null> {
  const { workspaceId, repoDir, before, after, appIds } = input;
  if (!dbtBeforeDeployEnabled() || appIds.length === 0) return null;
  if (!isDiffableSha(before)) return null;

  // The repo holds one dbt project (dbt/); a workspace with two project rows
  // is ambiguous, the same rule dbt-rules-turn.service applies.
  const projects = await DbtProject.find({
    workspaceId: new Types.ObjectId(workspaceId),
  })
    .select(
      "environments defaultEnvironment prodEnvironment lastProdManifestKey",
    )
    .limit(2)
    .lean();
  const project = projects.length === 1 ? projects[0] : null;
  // state:modified needs a prod manifest to compare against.
  if (!project?.lastProdManifestKey) return null;

  const changed = await diffNameStatus(repoDir, before, after);
  const projectYml = await readBlob(
    repoDir,
    after,
    `${DBT_ROOT}/dbt_project.yml`,
  )
    .then(blob => (blob.isBinary ? undefined : blob.contents))
    .catch(() => undefined);
  if (
    !changesDbtBuildFiles(
      changed.map(c => c.path),
      projectYml,
    )
  ) {
    return null;
  }

  // changedApps refreshed the index a moment ago.
  const index = await loadAppsIndex(workspaceId, { freshen: false });
  // Only the changed apps redeploy, so only their models need building.
  const changedIds = new Set(appIds);
  const models = new Set<string>();
  const readers = new Set<string>();
  for (const app of index.apps) {
    if (!changedIds.has(app.appId)) continue;
    const read = dbtModelsReadBy(app);
    for (const model of read) models.add(model);
    if (read.length > 0) readers.add(app.appId);
  }
  const held = appIds.filter(id => readers.has(id));
  if (held.length === 0) return null;
  return {
    projectId: project._id.toString(),
    environment: resolveProdLikeEnvironmentName(project),
    held,
    now: appIds.filter(id => !readers.has(id)),
    models: [...models].sort(),
  };
}

/**
 * The pushed commit as a run's `push`: the sha always, plus the PR number
 * (the subject's "(#NNNN)" on a squash merge), the author and the commit time
 * when the commit can be read. A repo that cannot be read leaves the sha.
 */
export async function pushInfoOf(
  repoDir: string,
  sha: string,
): Promise<DbtRunPushInfo> {
  try {
    const [commit] = await commitLog(repoDir, sha, 1);
    return pushInfoFromCommit(sha, commit);
  } catch {
    return { sha };
  }
}

/**
 * Start the pre-deploy dbt run for a plan. The run carries the held apps
 * (`deploysAfterRun`) and its end requests their deploys. When the run cannot
 * be started, the held apps deploy at once, as they would without the flag.
 * Returns the run id, or null after that fallback.
 */
export async function holdDeploysForDbtRun(input: {
  workspaceId: string;
  sha: string;
  plan: DbtBeforeDeployPlan;
  /** The workspace repo, to read the pushed commit's PR number and author. */
  repoDir: string;
}): Promise<string | null> {
  const { workspaceId, sha, plan, repoDir } = input;
  const { triggerDbtRun } = await import("../dbt/dbt-run.service");
  const { requestAppDeploys } =
    await import("../inngest/functions/apps-deploy");

  // One build per pushed commit. A redelivered webhook (or a second push
  // event for the same sha) joins the run already holding deploys for it,
  // when that run's command already selects every model the joiner reads.
  // A joiner that needs a model the run does not build starts its own run
  // below: joining would deploy it against an unbuilt model.
  const existing = await DbtRun.findOne({
    "deploysAfterRun.workspaceId": workspaceId,
    "deploysAfterRun.sha": sha,
  })
    .sort({ createdAt: -1 })
    .select("_id commands")
    .lean();
  const built = modelsSelectedBy(existing?.commands?.[0]);
  if (existing && plan.models.every(model => built.has(model))) {
    // Joins only while the run is active and unreleased. The release claims
    // after the run turns terminal and reads appIds then, so an app added
    // here is never dropped.
    const joined = await DbtRun.updateOne(
      {
        _id: existing._id,
        status: { $in: ["queued", "running"] },
        "deploysAfterRun.releasedAt": { $exists: false },
      },
      { $addToSet: { "deploysAfterRun.appIds": { $each: plan.held } } },
    );
    if (joined.matchedCount === 1) {
      await Promise.all(plan.held.map(appId => markDeployQueued(appId, sha)));
      logger.info("Apps deploys joined a dbt build already running", {
        workspaceId,
        sha,
        runId: existing._id.toString(),
        held: plan.held.length,
      });
      return existing._id.toString();
    }
    // That build already finished: prod holds this commit's models, and
    // every model these apps read was in its selection.
    await requestAppDeploys(workspaceId, plan.held, sha, "push");
    logger.info("Apps deploys after a finished dbt build of this commit", {
      workspaceId,
      sha,
      runId: existing._id.toString(),
      held: plan.held.length,
    });
    return null;
  }

  // "queued" tells app_publish_status a deploy is coming, and the hourly
  // reconcile skips an app whose deploy of main is in flight (30 min for
  // "queued"), so it does not race the run with the old prod tables.
  await Promise.all(plan.held.map(appId => markDeployQueued(appId, sha)));
  try {
    const run = await triggerDbtRun({
      workspaceId,
      projectId: plan.projectId,
      environment: plan.environment,
      commands: [preDeployBuildCommand(plan.models)],
      // "schedule", not "ci": in this codebase "ci" means a pull request's
      // head with a `ci` context (GitHub status on the PR, the CI config's
      // defer). This run builds committed main into the prod-like
      // environment, exactly what a scheduled job run does, and both pass
      // the ad-hoc guard (dbt-run.service, isAdhocRun).
      trigger: "schedule",
      triggeredBy: "apps-deploy-on-push",
      actor: {
        kind: "deploy_on_push",
        push: await pushInfoOf(repoDir, sha),
      },
      deferToProduction: true,
      sourceSha: sha,
      deploysAfterRun: { workspaceId, appIds: plan.held, sha },
    });
    logger.info("Apps deploys held for a dbt build", {
      workspaceId,
      sha,
      runId: run._id.toString(),
      held: plan.held.length,
      models: plan.models.length,
    });
    return run._id.toString();
  } catch (error) {
    logger.warn("Could not start the pre-deploy dbt build; deploying now", {
      workspaceId,
      sha,
      held: plan.held.length,
      error: error instanceof Error ? error.message : String(error),
    });
    await requestAppDeploys(workspaceId, plan.held, sha, "push");
    return null;
  }
}

const TERMINAL: DbtRunStatus[] = ["success", "error", "cancelled"];

type HeldDeploys = {
  workspaceId: string;
  appIds: string[];
  sha: string;
};

/**
 * A dbt run ended: request the app deploys it held, once. Called from every
 * path that finalizes a run (executor, cancel finalizer, sweeper, queue
 * watchdog) and by the 60-minute cap; the first caller claims `releasedAt`
 * atomically, so the others are no-ops.
 *
 * The cap can fire while the run is still going: those deploys then read the
 * OLD prod tables and may fail at bindings, and the reconcile backs off from
 * them for 6 hours. So a cap release of a live run is marked `releasedEarly`,
 * and when that run later ends in success the terminal path claims
 * `rereleasedAt` and requests the same deploys once more, against the
 * rebuilt prod. After an error or a cancel prod did not change: no second
 * request.
 *
 * A failed request is logged and unclaimed; the hourly reconcile deploys the
 * apps within the hour.
 */
export async function releaseDeploysAfterRun(
  runId: Types.ObjectId | string,
  /** The 60-minute cap: release while the run is still queued or running. */
  opts: { anyStatus?: boolean } = {},
): Promise<string[]> {
  const _id = typeof runId === "string" ? new Types.ObjectId(runId) : runId;
  // One atomic write: claim the release and record whether the run was
  // still going at that instant (the cap path only).
  const claimed = await DbtRun.findOneAndUpdate(
    {
      _id,
      ...(opts.anyStatus ? {} : { status: { $in: TERMINAL } }),
      deploysAfterRun: { $exists: true },
      "deploysAfterRun.releasedAt": { $exists: false },
    },
    [
      {
        $set: {
          "deploysAfterRun.releasedAt": "$$NOW",
          ...(opts.anyStatus
            ? {
                "deploysAfterRun.releasedEarly": {
                  $not: [{ $in: ["$status", TERMINAL] }],
                },
              }
            : {}),
        },
      },
    ],
    { returnDocument: "after", updatePipeline: true },
  )
    .select("status deploysAfterRun")
    .lean();
  if (claimed?.deploysAfterRun) {
    return requestHeldDeploys(_id, claimed.deploysAfterRun, {
      runStatus: claimed.status,
      claim: "releasedAt",
      early: claimed.deploysAfterRun.releasedEarly === true,
    });
  }
  if (opts.anyStatus) return [];

  // Released early by the cap, and the run has now built prod: once more.
  const again = await DbtRun.findOneAndUpdate(
    {
      _id,
      status: "success",
      "deploysAfterRun.releasedEarly": true,
      "deploysAfterRun.rereleasedAt": { $exists: false },
    },
    { $set: { "deploysAfterRun.rereleasedAt": new Date() } },
    { returnDocument: "after" },
  )
    .select("status deploysAfterRun")
    .lean();
  if (!again?.deploysAfterRun) return [];
  return requestHeldDeploys(_id, again.deploysAfterRun, {
    runStatus: again.status,
    claim: "rereleasedAt",
    early: false,
  });
}

async function requestHeldDeploys(
  _id: Types.ObjectId,
  held: HeldDeploys,
  ctx: {
    runStatus: DbtRunStatus;
    claim: "releasedAt" | "rereleasedAt";
    early: boolean;
  },
): Promise<string[]> {
  if (held.appIds.length === 0) return [];
  try {
    const [
      { requestAppDeploys },
      { deployTargetForPush },
      { repoForWorkspace },
    ] = await Promise.all([
      import("../inngest/functions/apps-deploy"),
      import("./deploy-on-push"),
      import("./worktree.service"),
    ]);
    // Main may have moved during the run. Deploy its head when it descends
    // from the held commit, as a late webhook delivery does: an older sha
    // would cancel a newer queued deploy of the same app (per-app singleton).
    const sha = await repoForWorkspace(held.workspaceId)
      .then(dir => deployTargetForPush(dir, held.sha))
      .catch(() => held.sha);
    await requestAppDeploys(held.workspaceId, held.appIds, sha, "push");
    logger.info("Released app deploys held for a dbt build", {
      workspaceId: held.workspaceId,
      runId: _id.toString(),
      runStatus: ctx.runStatus,
      claim: ctx.claim,
      ...(ctx.early ? { releasedEarly: true } : {}),
      sha,
      apps: held.appIds.length,
    });
    return held.appIds;
  } catch (error) {
    await DbtRun.updateOne(
      { _id },
      {
        $unset: {
          [`deploysAfterRun.${ctx.claim}`]: 1,
          ...(ctx.claim === "releasedAt"
            ? { "deploysAfterRun.releasedEarly": 1 }
            : {}),
        },
      },
    ).catch(() => undefined);
    logger.warn("Could not release app deploys held for a dbt build", {
      workspaceId: held.workspaceId,
      runId: _id.toString(),
      claim: ctx.claim,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
