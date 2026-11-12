/**
 * Errors of the dbt run trigger path that callers map to a response.
 *
 * Its own module, with no service imports: the REST routes and the agent
 * tools test against a mocked `dbt-run.service`, and an `instanceof` check
 * needs the real class on both sides.
 */
import type { IDbtJob } from "../database/workspace-schema";

/**
 * `dbt/jobs/<slug>.yml` is absent at the commit a run of this job would
 * build: the job was deleted on main and the row has not caught up. Nothing
 * may run. The scheduler treats it as a skipped tick; a manual trigger
 * surfaces the message.
 */
export class DbtJobDefinitionMissingError extends Error {
  readonly jobId: string;
  readonly sourceSha: string;

  constructor(job: Pick<IDbtJob, "_id" | "slug">, sourceSha: string) {
    super(
      `Job file dbt/jobs/${job.slug}.yml does not exist at commit ${sourceSha.slice(0, 7)} of the default branch: the job was deleted. No run started.`,
    );
    this.name = "DbtJobDefinitionMissingError";
    this.jobId = job._id.toString();
    this.sourceSha = sourceSha;
  }
}
