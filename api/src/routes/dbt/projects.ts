/** dbt projects: list, create, read, update, delete, and environments. */
import { Hono } from "hono";
import { Types } from "mongoose";
import { z } from "zod";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import {
  DbtEnvPreference,
  DbtJob,
  DbtProject,
  DbtRun,
  DatabaseConnection,
} from "../../database/workspace-schema";
import {
  commitDbtFiles,
  readWorkingFile,
} from "../../dbt/dbt-working-tree.service";
import {
  DBT_COMPATIBLE_CONNECTION_TYPES,
  isDbtCompatibleConnectionType,
} from "../../dbt/adapter-map";
import { buildStarterScaffold } from "../../dbt/scaffold";
import {
  commitDbtEnvironmentsFile,
  ensureEnvironmentsDerivedCache,
} from "../../dbt/dbt-config.service";
import {
  ensurePersonalDbtEnvironment,
  setUserDevEnvPreference,
} from "../../dbt/dbt-environments.service";
import {
  logger,
  getUserId,
  badRequest,
  serverError,
  publishDbtEvent,
  findProject,
} from "./context";
import { fail } from "../lib/respond";

export const dbtProjectRoutes = new Hono();

const environmentSchema = z.object({
  name: z.string().min(1).max(64),
  connectionId: z
    .string()
    .refine(Types.ObjectId.isValid, "Invalid connection id"),
  /**
   * Optional read-only connection to the same warehouse: metric queries run
   * on it instead of the build connection. Empty or absent: none.
   */
  readConnectionId: z
    .string()
    .refine(
      value => value === "" || Types.ObjectId.isValid(value),
      "Invalid read connection id",
    )
    .optional(),
  targetSchema: z.string().min(1).max(128),
  threads: z.number().int().min(1).max(16).default(4),
  vars: z.record(z.string(), z.unknown()).optional(),
  /**
   * Personal environment owner (per-developer target). Auto-provisioned via
   * POST .../environments/personal, and editable from environment settings
   * (claim/release). Round-tripped by settings saves so admin edits never
   * strip ownership.
   */
  ownerUserId: z.string().optional(),
});

const createProjectSchema = z.object({
  name: z.string().min(1).max(128),
  dbtVersion: z.string().max(16).optional(),
  environments: z.array(environmentSchema).min(1),
  defaultEnvironment: z.string().min(1),
});

const patchProjectSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  dbtVersion: z.string().max(16).optional(),
  environments: z.array(environmentSchema).min(1).optional(),
  defaultEnvironment: z.string().min(1).optional(),
  /**
   * Explicit production (defer target) environment; empty string clears the
   * override back to the convention (env named "prod", else the default).
   */
  prodEnvironment: z.string().max(64).optional(),
});

/**
 * Personal environments are per-user build targets: at most one per user, and
 * never the shared default or the production (defer target) environment —
 * both are resolved for OTHER users too, so pointing them at a private
 * schema would leak one developer's scratch data into everyone's builds.
 */
function validatePersonalEnvironments(
  environments: Array<{ name: string; ownerUserId?: string }>,
  defaultEnvironment: string | undefined,
  prodEnvironment: string | undefined,
): string | null {
  const ownedNames = new Map<string, string>();
  for (const env of environments) {
    if (!env.ownerUserId) continue;
    const prior = ownedNames.get(env.ownerUserId);
    if (prior) {
      return (
        `"${prior}" and "${env.name}" are personal environments of the ` +
        `same user — each user can own only one per project`
      );
    }
    ownedNames.set(env.ownerUserId, env.name);
  }
  const isPersonal = (name: string | undefined) =>
    Boolean(name) && environments.some(e => e.name === name && e.ownerUserId);
  if (isPersonal(defaultEnvironment)) {
    return `Default environment "${defaultEnvironment}" cannot be a personal environment`;
  }
  if (isPersonal(prodEnvironment)) {
    return `Production environment "${prodEnvironment}" cannot be a personal environment`;
  }
  return null;
}

async function validateEnvironments(
  workspaceId: string,
  environments: z.infer<typeof environmentSchema>[],
): Promise<string | null> {
  const names = new Set<string>();
  for (const env of environments) {
    if (names.has(env.name)) return `Duplicate environment name "${env.name}"`;
    names.add(env.name);
    const connection = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(env.connectionId),
      workspaceId: new Types.ObjectId(workspaceId),
    }).select("type");
    if (!connection) {
      return `Connection not found for environment "${env.name}"`;
    }
    if (!isDbtCompatibleConnectionType(connection.type)) {
      return (
        `Connection type "${connection.type}" is not dbt-compatible. ` +
        `Supported: ${DBT_COMPATIBLE_CONNECTION_TYPES.join(", ")}`
      );
    }
    if (env.readConnectionId) {
      const read = await DatabaseConnection.findOne({
        _id: new Types.ObjectId(env.readConnectionId),
        workspaceId: new Types.ObjectId(workspaceId),
      }).select("type");
      if (!read) {
        return `Read connection not found for environment "${env.name}"`;
      }
      // MetricFlow writes SQL for the warehouse dbt built in: the read
      // connection has to be that warehouse under another credential.
      if (read.type !== connection.type) {
        return (
          `The read connection of environment "${env.name}" is a ` +
          `"${read.type}" connection, but the environment builds on ` +
          `"${connection.type}". Both must reach the same warehouse.`
        );
      }
    }
  }
  return null;
}

/** An environment as the route received it, as the model stores it. */
function toStoredEnvironment(env: z.infer<typeof environmentSchema>) {
  const { readConnectionId, ...rest } = env;
  return {
    ...rest,
    connectionId: new Types.ObjectId(env.connectionId),
    ...(readConnectionId
      ? { readConnectionId: new Types.ObjectId(readConnectionId) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

// GET / — list projects with job/run rollups for the explorer. Each project
// carries `myDevEnvironment`: the CALLER's saved per-user dev environment
// (single player: unset → the shared default; teams: each user's own).
dbtProjectRoutes.get("/projects", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      return badRequest(c, "Valid workspace ID is required");
    }
    const docs = await DbtProject.find({
      workspaceId: new Types.ObjectId(workspaceId),
    }).sort({ updatedAt: -1 });
    // Environments follow dbt/environments.yml at main (apps.md §23).
    for (const doc of docs) {
      try {
        await ensureEnvironmentsDerivedCache(doc);
      } catch (error) {
        logger.warn("ensureEnvironmentsDerivedCache failed", {
          projectId: doc._id.toString(),
          error,
        });
      }
    }
    const projects = docs.map(doc => doc.toObject());
    const userId = getUserId(c);
    const prefs = await DbtEnvPreference.find({
      projectId: { $in: projects.map(p => p._id) },
      userId,
    })
      .select("projectId environment")
      .lean();
    const prefByProject = new Map(
      prefs.map(pref => [pref.projectId.toString(), pref.environment]),
    );
    const enriched = projects.map(project => {
      const preferred = prefByProject.get(project._id.toString());
      // Stale choices (env renamed/removed) are dropped, not surfaced.
      const valid =
        preferred && project.environments.some(env => env.name === preferred)
          ? preferred
          : undefined;
      return { ...project, myDevEnvironment: valid };
    });
    return c.json({ success: true, projects: enriched });
  } catch (error) {
    return serverError(c, error, "Failed to list dbt projects");
  }
});

dbtProjectRoutes.post("/projects", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      return badRequest(c, "Valid workspace ID is required");
    }
    const parsed = createProjectSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return badRequest(
        c,
        parsed.error.issues[0]?.message ?? "Invalid project",
      );
    }
    const body = parsed.data;
    if (!body.environments.some(env => env.name === body.defaultEnvironment)) {
      return badRequest(
        c,
        `Default environment "${body.defaultEnvironment}" is not in environments`,
      );
    }
    const envError = await validateEnvironments(workspaceId, body.environments);
    if (envError) return badRequest(c, envError);
    const personalError = validatePersonalEnvironments(
      body.environments,
      body.defaultEnvironment,
      undefined,
    );
    if (personalError) return badRequest(c, personalError);

    const userId = getUserId(c);
    // ONE dbt project per workspace: the project is the `dbt/` folder of the
    // workspace repo (apps.md §20), and two projects cannot share it.
    const existing = await DbtProject.exists({
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (existing) {
      return badRequest(
        c,
        "This workspace already has a dbt project (dbt/ in the workspace repo)",
      );
    }
    const project = new DbtProject({
      workspaceId: new Types.ObjectId(workspaceId),
      name: body.name,
      dbtVersion: body.dbtVersion ?? "1.12",
      environments: body.environments.map(toStoredEnvironment),
      defaultEnvironment: body.defaultEnvironment,
      createdBy: userId,
    });
    // Git first (issue #956): the file is the record, the row follows.
    await commitDbtEnvironmentsFile(project, userId);
    await project.save();

    // Scaffold straight into the workspace repo: dbt/ appears as one commit
    // on the creator's session branch. A pre-existing dbt/dbt_project.yml
    // (external import) is left untouched.
    const alreadyInRepo = await readWorkingFile(
      project,
      userId,
      "dbt_project.yml",
    );
    if (!alreadyInRepo) {
      const scaffold = buildStarterScaffold(body.name);
      await commitDbtFiles(
        project,
        userId,
        Object.fromEntries(scaffold.map(f => [f.path, f.content])),
        `dbt: scaffold project "${body.name}"`,
      );
    }

    publishDbtEvent(c, {
      type: "dbt.project.updated",
      projectId: project._id.toString(),
    });
    return c.json({ success: true, project });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return badRequest(c, "A dbt project with this name already exists");
    }
    return serverError(c, error, "Failed to create dbt project");
  }
});

dbtProjectRoutes.get(
  "/projects/:projectId",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      // Environments follow dbt/environments.yml at main (apps.md §23).
      await ensureEnvironmentsDerivedCache(project);
      return c.json({ success: true, project });
    } catch (error) {
      return serverError(c, error, "Failed to fetch dbt project");
    }
  },
);

dbtProjectRoutes.patch(
  "/projects/:projectId",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const parsed = patchProjectSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        return badRequest(
          c,
          parsed.error.issues[0]?.message ?? "Invalid patch",
        );
      }
      const body = parsed.data;

      if (body.environments) {
        const envError = await validateEnvironments(
          project.workspaceId.toString(),
          body.environments,
        );
        if (envError) return badRequest(c, envError);
        project.environments = body.environments.map(toStoredEnvironment);
      }
      if (body.name) project.name = body.name;
      if (body.dbtVersion) project.dbtVersion = body.dbtVersion;
      if (body.defaultEnvironment) {
        project.defaultEnvironment = body.defaultEnvironment;
      }
      if (
        !project.environments.some(
          env => env.name === project.defaultEnvironment,
        )
      ) {
        return badRequest(
          c,
          `Default environment "${project.defaultEnvironment}" is not in environments`,
        );
      }
      if (body.prodEnvironment !== undefined) {
        if (body.prodEnvironment === "") {
          project.prodEnvironment = undefined;
        } else {
          if (
            !project.environments.some(env => env.name === body.prodEnvironment)
          ) {
            return badRequest(
              c,
              `Production environment "${body.prodEnvironment}" is not in environments`,
            );
          }
          project.prodEnvironment = body.prodEnvironment;
        }
      }
      {
        const personalError = validatePersonalEnvironments(
          project.environments,
          project.defaultEnvironment,
          project.prodEnvironment,
        );
        if (personalError) return badRequest(c, personalError);
      }
      await commitDbtEnvironmentsFile(project, getUserId(c));
      await project.save();
      publishDbtEvent(c, {
        type: "dbt.project.updated",
        projectId: project._id.toString(),
      });
      return c.json({ success: true, project });
    } catch (error) {
      return serverError(c, error, "Failed to update dbt project");
    }
  },
);

// POST /projects/:projectId/environments/personal — idempotently provision
// the caller's personal (per-developer) environment: same connection as the
// prod-like environment, private schema `dbt_<user>`. Member+ (not admin-only:
// unlike shared environment config, this only affects the caller's own
// iteration target).
dbtProjectRoutes.post(
  "/projects/:projectId/environments/personal",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const userId = c.get("user")?.id;
      if (!userId) {
        return badRequest(
          c,
          "Personal environments require a user session (not an API key)",
        );
      }
      const result = await ensurePersonalDbtEnvironment({
        workspaceId: project.workspaceId.toString(),
        projectId: project._id.toString(),
        userId,
      });
      if (result.created) {
        publishDbtEvent(c, {
          type: "dbt.project.updated",
          projectId: project._id.toString(),
        });
      }
      return c.json({
        success: true,
        created: result.created,
        environment: {
          name: result.environment.name,
          targetSchema: result.environment.targetSchema,
          connectionId: result.environment.connectionId?.toString(),
          threads: result.environment.threads,
          ownerUserId: result.environment.ownerUserId,
        },
      });
    } catch (error) {
      return serverError(c, error, "Failed to create personal environment");
    }
  },
);

// PUT /projects/:projectId/my-environment — the CALLER's default DEVELOPMENT
// environment for this project (a per-user setting: the editor/console env
// pickers persist here, and agent builds default to it). Body:
// { environment } — "" clears back to Auto (personal env when provisioned,
// else the project default). Member+ (only affects the caller's own target).
dbtProjectRoutes.put(
  "/projects/:projectId/my-environment",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      const parsed = z
        .object({ environment: z.string().max(64) })
        .safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        return badRequest(c, "environment (string) is required");
      }
      const environment = parsed.data.environment;
      if (
        environment !== "" &&
        !project.environments.some(env => env.name === environment)
      ) {
        return badRequest(
          c,
          `Environment "${environment}" is not in the project`,
        );
      }
      const userId = getUserId(c);
      await setUserDevEnvPreference({
        workspaceId: project.workspaceId,
        projectId: project._id,
        userId,
        environment: environment === "" ? null : environment,
      });
      return c.json({
        success: true,
        myDevEnvironment: environment === "" ? undefined : environment,
      });
    } catch (error) {
      return serverError(c, error, "Failed to save your dev environment");
    }
  },
);

dbtProjectRoutes.delete(
  "/projects/:projectId",
  async (c: AuthenticatedContext) => {
    try {
      const project = await findProject(c);
      if (!project) {
        return fail(c, 404, "dbt project not found");
      }
      // The dbt/ folder in the repo is deliberately left alone: deleting the
      // project row removes the runner surface, not the files (git history is
      // the recovery path either way).
      await Promise.all([
        DbtEnvPreference.deleteMany({ projectId: project._id }),
        DbtJob.deleteMany({ projectId: project._id }),
        DbtRun.deleteMany({ projectId: project._id }),
      ]);
      await project.deleteOne();
      publishDbtEvent(c, {
        type: "dbt.project.updated",
        projectId: project._id.toString(),
      });
      return c.json({ success: true });
    } catch (error) {
      return serverError(c, error, "Failed to delete dbt project");
    }
  },
);
