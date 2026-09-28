/**
 * `mako dbt run|build|test` — a dbt run of a developer's LOCAL checkout,
 * executed by Mako's runner (same executor, same warehouse credentials, same
 * run history and logs as every other run).
 *
 * Why it exists: a `mako login` token could read dbt but not run it, so
 * developers ran dbt on their laptops with their own cloud credentials —
 * against prod, too. This gives them the runner instead, with a narrower
 * authority than `warehouse:write`:
 *
 *   - `dbt:personal` builds only an environment the caller OWNS
 *     (`ownerUserId` = caller) — their own `dbt_<user>` schema, provisioned
 *     on first use exactly as the agent's dbt_run_model does.
 *   - a shared environment needs `warehouse:write`, which the OAuth consent
 *     screen only grants on an explicit, unticked-by-default checkbox.
 *   - the prod-like environment refuses ad-hoc warehouse writes whatever
 *     the scope (assertAdhocDbtRunAllowed, via triggerDbtRun): prod is
 *     built from main by jobs.
 *
 * Browser sessions are full members acting as themselves: they may target
 * any non-prod environment, as the IDE's Run button can.
 */
import { Types } from "mongoose";
import {
  DbtProject,
  DbtRun,
  type IDbtProject,
  type IDbtRun,
} from "../database/workspace-schema";
import {
  hasWorkspaceApiKeyScope,
  type WorkspaceApiKeyScope,
} from "../auth/api-key-scopes";
import { ensureCommitLocally } from "../apps/cloud-repo.service";
import { repoForWorkspace } from "../apps/worktree.service";
import { resolveCommit } from "../apps/repository.service";
import {
  ensurePersonalDbtEnvironment,
  findPersonalEnvironment,
  resolveProdLikeEnvironmentName,
} from "./dbt-environments.service";
import { triggerDbtRun } from "./dbt-run.service";
import { parseDbtCommands } from "./commands";
import { storeLocalOverlay, type LocalOverlay } from "./local-overlay";

export const LOCAL_RUN_COMMANDS = ["run", "build", "test"] as const;
export type LocalRunCommand = (typeof LOCAL_RUN_COMMANDS)[number];

/** Same selector grammar dbt_run_model accepts: no whitespace, no shell. */
const SELECTOR_PATTERN = /^[\w.@:+*/,-]+$/;

/** A refusal the route maps to its HTTP status (400/403/404). */
export class LocalRunError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
  ) {
    super(message);
    this.name = "LocalRunError";
  }
}

/**
 * What the caller may build. A browser session is a member acting as
 * themselves; a token (MCP OAuth or scoped API key) is limited by its scopes.
 */
export type LocalRunAuthority =
  | { kind: "session" }
  | { kind: "token"; scopes: readonly WorkspaceApiKeyScope[] };

export function mayBuildSharedEnvironment(
  authority: LocalRunAuthority,
): boolean {
  return (
    authority.kind === "session" ||
    hasWorkspaceApiKeyScope(authority.scopes, "warehouse:write")
  );
}

export function mayBuildPersonalEnvironment(
  authority: LocalRunAuthority,
): boolean {
  return (
    mayBuildSharedEnvironment(authority) ||
    (authority.kind === "token" &&
      hasWorkspaceApiKeyScope(authority.scopes, "dbt:personal"))
  );
}

/** `build --select x+ --full-refresh`, validated by the one command parser. */
export function buildLocalRunCommand(input: {
  command: string;
  select: string;
  fullRefresh?: boolean;
}): string {
  if (!(LOCAL_RUN_COMMANDS as readonly string[]).includes(input.command)) {
    throw new LocalRunError(
      `Unsupported command "${input.command}" (use ${LOCAL_RUN_COMMANDS.join(", ")})`,
      400,
    );
  }
  if (!input.select || !SELECTOR_PATTERN.test(input.select)) {
    throw new LocalRunError(`Invalid selector "${input.select}"`, 400);
  }
  if (input.fullRefresh && input.command === "test") {
    throw new LocalRunError("--full-refresh does not apply to dbt test", 400);
  }
  const text = `${input.command} --select ${input.select}${input.fullRefresh ? " --full-refresh" : ""}`;
  try {
    parseDbtCommands([text]);
  } catch (error) {
    throw new LocalRunError(
      error instanceof Error ? error.message : String(error),
      400,
    );
  }
  return text;
}

type EnvProject = Pick<
  IDbtProject,
  "environments" | "defaultEnvironment" | "prodEnvironment"
>;

/**
 * May this caller build `environmentName`? Pure: the scope rule in one
 * place, so the route and the tests read the same decision.
 */
export function authorizeLocalRunEnvironment(input: {
  project: EnvProject;
  environmentName: string;
  userId: string;
  authority: LocalRunAuthority;
}): void {
  const { project, environmentName, userId, authority } = input;
  const environment = project.environments.find(
    env => env.name === environmentName,
  );
  if (!environment) {
    const names = project.environments.map(env => env.name).join(", ");
    throw new LocalRunError(
      `Environment "${environmentName}" not found (available: ${names || "none"})`,
      404,
    );
  }
  if (environment.ownerUserId === userId) {
    if (mayBuildPersonalEnvironment(authority)) return;
    throw new LocalRunError(
      "This sign-in cannot run dbt. Run `mako login` again and allow " +
        '"Build dbt in your personal environment".',
      403,
    );
  }
  if (environment.ownerUserId) {
    throw new LocalRunError(
      `Environment "${environmentName}" is another person's personal environment`,
      403,
    );
  }
  if (mayBuildSharedEnvironment(authority)) return;
  const prodLike = resolveProdLikeEnvironmentName(project) === environmentName;
  throw new LocalRunError(
    `"${environmentName}" is a ${prodLike ? "production" : "shared"} environment; ` +
      "this sign-in may only build your personal environment (omit --env). " +
      "Building shared environments needs `mako login --warehouse-write`" +
      (prodLike
        ? ", and production is only ever built from main by a job."
        : "."),
    403,
  );
}

/** The workspace's dbt project: the one named, or the only one there is. */
async function resolveLocalRunProject(
  workspaceId: string,
  projectId?: string,
): Promise<IDbtProject> {
  if (projectId) {
    if (!Types.ObjectId.isValid(projectId)) {
      throw new LocalRunError("Invalid project id", 400);
    }
    const project = await DbtProject.findOne({
      _id: new Types.ObjectId(projectId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!project) throw new LocalRunError("dbt project not found", 404);
    return project;
  }
  const projects = await DbtProject.find({
    workspaceId: new Types.ObjectId(workspaceId),
  }).limit(10);
  if (projects.length === 0) {
    throw new LocalRunError("This workspace has no dbt project", 404);
  }
  if (projects.length > 1) {
    throw new LocalRunError(
      "This workspace has several dbt projects; pass --project <id> (" +
        projects.map(p => `${p._id.toString()} ${p.name}`).join(", ") +
        ")",
      400,
    );
  }
  return projects[0];
}

export interface StartLocalRunInput {
  workspaceId: string;
  userId: string;
  authority: LocalRunAuthority;
  projectId?: string;
  command: string;
  select: string;
  environment?: string;
  fullRefresh?: boolean;
  defer?: boolean;
  /** Display-only: the checkout's branch ("local checkout on feat/x"). */
  sourceLabel?: string;
  overlay: LocalOverlay;
}

export interface StartLocalRunResult {
  run: IDbtRun;
  projectId: string;
  /** The personal environment was created by this call. */
  provisionedEnvironment?: { name: string; targetSchema: string };
}

export async function startLocalDbtRun(
  input: StartLocalRunInput,
): Promise<StartLocalRunResult> {
  const commandText = buildLocalRunCommand(input);
  let project = await resolveLocalRunProject(
    input.workspaceId,
    input.projectId,
  );
  const projectId = project._id.toString();

  // No --env: the caller's own environment, created on first use.
  let environmentName = input.environment;
  let provisionedEnvironment: StartLocalRunResult["provisionedEnvironment"];
  if (!environmentName) {
    const personal = findPersonalEnvironment(project, input.userId);
    if (personal) {
      environmentName = personal.name;
    } else {
      if (!mayBuildPersonalEnvironment(input.authority)) {
        // Fall through to the authorization message below.
        environmentName = project.defaultEnvironment;
      } else {
        const ensured = await ensurePersonalDbtEnvironment({
          workspaceId: input.workspaceId,
          projectId,
          userId: input.userId,
        });
        environmentName = ensured.environment.name;
        if (ensured.created) {
          provisionedEnvironment = {
            name: ensured.environment.name,
            targetSchema: ensured.environment.targetSchema,
          };
          project = (await DbtProject.findById(project._id)) ?? project;
        }
      }
    }
  }
  authorizeLocalRunEnvironment({
    project,
    environmentName,
    userId: input.userId,
    authority: input.authority,
  });

  // Refuse a base the server cannot build now, rather than queue a run
  // that fails in the executor a minute later.
  if (input.overlay.baseSha) {
    await ensureCommitLocally(input.workspaceId, input.overlay.baseSha);
    const repoDir = await repoForWorkspace(input.workspaceId);
    if (!(await resolveCommit(repoDir, input.overlay.baseSha))) {
      throw new LocalRunError(
        `Commit ${input.overlay.baseSha.slice(0, 7)} (where your checkout forked from main) ` +
          "is not in the workspace repo. Fetch and rebase on main, or push it, and retry.",
        400,
      );
    }
  }

  const key = await storeLocalOverlay(input.workspaceId, input.overlay);
  const defer =
    input.defer ??
    (Boolean(project.lastProdManifestKey) &&
      environmentName !== resolveProdLikeEnvironmentName(project));
  const label = (input.sourceLabel ?? "")
    .replace(/[^\w./@: -]/g, "")
    .trim()
    .slice(0, 100);
  const run = await triggerDbtRun({
    workspaceId: input.workspaceId,
    projectId,
    environment: environmentName,
    commands: [commandText],
    trigger: "manual",
    triggeredBy: input.userId,
    deferToProduction: defer,
    localOverlay: {
      key,
      baseSha: input.overlay.baseSha,
      files: Object.keys(input.overlay.files).length,
      deletes: input.overlay.deletes.length,
      label: label ? `local checkout on ${label}` : "local checkout",
    },
  });
  return { run, projectId, provisionedEnvironment };
}

/** A laptop run the caller started, or null (someone else's, or not one). */
export async function findOwnLocalRun(input: {
  workspaceId: string;
  userId: string;
  runId: string;
}): Promise<IDbtRun | null> {
  if (!Types.ObjectId.isValid(input.runId)) return null;
  return DbtRun.findOne({
    _id: new Types.ObjectId(input.runId),
    workspaceId: new Types.ObjectId(input.workspaceId),
    triggeredBy: input.userId,
    localOverlay: { $exists: true },
  });
}
