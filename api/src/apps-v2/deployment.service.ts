/**
 * Apps v2 publishing (apps-v2.md §13.3).
 *
 * Publish = merge the branch into `main`, build from `main`, store the output
 * as an IMMUTABLE deployment keyed by commit sha, then repoint the app at it.
 *
 * Immutability is the whole design. Because every deployment keeps its own
 * prefix, rolling back is repointing `publishedSha` at an earlier sha — no
 * rebuild, no sandbox, and no risk that "the last good version" has drifted.
 * It also means a deployment can be linked to by sha.
 *
 * Deployments live in the same artifact store as dashboards and bindings (GCS
 * in deployed environments), so they survive API restarts and are shared
 * across instances — unlike the developer preview, whose token lives in one
 * process's memory for thirty minutes.
 *
 * Serving a deployment never touches a sandbox. That is what lets a hundred
 * viewers open an app without a hundred microVMs booting (§13.2).
 */
import path from "node:path";
import fs from "node:fs/promises";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import { AppProjectV2, type IAppProjectV2 } from "../database/workspace-schema";
import { loggers } from "../logging";
import type { WorktreeHandle } from "./worktree.service";

const logger = loggers.api("apps-v2-deployment");

/** Deployments are addressed by sha, never overwritten. */
export function deploymentKey(
  projectId: string,
  sha: string,
  assetPath: string,
): string {
  return `apps-v2/${projectId}/deployments/${sha}/${assetPath}`;
}

/** Content types for what a Vite build actually emits. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

export function contentTypeFor(assetPath: string): string {
  return (
    CONTENT_TYPES[path.extname(assetPath).toLowerCase()] ??
    "application/octet-stream"
  );
}

/** Every file under `dir`, as paths relative to it (posix separators). */
async function walkFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
    // Symlinks and other node types are skipped: a build should not emit them,
    // and following one out of dist/ would publish something else entirely.
  }
  return out;
}

export interface PublishResult {
  sha: string;
  fileCount: number;
  /** True when this sha was already deployed and the upload was skipped. */
  reused: boolean;
}

/**
 * Upload an already-built `dist/` as the deployment for `sha`.
 *
 * Idempotent by sha: re-publishing an unchanged commit re-points at the
 * existing deployment instead of uploading it again.
 */
export async function uploadDeployment(
  project: IAppProjectV2,
  sha: string,
  distDir: string,
): Promise<PublishResult> {
  const projectId = project._id.toString();
  const store = getDashboardArtifactStore();

  // index.html is the marker: if it is already there, this sha is deployed.
  if (await store.exists(deploymentKey(projectId, sha, "index.html"))) {
    logger.info("Apps v2 deployment already present; reusing", {
      projectId,
      sha,
    });
    return { sha, fileCount: 0, reused: true };
  }

  const files = await walkFiles(distDir);
  if (!files.includes("index.html")) {
    throw new Error(
      "Build output has no index.html — nothing to publish. Check that `npm run build` emits dist/index.html.",
    );
  }

  for (const rel of files) {
    await store.put(
      path.join(distDir, rel),
      deploymentKey(projectId, sha, rel),
      {
        contentType: contentTypeFor(rel),
        projectId,
        sha,
      },
    );
  }

  logger.info("Apps v2 deployment uploaded", {
    projectId,
    sha,
    fileCount: files.length,
  });
  return { sha, fileCount: files.length, reused: false };
}

/** Point the app at a deployment. Also how rollback works. */
export async function setPublishedSha(
  project: IAppProjectV2,
  sha: string,
): Promise<void> {
  await AppProjectV2.updateOne(
    { _id: project._id },
    { $set: { publishedSha: sha, publishedAt: new Date() } },
  );
}

/** Whether a given sha's deployment still exists in the store. */
export async function deploymentExists(
  projectId: string,
  sha: string,
): Promise<boolean> {
  return getDashboardArtifactStore().exists(
    deploymentKey(projectId, sha, "index.html"),
  );
}

export interface DeploymentAsset {
  stream: NodeJS.ReadableStream;
  contentType: string;
  size: number | null;
}

/**
 * Read one file out of a published deployment.
 *
 * A single-page app owns its routing, so an unknown path that does not look
 * like a file falls back to index.html — otherwise a deep link or a refresh on
 * a client-side route 404s.
 */
export async function readDeploymentAsset(
  projectId: string,
  sha: string,
  assetPath: string,
): Promise<DeploymentAsset | null> {
  const store = getDashboardArtifactStore();
  const clean = assetPath.replace(/^\/+/, "") || "index.html";

  const candidates = [clean];
  if (!path.extname(clean)) candidates.push("index.html");

  for (const candidate of candidates) {
    const key = deploymentKey(projectId, sha, candidate);
    const stream = await store.openReadStream(key);
    if (stream) {
      return {
        stream,
        contentType: contentTypeFor(candidate),
        size: await store.getSize(key),
      };
    }
  }
  return null;
}

/**
 * Build the app from a checked-out worktree and publish it.
 *
 * The caller is responsible for having merged to `main` and for the worktree
 * being on the commit identified by `sha` — this function does the build,
 * the upload, and the repoint.
 */
export async function publishFromWorktree(
  handle: WorktreeHandle,
  sha: string,
  runBuild: () => Promise<{ ok: boolean; output: string }>,
): Promise<PublishResult> {
  const projectId = handle.project._id.toString();

  if (await deploymentExists(projectId, sha)) {
    await setPublishedSha(handle.project, sha);
    return { sha, fileCount: 0, reused: true };
  }

  const build = await runBuild();
  if (!build.ok) {
    // Deliberately does NOT touch publishedSha: a failed build must leave the
    // previous deployment serving (§13.4.3).
    throw new Error(
      `Build failed, previous deployment left in place:\n${build.output}`,
    );
  }

  const distDir = path.join(handle.sessionDir, handle.appRoot, "dist");
  const result = await uploadDeployment(handle.project, sha, distDir);
  await setPublishedSha(handle.project, sha);
  return result;
}
