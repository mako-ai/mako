/**
 * Where deployments live: keys by sha, the writable store and its read-only
 * canonical source, content types, and uploading a build.
 */
import path from "node:path";
import fs from "node:fs/promises";
import {
  getArtifactSourceStore,
  getArtifactStore,
  type ArtifactStore,
} from "../../services/artifact-store.service";
import { type IAppProject } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { deploymentExists } from "./pointer";

const logger = loggers.api("apps-deployment");

/** Deployments are addressed by sha, never overwritten. */
export function deploymentKey(
  projectId: string,
  sha: string,
  assetPath: string,
): string {
  return `apps/${projectId}/deployments/${sha}/${assetPath}`;
}

/**
 * Where deployments lived before the `apps-v2 → apps` rename (#820). The
 * rename changed this prefix but not the objects already in the store, so
 * every app published before it vanished behind "Not found" in production.
 * Reads fall back to the old key; writes only ever use the new one. Keep
 * until every store's `apps-v2/` prefix has been copied under `apps/`.
 */
export function legacyDeploymentKey(
  projectId: string,
  sha: string,
  assetPath: string,
): string {
  return `apps-v2/${projectId}/deployments/${sha}/${assetPath}`;
}

interface StoredDeploymentAsset {
  store: ArtifactStore;
  key: string;
}

/** The writable store first, then the optional read-only canonical source. */
export async function artifactStoreForRead(
  key: string,
): Promise<ArtifactStore | null> {
  const primary = getArtifactStore();
  if (await primary.exists(key)) return primary;
  const source = getArtifactSourceStore();
  if (source && (await source.exists(key))) return source;
  return null;
}

/** The store and key that actually hold `assetPath`, or null. */
export async function existingDeploymentAsset(
  projectId: string,
  sha: string,
  assetPath: string,
): Promise<StoredDeploymentAsset | null> {
  // Rehearsal environments use a cloned production database but an isolated
  // writable artifact bucket. Their publishedSha therefore names a deployment
  // that may only exist in the canonical source bucket. Reads fall back there;
  // uploads still use `primary`, so a PR preview can never overwrite prod.
  for (const key of [
    deploymentKey(projectId, sha, assetPath),
    legacyDeploymentKey(projectId, sha, assetPath),
  ]) {
    const store = await artifactStoreForRead(key);
    if (store) return { store, key };
  }
  return null;
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
  /** False when a conditional repoint lost: the live pointer had moved. */
  repointed?: boolean;
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
  project: IAppProject,
  sha: string,
  distDir: string,
): Promise<PublishResult> {
  const projectId = project._id.toString();
  const store = getArtifactStore();

  // index.html is the marker: if it is already there, this sha is deployed.
  if (await deploymentExists(projectId, sha)) {
    logger.info("Apps deployment already present; reusing", {
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

  logger.info("Apps deployment uploaded", {
    projectId,
    sha,
    fileCount: files.length,
  });
  return { sha, fileCount: files.length, reused: false };
}
