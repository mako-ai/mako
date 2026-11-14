/**
 * dbt job rename handler (see ../types.ts for the contract, and
 * ../slug-file-rename.ts for the service jobs share with flows).
 *
 * A job is `dbt/jobs/<slug>.yml` at main plus a scheduler row whose id is
 * its URL (`/x/<projectId>/job/<jobId>`) and the key of its run history and
 * scheduler claim. `title` rewrites `name:`; `slug` moves the file and
 * re-keys that row in place.
 *
 * Who may rename is what the job PATCH route takes (dbt/rbac.ts): the admin
 * or owner role. A credential with no person behind it is a workspace key,
 * which that route treats as full access.
 */
import {
  DbtJob,
  DbtProject,
  type IDbtProject,
} from "../../database/workspace-schema";
import { jobFilePath } from "../../dbt/dbt-config-files";
import { loadLiveJobs } from "../../dbt/dbt-config.service";
import { resolveDbtAccess } from "../../dbt/rbac";
import { publishRealtimeEvent } from "../../services/realtime.service";
import {
  renameSlugFile,
  resolveSlugRef,
  type SlugRenameDeps,
} from "../slug-file-rename";
import { DBT_JOB_FILES } from "../slug-files";
import { RenameError, type RenameContext, type RenameHandler } from "../types";

function jobDeps(project: IDbtProject): SlugRenameDeps {
  const workspaceId = project.workspaceId.toString();
  const projectId = project._id.toString();
  const url = (id: string) => `/x/${projectId}/job/${id}`;
  return {
    scope: { projectId: project._id },
    locate: row => ({
      title: row.name ?? row.slug,
      slug: row.slug,
      path: row.slug ? jobFilePath(row.slug) : undefined,
      url: url(String(row._id)),
    }),
    async gitOnly(ref) {
      const live = (await loadLiveJobs(project)).find(
        item => !item.row && (item.def.slug === ref || String(item.id) === ref),
      );
      if (!live) return null;
      const id = String(live.id);
      return {
        id,
        current: {
          title: live.def.parsed?.name ?? live.def.slug,
          slug: live.def.slug,
          path: live.def.path,
          url: url(id),
        },
      };
    },
    async resync(id) {
      // The job list brings every row level with its file at main.
      await loadLiveJobs(project);
      const row = await DbtJob.findById(id).select("definitionInvalid").lean();
      return typeof row?.definitionInvalid?.reason !== "string";
    },
    announce: () =>
      publishRealtimeEvent(workspaceId, { type: "dbt.job.updated", projectId }),
  };
}

function projectOf(ctx: RenameContext): Promise<IDbtProject | null> {
  return DbtProject.findOne({ workspaceId: ctx.workspaceId });
}

export const dbtJobRenameHandler: RenameHandler = {
  kind: "dbt_job",
  describe:
    "`title` = display name (`name:` in dbt/jobs/<slug>.yml); `slug` = file name: the file is moved and the old slug kept in its `aliases:`, so the old name still resolves. The id, /x/<project>/job/<id>, the schedule and the run history do not change. `ref` = job id, slug, or an old slug. Admin or owner.",

  async resolve(ctx, ref) {
    const project = await projectOf(ctx);
    return project
      ? resolveSlugRef(DBT_JOB_FILES, jobDeps(project), ref)
      : null;
  },

  async rename(ctx, request) {
    const project = await projectOf(ctx);
    if (!project) {
      throw new RenameError("This workspace has no dbt project.", 404);
    }
    const access = resolveDbtAccess({
      method: "PATCH",
      path: `/api/workspaces/${ctx.workspaceId}/dbt/projects/${project._id}/jobs/job`,
      role: ctx.userId ? ctx.role : "owner",
    });
    if (!access.ok) {
      throw new RenameError(access.error ?? "Not allowed to rename jobs", 403);
    }
    return renameSlugFile(DBT_JOB_FILES, jobDeps(project), ctx, request);
  },
};
