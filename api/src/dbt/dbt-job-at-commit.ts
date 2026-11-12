// Owner: WP1 (run core). Stub: the signatures are the contract.
import type { DbtJobFile } from "./dbt-config-files";

export type JobDefinitionAtCommit =
  /** `dbt/jobs/<slug>.yml` exists and parses. Caller still validates it. */
  | { kind: "ok"; file: DbtJobFile; blobSha: string }
  /** The file exists and does not parse. */
  | { kind: "invalid"; blobSha: string }
  /** No such file at that commit: the job was deleted. */
  | { kind: "missing" };

/** Read one job definition at a pinned commit of the workspace repo. */
export async function readJobDefinitionAtCommit(
  workspaceId: string,
  slug: string,
  sha: string,
): Promise<JobDefinitionAtCommit> {
  void workspaceId;
  void slug;
  void sha;
  throw new Error("not implemented");
}
