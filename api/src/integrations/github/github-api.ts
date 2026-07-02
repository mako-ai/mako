/**
 * Minimal GitHub REST client (fetch-based, no octokit dependency). Only the
 * read endpoints needed to import a dbt project from a repo: repo metadata,
 * branch head, recursive git tree, and blob contents — plus listing the repos
 * an App installation can access.
 */

/**
 * Overridable for local development / testing against a GitHub API emulator
 * (see api/src/dbt/test-support/fake-github-server.mjs). Real deployments
 * leave this unset.
 */
const GITHUB_API = process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";

export interface GitHubRepoInfo {
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}

export interface GitTreeEntry {
  path: string;
  /** "blob" (file) or "tree" (directory). */
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface RepoTree {
  /** Tree SHA. */
  sha: string;
  truncated: boolean;
  entries: GitTreeEntry[];
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mako-dbt",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function ghFetch(
  path: string,
  token?: string,
  init?: { method: string; body?: unknown },
): Promise<Response> {
  const headers = authHeaders(token);
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const remaining = res.headers.get("x-ratelimit-remaining");
    const hint =
      res.status === 403 && remaining === "0"
        ? " (GitHub API rate limit exceeded — connect a GitHub App or set GITHUB_DEV_TOKEN)"
        : res.status === 401
          ? " (authentication required — connect a GitHub App or set GITHUB_DEV_TOKEN to write to this repo)"
          : res.status === 403
            ? " (no write access — the token/installation lacks permission)"
            : res.status === 404
              ? " (repo/branch not found or no access)"
              : res.status === 422
                ? " (validation failed — branch may already exist or be non-fast-forward)"
                : "";
    throw new Error(
      `GitHub ${res.status} on ${path}${hint}: ${body.slice(0, 200)}`,
    );
  }
  return res;
}

export async function getRepoInfo(
  owner: string,
  repo: string,
  token?: string,
): Promise<GitHubRepoInfo> {
  const res = await ghFetch(`/repos/${owner}/${repo}`, token);
  const json = (await res.json()) as {
    full_name: string;
    name: string;
    owner: { login: string };
    default_branch: string;
    private: boolean;
  };
  return {
    fullName: json.full_name,
    owner: json.owner.login,
    name: json.name,
    defaultBranch: json.default_branch,
    private: json.private,
  };
}

function encodeRepoPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join("/");
}

/** Whether a file exists at `path` on `ref` (branch name or commit SHA). */
export async function fileExistsAtRef(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token?: string,
): Promise<boolean> {
  const encoded = encodeRepoPath(path);
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    { headers: authHeaders(token) },
  );
  return res.ok;
}

const SKIP_ROOT_DIRS = new Set([
  ".git",
  ".github",
  "node_modules",
  "target",
  "dbt_packages",
  "dbt_internal_packages",
  "logs",
  "venv",
  ".venv",
]);

/**
 * Repo-root and first-level directories that contain `dbt_project.yml`.
 * Empty string means the repo root.
 */
export async function listDbtProjectSubdirectories(
  owner: string,
  repo: string,
  ref: string,
  token?: string,
): Promise<string[]> {
  const found: string[] = [];
  if (await fileExistsAtRef(owner, repo, "dbt_project.yml", ref, token)) {
    found.push("");
  }

  const res = await ghFetch(
    `/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(ref)}`,
    token,
  );
  const entries = (await res.json()) as Array<{
    name: string;
    type: string;
    path: string;
  }>;
  const dirs = entries
    .filter(entry => entry.type === "dir" && !SKIP_ROOT_DIRS.has(entry.name))
    .slice(0, 20);

  for (const dir of dirs) {
    if (
      await fileExistsAtRef(
        owner,
        repo,
        `${dir.path}/dbt_project.yml`,
        ref,
        token,
      )
    ) {
      found.push(dir.path);
    }
  }
  return found;
}

/** Commit SHA at the head of a branch. */
export async function getBranchHeadSha(
  owner: string,
  repo: string,
  branch: string,
  token?: string,
): Promise<string> {
  const res = await ghFetch(
    `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
    token,
  );
  const json = (await res.json()) as { commit: { sha: string } };
  return json.commit.sha;
}

/**
 * Recursive git tree for a ref (branch name or commit SHA). `truncated` is
 * true for very large repos (>100k entries) — callers should treat that as an
 * error for import.
 */
export async function getRepoTree(
  owner: string,
  repo: string,
  ref: string,
  token?: string,
): Promise<RepoTree> {
  const res = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    token,
  );
  const json = (await res.json()) as {
    sha: string;
    truncated: boolean;
    tree: GitTreeEntry[];
  };
  return { sha: json.sha, truncated: json.truncated, entries: json.tree };
}

/** UTF-8 decoded contents of a blob by SHA. */
export async function getBlobContent(
  owner: string,
  repo: string,
  sha: string,
  token?: string,
): Promise<string> {
  const res = await ghFetch(`/repos/${owner}/${repo}/git/blobs/${sha}`, token);
  const json = (await res.json()) as { content: string; encoding: string };
  if (json.encoding === "base64") {
    return Buffer.from(json.content, "base64").toString("utf8");
  }
  return json.content;
}

export interface InstallationRepo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

// --------------------------------------------------------------------------
// Write operations (Git Data API): commit & push, branches, pull requests.
// --------------------------------------------------------------------------

/** SHA the ref points at, plus the tree SHA of its commit. */
export async function getRefCommit(
  owner: string,
  repo: string,
  branch: string,
  token?: string,
): Promise<{ commitSha: string; treeSha: string }> {
  const refRes = await ghFetch(
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    token,
  );
  const ref = (await refRes.json()) as { object: { sha: string } };
  const commitRes = await ghFetch(
    `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`,
    token,
  );
  const commit = (await commitRes.json()) as { tree: { sha: string } };
  return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
}

export interface TreeChange {
  /** Repo-root-relative path. */
  path: string;
  /** New content (upsert), or null to delete the path. */
  content: string | null;
}

/**
 * Create a new tree from a base tree applying the given changes, create a
 * commit on top of `parentSha`, and fast-forward the branch ref to it.
 * Returns the new commit SHA.
 */
export async function commitChanges(
  owner: string,
  repo: string,
  params: {
    branch: string;
    parentSha: string;
    baseTreeSha: string;
    message: string;
    changes: TreeChange[];
  },
  token?: string,
): Promise<string> {
  const tree = params.changes.map(change =>
    change.content === null
      ? { path: change.path, mode: "100644", type: "blob", sha: null }
      : {
          path: change.path,
          mode: "100644",
          type: "blob",
          content: change.content,
        },
  );
  const treeRes = await ghFetch(`/repos/${owner}/${repo}/git/trees`, token, {
    method: "POST",
    body: { base_tree: params.baseTreeSha, tree },
  });
  const newTree = (await treeRes.json()) as { sha: string };

  const commitRes = await ghFetch(
    `/repos/${owner}/${repo}/git/commits`,
    token,
    {
      method: "POST",
      body: {
        message: params.message,
        tree: newTree.sha,
        parents: [params.parentSha],
      },
    },
  );
  const newCommit = (await commitRes.json()) as { sha: string };

  await ghFetch(
    `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(params.branch)}`,
    token,
    { method: "PATCH", body: { sha: newCommit.sha, force: false } },
  );
  return newCommit.sha;
}

export async function listBranches(
  owner: string,
  repo: string,
  token?: string,
): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await ghFetch(
      `/repos/${owner}/${repo}/branches?per_page=100&page=${page}`,
      token,
    );
    const json = (await res.json()) as Array<{ name: string }>;
    names.push(...json.map(b => b.name));
    if (json.length < 100) break;
  }
  return names;
}

/** Create a new branch ref pointing at `fromSha`. */
export async function createBranch(
  owner: string,
  repo: string,
  branch: string,
  fromSha: string,
  token?: string,
): Promise<void> {
  await ghFetch(`/repos/${owner}/${repo}/git/refs`, token, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: fromSha },
  });
}

/**
 * Delete a branch ref. Treats "already gone" (404/422) as success so cleanup
 * is idempotent; any other failure (e.g. protected branch, no permission) is
 * surfaced.
 */
export async function deleteBranch(
  owner: string,
  repo: string,
  branch: string,
  token?: string,
): Promise<void> {
  try {
    await ghFetch(
      `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      token,
      { method: "DELETE" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("GitHub 404") || message.includes("GitHub 422")) {
      return; // ref already deleted — nothing to do
    }
    throw error;
  }
}

/** Post a commit status (the GitHub "check" dot) on a SHA. context = "mako/ci". */
export async function postCommitStatus(
  owner: string,
  repo: string,
  sha: string,
  params: {
    state: "pending" | "success" | "failure" | "error";
    description: string;
    context?: string;
    targetUrl?: string;
  },
  token?: string,
): Promise<void> {
  await ghFetch(`/repos/${owner}/${repo}/statuses/${sha}`, token, {
    method: "POST",
    body: {
      state: params.state,
      description: params.description.slice(0, 140),
      context: params.context ?? "mako/ci",
      target_url: params.targetUrl,
    },
  });
}

/** Filenames changed by a pull request (paginated). */
export async function getPullRequestFiles(
  owner: string,
  repo: string,
  prNumber: number,
  token?: string,
): Promise<string[]> {
  const files: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await ghFetch(
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      token,
    );
    const json = (await res.json()) as Array<{ filename: string }>;
    files.push(...json.map(f => f.filename));
    if (json.length < 100) break;
  }
  return files;
}

export async function createPullRequest(
  owner: string,
  repo: string,
  params: { title: string; head: string; base: string; body?: string },
  token?: string,
): Promise<{ number: number; htmlUrl: string }> {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls`, token, {
    method: "POST",
    body: {
      title: params.title,
      head: params.head,
      base: params.base,
      body: params.body ?? "",
    },
  });
  const json = (await res.json()) as { number: number; html_url: string };
  return { number: json.number, htmlUrl: json.html_url };
}

export interface PullRequestInfo {
  number: number;
  headRef: string;
  baseRef: string;
  mergeable: boolean | null;
  state: string;
}

export async function getPullRequest(
  owner: string,
  repo: string,
  prNumber: number,
  token?: string,
): Promise<PullRequestInfo> {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, token);
  const json = (await res.json()) as {
    number: number;
    head: { ref: string };
    base: { ref: string };
    mergeable: boolean | null;
    state: string;
  };
  return {
    number: json.number,
    headRef: json.head.ref,
    baseRef: json.base.ref,
    mergeable: json.mergeable,
    state: json.state,
  };
}

export type MergeMethod = "merge" | "squash" | "rebase";

function parseGitHubErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) return parsed.message;
  } catch {
    // fall through
  }
  return body.slice(0, 500);
}

/** Merge a pull request. Surfaces GitHub's error message verbatim on failure. */
export async function mergePullRequest(
  owner: string,
  repo: string,
  prNumber: number,
  params: { mergeMethod: MergeMethod },
  token?: string,
): Promise<{ sha: string }> {
  const headers = authHeaders(token);
  headers["Content-Type"] = "application/json";
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ merge_method: params.mergeMethod }),
    },
  );
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(parseGitHubErrorMessage(bodyText));
  }
  const json = JSON.parse(bodyText) as { sha: string };
  return { sha: json.sha };
}

/**
 * Delete a branch ref. Returns whether the ref is gone and an optional warning
 * when deletion fails for a reason other than "already deleted".
 */
export async function tryDeleteBranch(
  owner: string,
  repo: string,
  branch: string,
  token?: string,
): Promise<{ deleted: boolean; warning?: string }> {
  try {
    await ghFetch(
      `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      token,
      { method: "DELETE" },
    );
    return { deleted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("GitHub 404") || message.includes("GitHub 422")) {
      return { deleted: true };
    }
    return { deleted: false, warning: message };
  }
}

/** Repos an App installation can access (requires an installation token). */
export async function listInstallationRepos(
  token: string,
): Promise<InstallationRepo[]> {
  const repos: InstallationRepo[] = [];
  let page = 1;
  // Paginate defensively; installations rarely exceed a few hundred repos.
  for (; page <= 10; page++) {
    const res = await ghFetch(
      `/installation/repositories?per_page=100&page=${page}`,
      token,
    );
    const json = (await res.json()) as {
      total_count: number;
      repositories: Array<{
        name: string;
        full_name: string;
        owner: { login: string };
        default_branch: string;
        private: boolean;
      }>;
    };
    for (const r of json.repositories) {
      repos.push({
        owner: r.owner.login,
        name: r.name,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        private: r.private,
      });
    }
    if (json.repositories.length < 100) break;
  }
  return repos;
}
