/**
 * A job definition read at one pinned commit.
 *
 * A job run builds the tree at `run.sourceSha`. Its commands, environment and
 * defer flag must come from `dbt/jobs/<slug>.yml` at that same commit: the
 * Mongo row is a derived index that follows main through a detached push
 * sync, so for a moment after a push (or for as long as a webhook is late)
 * the row describes an older commit than the one the run checks out.
 *
 * Lives outside dbt-config.service because that module imports
 * dbt-run.service, which calls this.
 */
import {
  blobOid,
  readBlobsBatch,
  repoDirFor,
  resolveCommit,
} from "../apps/repository.service";
import { jobFilePath, parseJobFile, type DbtJobFile } from "./dbt-config-files";

export type JobDefinitionAtCommit =
  /** `dbt/jobs/<slug>.yml` exists and parses. Caller still validates it. */
  | { kind: "ok"; file: DbtJobFile; blobSha: string }
  /** The file exists and does not parse. */
  | { kind: "invalid"; blobSha: string }
  /** No such file at that commit: the job was deleted. */
  | { kind: "missing" };

/**
 * Read one job definition at a pinned commit of the workspace repo.
 *
 * `sha` must be a commit the local clone already holds (the caller resolved
 * it there). A git failure or an unknown commit throws: an unreadable repo
 * is not a deleted job.
 */
export async function readJobDefinitionAtCommit(
  workspaceId: string,
  slug: string,
  sha: string,
): Promise<JobDefinitionAtCommit> {
  const path = jobFilePath(slug);
  // cat-file reports an absent path as "missing" instead of failing, which
  // is the one distinction this function exists to make.
  const repoDir = repoDirFor(workspaceId);
  const blobs = await readBlobsBatch(repoDir, sha, [path]);
  const bytes = blobs.get(path);
  if (!bytes) {
    // cat-file also says "missing" for a commit this clone does not hold.
    // That is a broken read, never a deleted job.
    if (!(await resolveCommit(repoDir, sha))) {
      throw new Error(
        `Commit ${sha.slice(0, 7)} is not in the workspace repo; cannot read ${path}`,
      );
    }
    return { kind: "missing" };
  }
  const blobSha = blobOid(bytes);
  if (bytes.includes(0)) return { kind: "invalid", blobSha };
  const file = parseJobFile(bytes.toString("utf8"));
  return file ? { kind: "ok", file, blobSha } : { kind: "invalid", blobSha };
}
