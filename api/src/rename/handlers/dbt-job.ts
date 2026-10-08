import { renameDbtJob, resolveDbtJobRef } from "../dbt-job-rename";
import type { RenameHandler } from "../types";

/**
 * dbt jobs: `title` is the display name (`name:` in `dbt/jobs/<slug>.yml`),
 * `slug` is the file name. The service (../dbt-job-rename.ts) is the one
 * rename path; admin/owner, as the job PATCH route.
 */
export const dbtJobRenameHandler: RenameHandler = {
  kind: "dbt_job",
  describe:
    "dbt_job: `title` = display name (`name:` in dbt/jobs/<slug>.yml); `slug` = file name — the file is moved and the old slug kept in its `aliases:`; the id, /x/<project>/job/<id> URL, schedule and run history never change. `ref` = job id, slug, or an old slug. Admin/owner only.",
  resolve: resolveDbtJobRef,
  rename: renameDbtJob,
};
