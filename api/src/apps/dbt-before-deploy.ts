/**
 * Build the dbt models a held app cannot run without, before deploying it.
 *
 * On 18 Nov 2026 one push to main changed a dbt model (a new column) and an
 * app binding that selects it. The app deployed at once, its binding ran
 * against the morning's prod build, failed at the bindings stage, and the
 * app sat 19 hours behind until the daily dbt job rebuilt the model.
 *
 * On 19 Nov 2026 the first version of this file rebuilt every changed model
 * upstream of the apps it held (`state:modified+`). One such run rebuilt a
 * published table mid-day, after its consumer had read it (193 models, 54
 * minutes). The rule is now narrower: only a schema gap is built here.
 *
 * Default mode `schema-gap` (APPS_DBT_BEFORE_DEPLOY_MODE): a push whose diff
 * touches dbt models, seeds or snapshots holds the changed apps that read a
 * model with a gap (dbt-schema-gap.ts). A gap is a missing prod relation, a
 * compiled column the prod table lacks, or a parent of a gap model with such
 * a gap itself. One run of the existing dbt executor builds exactly those
 * models in the prod-like environment (`build --select a b`: no `+`, no
 * `state:modified` children). The run's end (success, failure or cancel)
 * requests the held deploys. With no gap there is no run: every app deploys
 * at once, and a logic-only dbt change waits for its next scheduled job.
 *
 * Order of work on a push: the apps that read no dbt model are requested
 * first. The apps that read dbt models are marked queued and an Inngest
 * event (apps/dbt-hold.requested) runs the compile and the warehouse check,
 * so it survives the webhook instance.
 *
 * When the check cannot finish:
 *  - the pushed commit does not compile: the readers deploy at once;
 *  - a warehouse query fails: build the changed read models directly
 *    (`build --select m1 m2`, no `+`) and hold;
 *  - no BigQuery connection for the environment: `full`, as before.
 * An incremental model whose on_schema_change cannot add the column is not
 * built and its app is not held on it (logged as unfixable).
 *
 * APPS_DBT_BEFORE_DEPLOY_MODE=full is the operator rollback to the 19 Nov
 * behaviour. APPS_DBT_BEFORE_DEPLOY=0 turns the feature off. Apps outside
 * the push do not redeploy. The hourly apps reconcile stays the backstop.
 */
import { createHash } from "node:crypto";
import { Types } from "mongoose";
import {
  AppProject,
  DbtProject,
  DbtRun,
  type DbtRunStatus,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { DBT_ROOT, dbtResourcePaths } from "../dbt/dbt-working-tree.service";
import { resolveProdLikeEnvironmentName } from "../dbt/dbt-environments.service";
import { dbtModelNameOf } from "../dbt/ontology/model-readers";
import { inngest } from "../inngest/client";
import {
  SAFE_NODE_NAME,
  detectSchemaGap,
  selectableNames,
} from "./dbt-schema-gap";
import { loadAppsIndex, type AppIndexRow } from "./app-index.service";
import { diffNameStatus, readBlob } from "./repository.service";
import { isDeployInFlight, markDeployQueued } from "./deploy-progress";

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

export type DbtBeforeDeployMode = "full" | "schema-gap";

/**
 * APPS_DBT_BEFORE_DEPLOY_MODE: `full` is the operator rollback to building
 * every changed model upstream of the held apps. Anything else (unset
 * included) is `schema-gap`.
 */
export function dbtBeforeDeployMode(
  env: NodeJS.ProcessEnv = process.env,
): DbtBeforeDeployMode {
  const raw = (env.APPS_DBT_BEFORE_DEPLOY_MODE ?? "").trim().toLowerCase();
  if (raw && raw !== "full" && raw !== "schema-gap") {
    logger.warn("Unknown APPS_DBT_BEFORE_DEPLOY_MODE; using schema-gap", {
      value: raw,
    });
  }
  return raw === "full" ? "full" : "schema-gap";
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
const SAFE_MODEL_NAME = SAFE_NODE_NAME;

/** The dbt models an app's bindings read through `{{ dbt_schema }}`. */
export function dbtModelsReadBy(
  app: Pick<AppIndexRow, "bindingTables">,
): string[] {
  const out = new Set<string>();
  for (const binding of app.bindingTables ?? []) {
    for (const table of binding.tables) {
      const model = dbtModelNameOf(table);
      if (!model) continue;
      if (SAFE_MODEL_NAME.test(model)) out.add(model);
      else {
        logger.warn("An app reads a dbt model with an unsupported name", {
          model,
        });
      }
    }
  }
  return [...out];
}

/**
 * `build --select m1 m2`: the schema-gap models and nothing else. No `+` and
 * no `state:modified`: a model downstream of a gap model that has no gap of
 * its own waits for its scheduled job.
 */
export function gapBuildCommand(models: readonly string[]): string {
  return `build --select ${selectableNames(models).join(" ")}`;
}

/**
 * `full` mode: `build --select state:modified+,+m1 state:modified+,+m2 ...`.
 * Each value is
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

/**
 * The models a preDeployBuildCommand or a gapBuildCommand selects: their
 * inverse. A `full` selector covers the model and what changed upstream of
 * it. A gap command covers exactly the models it names.
 */
export function modelsSelectedBy(command: string | undefined): Set<string> {
  const out = new Set<string>();
  const tokens = (command ?? "").split(/\s+/);
  const start = tokens.indexOf("--select");
  if (start < 0) return out;
  for (const token of tokens.slice(start + 1)) {
    const model =
      /^state:modified\+,\+([A-Za-z0-9_]+)$/.exec(token)?.[1] ??
      (SAFE_MODEL_NAME.test(token) ? token : undefined);
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
  /**
   * The models to build, sorted and deduped. `full`: every model the held
   * apps read. `schema-gap`: the gap models and their gap parents.
   */
  models: string[];
  /** The dbt command that builds them. */
  command: string;
}

/**
 * What a push needs decided before its deploys can go, found without any
 * dbt compile or warehouse query: the changed apps that read dbt models and
 * the dbt project to check them against. Serialisable: it travels in an
 * Inngest event.
 */
export interface DbtDeployPrep {
  projectId: string;
  environment: string;
  mode: DbtBeforeDeployMode;
  /** The prod-like environment's warehouse connection, when it has one. */
  connectionId?: string;
  /** `full` needs the prod manifest `state:modified` compares against. */
  hasProdManifest: boolean;
  /** Changed apps whose bindings read a dbt model, with the models. */
  readsByApp: Record<string, string[]>;
  /** The keys of readsByApp, in push order. */
  readers: string[];
  /** Every other changed app: deploy now. */
  now: string[];
  /** Repo paths the push changed. */
  changedPaths: string[];
}

function isDiffableSha(sha: string | undefined): sha is string {
  return !!sha && /^[0-9a-f]{40}$/.test(sha) && !/^0+$/.test(sha);
}

/**
 * Does this push's deploys possibly wait for a dbt build? Null means "deploy
 * all of them now, as before": the flag is off, the push cannot be diffed
 * (first push, force push), the workspace has no single dbt project, the
 * diff touches no model/seed/snapshot file, no changed app reads a dbt model,
 * or (`full`) there is no prod manifest to defer to. Cheap: git and Mongo
 * only. The compile and the warehouse come later, in `resolveDbtBeforeDeploy`.
 */
export async function planDbtBeforeDeploy(input: {
  workspaceId: string;
  repoDir: string;
  before?: string;
  after: string;
  appIds: readonly string[];
}): Promise<DbtDeployPrep | null> {
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
  if (!project) return null;
  const mode = dbtBeforeDeployMode();
  // `full`: state:modified needs a prod manifest to compare against.
  if (mode === "full" && !project.lastProdManifestKey) return null;

  const changed = await diffNameStatus(repoDir, before, after);
  const changedPaths = changed.map(c => c.path);
  const projectYml = await readBlob(
    repoDir,
    after,
    `${DBT_ROOT}/dbt_project.yml`,
  )
    .then(blob => (blob.isBinary ? undefined : blob.contents))
    .catch(() => undefined);
  if (!changesDbtBuildFiles(changedPaths, projectYml)) return null;

  // changedApps refreshed the index a moment ago.
  const index = await loadAppsIndex(workspaceId, { freshen: false });
  // Only the changed apps redeploy, so only their models need building.
  const changedIds = new Set(appIds);
  const readsByApp: Record<string, string[]> = {};
  for (const app of index.apps) {
    if (!changedIds.has(app.appId)) continue;
    const read = dbtModelsReadBy(app);
    if (read.length > 0) readsByApp[app.appId] = read;
  }
  const readers = appIds.filter(id => id in readsByApp);
  if (readers.length === 0) return null;
  const environment = resolveProdLikeEnvironmentName(project);
  const connectionId = project.environments
    .find(env => env.name === environment)
    ?.connectionId?.toString();
  return {
    projectId: project._id.toString(),
    environment,
    mode,
    ...(connectionId ? { connectionId } : {}),
    hasProdManifest: !!project.lastProdManifestKey,
    readsByApp,
    readers,
    now: appIds.filter(id => !(id in readsByApp)),
    // Only dbt files matter to the check; the event stays small.
    changedPaths: changedPaths.filter(path => path.startsWith(`${DBT_ROOT}/`)),
  };
}

/**
 * The plan for the apps that read dbt models. Null means "deploy them all
 * now": nothing needs building. A pushed commit that does not compile throws
 * `DbtCompileError`, which the caller also answers by deploying at once.
 *
 * `full` builds every changed model upstream of the held apps. `schema-gap`
 * builds the nodes held apps cannot run without (dbt-schema-gap.ts). When the
 * warehouse side of that check fails, it builds the changed read models
 * directly (no `+`) and holds. Without a BigQuery connection it is `full`.
 */
export async function resolveDbtBeforeDeploy(
  prep: DbtDeployPrep,
  ctx: {
    workspaceId: string;
    sha: string;
    /** Called once the project has compiled. */
    onCompiled?: () => Promise<void>;
  },
): Promise<DbtBeforeDeployPlan | null> {
  const allReads = [...new Set(Object.values(prep.readsByApp).flat())].sort();
  const base = { projectId: prep.projectId, environment: prep.environment };

  const full = (): DbtBeforeDeployPlan | null =>
    prep.hasProdManifest
      ? {
          ...base,
          held: prep.readers,
          now: prep.now,
          models: allReads,
          command: preDeployBuildCommand(allReads),
        }
      : null;
  if (prep.mode === "full") return full();

  const outcome = await detectSchemaGap({
    workspaceId: ctx.workspaceId,
    projectId: prep.projectId,
    environment: prep.environment,
    connectionId: prep.connectionId,
    sha: ctx.sha,
    reads: allReads,
    changedPaths: prep.changedPaths,
    onCompiled: ctx.onCompiled,
  });
  if (outcome.kind === "full") return full();
  const models = outcome.kind === "gap" ? outcome.gap.models : outcome.models;
  if (models.length === 0) return null;

  // An app waits only when it reads a node being built (names compare
  // without case: a binding's table name is lowercased).
  const building = new Set(models.map(m => m.toLowerCase()));
  const waits = (id: string) =>
    (prep.readsByApp[id] ?? []).some(model => building.has(model));
  const held = prep.readers.filter(waits);
  if (held.length === 0) return null;
  return {
    ...base,
    held,
    now: prep.now,
    models,
    command: gapBuildCommand(models),
  };
}

/** The Inngest event that runs the gap check and the hold off the webhook. */
export const APPS_DBT_HOLD_EVENT = "apps/dbt-hold.requested";

export interface AppsDbtHoldEventData {
  workspaceId: string;
  /** The commit the deploys target (the head of main when it descends). */
  sha: string;
  /** The pushed commit the check compiles. */
  after: string;
  prep: DbtDeployPrep;
}

/** Deploy the apps that read dbt models, now, unrestricted. */
async function deployReadersNow(data: AppsDbtHoldEventData): Promise<void> {
  const { requestAppDeploys } =
    await import("../inngest/functions/apps-deploy");
  await requestAppDeploys(
    data.workspaceId,
    data.prep.readers,
    data.sha,
    "push",
  );
}

/**
 * Mark the readers "queued" again. The mark is good for 30 minutes
 * (deploy-progress.ts), and the hourly reconcile deploys any app whose mark
 * lapsed: against the old prod tables. The check waits in the Inngest queue
 * and compiles for up to 10 minutes, so it renews the mark at its start and
 * after the compile.
 */
async function renewQueued(data: AppsDbtHoldEventData): Promise<void> {
  await Promise.all(
    data.prep.readers.map(appId => markDeployQueued(appId, data.sha)),
  );
}

/**
 * Step 1 of the check: the plan for the apps waiting on it. Null means
 * "deploy them all now": nothing needs building, or the pushed commit does
 * not compile. Any other failure throws, so the Inngest retry runs the step
 * again (and `onFailure` deploys the apps when the retries are spent).
 */
export async function planDbtHold(
  data: AppsDbtHoldEventData,
): Promise<DbtBeforeDeployPlan | null> {
  const { workspaceId, sha, after, prep } = data;
  await renewQueued(data);
  try {
    return await resolveDbtBeforeDeploy(prep, {
      workspaceId,
      sha: after,
      onCompiled: () => renewQueued(data),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "DbtCompileError") {
      logger.warn("The pushed commit does not compile; deploying now", {
        workspaceId,
        sha,
        error: error.message,
      });
      return null;
    }
    throw error;
  }
}

/**
 * Drop the apps whose deploy of `sha` is already running. A new request would
 * cancel it and start over, which is what a retry of the "hold" step would do
 * to the free apps it requested the first time. The "queued" mark does not
 * count: it is this check's own (and the deploy function's first stage).
 */
async function withoutRunningDeploys(
  appIds: string[],
  sha: string,
): Promise<string[]> {
  if (appIds.length === 0) return appIds;
  const rows = await AppProject.find({
    _id: { $in: appIds.filter(id => Types.ObjectId.isValid(id)) },
  })
    .select("deployProgress")
    .lean();
  const running = new Set(
    rows
      .filter(
        row =>
          row.deployProgress?.stage !== "queued" &&
          isDeployInFlight(row.deployProgress, sha),
      )
      .map(row => row._id.toString()),
  );
  return appIds.filter(id => !running.has(id));
}

/**
 * Step 2: act on the plan. The apps that need no build are requested, the
 * others wait on one dbt run. A saved plan makes a retry of this step skip
 * the compile and the warehouse.
 */
export async function applyDbtHold(
  data: AppsDbtHoldEventData,
  plan: DbtBeforeDeployPlan | null,
): Promise<{ held: string[] }> {
  const { workspaceId, sha, prep } = data;
  if (!plan) {
    await deployReadersNow(data);
    return { held: [] };
  }
  const { requestAppDeploys } =
    await import("../inngest/functions/apps-deploy");
  const waiting = new Set(plan.held);
  const free = await withoutRunningDeploys(
    prep.readers.filter(id => !waiting.has(id)),
    sha,
  );
  if (free.length > 0) {
    await requestAppDeploys(workspaceId, free, sha, "push");
  }
  await holdDeploysForDbtRun({ workspaceId, sha, plan });
  return { held: plan.held };
}

/** Both steps in one call (the inline `full` path, and tests). */
export async function settleDbtBeforeDeploy(
  data: AppsDbtHoldEventData,
): Promise<{ held: string[] }> {
  return applyDbtHold(data, await planDbtHold(data));
}

/**
 * The check failed for good: deploy the readers, except the ones a dbt run
 * already holds for this commit. Requesting a deploy of a held app would
 * run it against the old prod tables, and cancel nothing useful.
 */
export async function deployReadersAfterFailedCheck(
  data: AppsDbtHoldEventData,
): Promise<string[]> {
  const runs = await DbtRun.find({
    "deploysAfterRun.workspaceId": data.workspaceId,
    "deploysAfterRun.sha": data.sha,
  })
    .select("deploysAfterRun.appIds")
    .lean();
  const held = new Set(runs.flatMap(run => run.deploysAfterRun?.appIds ?? []));
  const ids = data.prep.readers.filter(id => !held.has(id));
  if (ids.length === 0) return [];
  const { requestAppDeploys } =
    await import("../inngest/functions/apps-deploy");
  await requestAppDeploys(data.workspaceId, ids, data.sha, "push");
  return ids;
}

/** An event id that dedupes a redelivered webhook for the same push. */
export function dbtHoldEventId(data: AppsDbtHoldEventData): string {
  const readers = createHash("sha256")
    .update([...data.prep.readers].sort().join(","))
    .digest("hex")
    .slice(0, 16);
  return `apps-dbt-hold:${data.workspaceId}:${data.sha}:${readers}`;
}

/**
 * The webhook's part, after the apps that read no dbt model are requested.
 * `full` is cheap (no compile), so it settles here. `schema-gap` compiles
 * the project, so it moves to an Inngest function that survives the
 * instance. The readers are marked queued first, so the hourly reconcile
 * leaves them alone and `app_publish_status` says a deploy is coming. When
 * the event cannot be sent they deploy at once.
 */
export async function startDbtBeforeDeploy(
  data: AppsDbtHoldEventData,
): Promise<void> {
  const { workspaceId, sha, prep } = data;
  if (prep.mode === "full") {
    await settleDbtBeforeDeploy(data);
    return;
  }
  await renewQueued(data);
  try {
    await inngest.send({
      id: dbtHoldEventId(data),
      name: APPS_DBT_HOLD_EVENT,
      data,
    });
  } catch (error) {
    logger.warn("Could not queue the dbt schema-gap check; deploying now", {
      workspaceId,
      sha,
      error: error instanceof Error ? error.message : String(error),
    });
    await deployReadersNow(data);
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
}): Promise<string | null> {
  const { workspaceId, sha, plan } = input;
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
      commands: [plan.command],
      // "schedule", not "ci": in this codebase "ci" means a pull request's
      // head with a `ci` context (GitHub status on the PR, the CI config's
      // defer). This run builds committed main into the prod-like
      // environment, exactly what a scheduled job run does, and both pass
      // the ad-hoc guard (dbt-run.service, isAdhocRun).
      trigger: "schedule",
      triggeredBy: "apps-deploy-on-push",
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
