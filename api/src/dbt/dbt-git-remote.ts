/**
 * Remote URL + auth resolution for repo-bound dbt projects.
 *
 * Kept in its own tiny module so tests can mock it and point the git store at
 * a local bare repo (file path) standing in for GitHub.
 */
import type { IDbtRepoBinding } from "../database/workspace-schema";
import { resolveRepoToken } from "../integrations/github/app-auth";

export interface ResolvedRemote {
  /** URL (or local path in tests) `git fetch` / `git push` talk to. */
  url: string;
  /**
   * `http.extraheader` value carrying the auth token, or undefined for
   * anonymous access (public repos). Passing the token as a header keeps it
   * out of the URL, and therefore out of git's error output.
   */
  authHeader?: string;
}

export async function resolveProjectRemote(
  binding: Pick<IDbtRepoBinding, "owner" | "repo" | "installationId">,
): Promise<ResolvedRemote> {
  const token = await resolveRepoToken(binding.installationId);
  const url = `https://github.com/${binding.owner}/${binding.repo}.git`;
  if (!token) return { url };
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { url, authHeader: `Authorization: Basic ${basic}` };
}
