/**
 * Errors of the dbt run trigger path that callers map to a response.
 *
 * Its own module, with no service imports: the REST routes and the agent
 * tools test against a mocked `dbt-run.service`, and an `instanceof` check
 * needs the real class on both sides.
 */
import type { IDbtJob } from "../database/workspace-schema";

/**
 * Why a scheduled tick started no run. Stored on the job as
 * `scheduledRun.lastSkippedReason`.
 *
 *  - `active_run`: a run of the job was still queued or running.
 *  - `definition_missing`: the job file is gone at the commit.
 *  - `disabled_in_file`: the job file at the commit says `enabled: false`.
 *  - `unscheduled_in_file`: the job file at the commit has no schedule.
 */
export type DbtSkippedTickReason =
  | "active_run"
  | "definition_missing"
  | "disabled_in_file"
  | "unscheduled_in_file";

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

/**
 * A scheduled tick fired for a job whose file, at the commit the run would
 * build, says the schedule is off: `enabled: false`, or no `schedule`. The
 * row that fired the tick is older than that commit. Nothing may run: the
 * commit is the definition. Only scheduled ticks raise this; a manual or an
 * agent trigger runs a job whatever its schedule says.
 */
export class DbtJobNotScheduledAtCommitError extends Error {
  readonly jobId: string;
  readonly sourceSha: string;
  readonly reason: "disabled_in_file" | "unscheduled_in_file";

  constructor(
    job: Pick<IDbtJob, "_id" | "slug">,
    sourceSha: string,
    reason: "disabled_in_file" | "unscheduled_in_file",
  ) {
    super(
      `Job file dbt/jobs/${job.slug}.yml at commit ${sourceSha.slice(0, 7)} of the default branch ` +
        (reason === "disabled_in_file"
          ? "says enabled: false"
          : "has no schedule") +
        ". The scheduled tick was skipped. No run started.",
    );
    this.name = "DbtJobNotScheduledAtCommitError";
    this.jobId = job._id.toString();
    this.sourceSha = sourceSha;
    this.reason = reason;
  }
}
