/**
 * Reading a deployment's files — build assets and data bindings — and
 * serving them to a signed-in viewer or a share.
 */
import path from "node:path";
import { Readable } from "node:stream";
import {
  getArtifactSourceStore,
  getArtifactStore,
  type ArtifactStore,
} from "../../services/artifact-store.service";
import {
  serveJsonArtifact,
  serveParquetArtifact,
} from "../../services/artifact-delivery.service";
import { snapshotArtifactKey } from "../../services/binding-snapshot";
import {
  bindingProgressResponse,
  parquetLinkOutcome,
  serverTimingHeader,
} from "../binding-progress";
import {
  bindingArtifactKeyByName,
  readBindingsTolerant,
} from "../bindings.service";
import {
  appsMetadataRepo,
  toAppProjectCompat,
} from "../../repositories/apps-metadata";
import { resolveAppViewer, type ViewerIdentity } from "../app-viewer.service";
import {
  deploymentKey,
  legacyDeploymentKey,
  artifactStoreForRead,
  contentTypeFor,
} from "./store";
import { DEPLOYMENT_BINDING_INDEX, deploymentBindingIndex } from "./bindings";

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
  const clean = assetPath.replace(/^\/+/, "") || "index.html";

  const candidates = [clean];
  if (!path.extname(clean)) candidates.push("index.html");

  for (const candidate of candidates) {
    const opened = await openDeploymentAsset(projectId, sha, candidate);
    if (opened) {
      return {
        stream: opened.stream,
        contentType: contentTypeFor(candidate),
        size: opened.size,
      };
    }
  }
  return null;
}

/**
 * Open one deployment file, searching the same keys and stores in the same
 * order as existingDeploymentAsset — but as ONE store call per place looked,
 * not three. On GCS the old exists() + openReadStream()'s own exists() +
 * getSize() were three sequential metadata round trips before the first byte
 * of every JS, CSS and HTML file of a published app.
 */
async function openDeploymentAsset(
  projectId: string,
  sha: string,
  assetPath: string,
): Promise<{ stream: NodeJS.ReadableStream; size: number | null } | null> {
  const source = getArtifactSourceStore();
  const stores = source ? [getArtifactStore(), source] : [getArtifactStore()];
  for (const key of [
    deploymentKey(projectId, sha, assetPath),
    legacyDeploymentKey(projectId, sha, assetPath),
  ]) {
    for (const store of stores) {
      const opened = await openStoredFile(store, key);
      if (opened) return opened;
    }
  }
  return null;
}

async function openStoredFile(
  store: ArtifactStore,
  key: string,
): Promise<{ stream: NodeJS.ReadableStream; size: number | null } | null> {
  if (store.openRead) return await store.openRead(key);
  if (!(await store.exists(key))) return null;
  const stream = await store.openReadStream(key);
  if (!stream) return null;
  return { stream, size: await store.getSize(key) };
}

/**
 * Serve one file of a published app: a build asset, or a materialized data
 * binding at `__data/<name>.parquet` (and its instant-open sibling
 * `__data/<name>.snapshot.json`).
 *
 * The only difference between the signed-in viewer and an anonymous share is
 * WHO is allowed to call it; what gets served is identical — except
 * `__data/viewer.json`, which tells the app who that is (apps.md §28) and
 * is `null` for an anonymous share. Keeping that in one place is what stops
 * the routes drifting into serving different things — which is exactly how
 * the viewer once ended up returning index.html for every asset while the
 * share route did not.
 */
export async function serveDeploymentFile(input: {
  projectId: string;
  sha: string;
  assetPath: string;
  /** Anonymous shares must not be cached by anything in between. */
  private?: boolean;
  /**
   * Who is asking, from the session or the signed token. Absent/null =
   * nobody known (anonymous share, a token minted before viewers existed).
   */
  viewer?: ViewerIdentity | null;
  /**
   * The client asked for phase events (`Accept: application/x-ndjson`):
   * answer a `__data/<name>.parquet` with resolving → signing → ready + the
   * signed URL instead of a 302 (binding-progress.ts).
   */
  progress?: boolean;
  /**
   * Epoch ms until which this URL's answer cannot change (app-origin.ts).
   * A deployment is immutable at its sha, so when the URL itself names the
   * sha and expires (a stable view token on an app's own origin), every
   * file except `viewer.json` may be cached until then.
   */
  immutableUntil?: number;
  /** Stable signed parquet redirects; see serveParquetArtifact. */
  stableData?: { windowMs: number };
  /** Optional workspace scope for per-workspace PG/Mongo rollout routing. */
  workspaceId?: string;
}): Promise<Response | null> {
  const { projectId, sha, assetPath, workspaceId } = input;
  const immutableFor = input.immutableUntil
    ? Math.floor((input.immutableUntil - Date.now()) / 1000)
    : 0;
  const cache =
    immutableFor > 0
      ? `private, max-age=${immutableFor}, immutable`
      : input.private
        ? "private, no-cache"
        : "no-cache";

  // Who the app is talking to — the SDK's useViewer(). Two small reads
  // (workspace, membership), only on this one request, never per asset.
  if (assetPath === "__data/viewer.json") {
    const projectRec = input.viewer
      ? await appsMetadataRepo.findProjectById(projectId, workspaceId)
      : null;
    const project = projectRec ? toAppProjectCompat(projectRec) : null;
    const viewer = project
      ? await resolveAppViewer(project, input.viewer)
      : null;
    return new Response(JSON.stringify(viewer), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": input.private ? "private, no-store" : "no-store",
      },
    });
  }

  // The staged-binding list the SDK's useDuckDB registers tables from. The
  // dev server writes this file next to its staged parquet; published serving
  // derives it from the repo's bindings so published apps get tables too.
  if (assetPath === "__data/index.json") {
    const index = await deploymentBindingIndex(projectId, sha);
    const projectRec = index
      ? null
      : await appsMetadataRepo.findProjectById(projectId, workspaceId);
    const project = projectRec ? toAppProjectCompat(projectRec) : null;
    // AT the deployed commit — see readSource's `at`. Tolerant, like the
    // per-binding data path: a malformed neighbour must not 500 the table
    // index that every healthy binding's registration depends on.
    const names = index
      ? Object.keys(index)
      : project
        ? (await readBindingsTolerant(project, "", sha)).bindings.map(
            b => b.name,
          )
        : [];
    return new Response(JSON.stringify(names), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": cache },
    });
  }

  const dataMatch = assetPath.match(
    /^__data\/([A-Za-z0-9_][A-Za-z0-9_-]*)\.(parquet|snapshot\.json)$/,
  );
  if (dataMatch) {
    // Resolve by name through the binding's DEFINITION, exactly as the
    // preview route does — artifacts are keyed
    // `apps/bindings/<connectionId>/<definitionHash>.parquet`. The old
    // `apps/<projectId>/<name>.parquet` key here was a scheme nothing
    // writes: published apps could never see their data (§13.19).
    // The deployment's binding index when it has one (no repository read);
    // a name it does not list is no healthy binding at this commit.
    if (dataMatch[2] === "snapshot.json") {
      // Only through the index: a snapshot is an optional preview, and the
      // 404 for an artifact without one must cost no repository read.
      const index = await deploymentBindingIndex(projectId, sha);
      const parquetKey =
        index && Object.hasOwn(index, dataMatch[1])
          ? index[dataMatch[1]]
          : null;
      if (!parquetKey) return null;
      const snapshotKey = snapshotArtifactKey(parquetKey);
      const store = await artifactStoreForRead(snapshotKey);
      if (!store) return null;
      return await serveJsonArtifact(store, snapshotKey, {
        cacheControl: input.private ? "private, no-store" : "no-store",
      });
    }
    const resolve = async () => {
      const index = await deploymentBindingIndex(projectId, sha);
      const projectRec = index
        ? null
        : await appsMetadataRepo.findProjectById(projectId, workspaceId);
      const project = projectRec ? toAppProjectCompat(projectRec) : null;
      const key = index
        ? Object.hasOwn(index, dataMatch[1])
          ? index[dataMatch[1]]
          : null
        : project
          ? await bindingArtifactKeyByName(project, dataMatch[1], "", sha)
          : null;
      if (!key) return null;
      const store = await artifactStoreForRead(key);
      return store ? { store, key } : null;
    };
    if (input.progress) {
      // The SDK (>= 2.7.4) takes its parquet URL from these events, so a
      // stable window must reach the signing here too, or an app on its own
      // origin would get a fresh URL (a cache miss) on every open.
      return bindingProgressResponse(() =>
        parquetLinkOutcome(dataMatch[1], resolve, input.stableData),
      );
    }
    const resolveStart = Date.now();
    const target = await resolve();
    if (!target) return null;
    return await serveParquetArtifact(target.store, target.key, {
      cacheControl: input.private ? "private, no-store" : "no-store",
      extraHeaders: {
        "Server-Timing": serverTimingHeader({
          resolve: Date.now() - resolveStart,
        }),
      },
      ...(input.stableData ? { stable: input.stableData } : {}),
    });
  }

  // Serving's own index, not part of the build: binding keys stay internal.
  if (assetPath === DEPLOYMENT_BINDING_INDEX) return null;

  const asset = await readDeploymentAsset(projectId, sha, assetPath);
  if (!asset) return null;
  return new Response(
    Readable.toWeb(asset.stream as Readable) as ReadableStream,
    {
      status: 200,
      headers: {
        "Content-Type": asset.contentType,
        ...(asset.size !== null
          ? { "Content-Length": String(asset.size) }
          : {}),
        "Cache-Control": cache,
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
