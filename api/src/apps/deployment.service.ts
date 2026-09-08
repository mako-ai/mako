/**
 * Apps publishing (apps.md §13.3).
 *
 * Publish = merge the branch into `main`, build from `main`, store the output
 * as an IMMUTABLE deployment keyed by commit sha, then repoint the app at it.
 *
 * Immutability is the whole design. Because every deployment keeps its own
 * prefix, rolling back is repointing `publishedSha` at an earlier sha — no
 * build, no sandbox, and no risk that "the last good version" has drifted.
 * It also means a deployment can be linked to by sha. The one thing a
 * rollback does prepare first is its DATA: a scheduled binding whose artifact
 * predates the schedule's latest occurrence is re-materialized before the
 * repoint (ensureDeploymentBindings), so an old sha never brings old numbers
 * back with it.
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
import { Readable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import {
  getArtifactSourceStore,
  getDashboardArtifactStore,
  type DashboardArtifactStore,
} from "../services/dashboard-artifact-store.service";
import { serveParquetArtifact } from "../services/artifact-delivery.service";
import {
  bindingArtifactKey,
  bindingArtifactKeyByName,
  materializeAppBinding,
  readBindingsTolerant,
  type AppBinding,
} from "./bindings.service";
import { isCronDue, nextCronRunAt } from "../services/cron-due";
import { AppProject, type IAppProject } from "../database/workspace-schema";
import { resolveAppViewer, type ViewerIdentity } from "./app-viewer.service";
import { loggers } from "../logging";
import {
  PUBLISH_ACTOR,
  boxCtx,
  handleProject,
  type WorktreeHandle,
} from "./worktree.service";
import { readBoxDir } from "./box";
import { resolveAppEnv } from "./env.service";

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
  store: DashboardArtifactStore;
  key: string;
}

/** The writable store first, then the optional read-only canonical source. */
async function artifactStoreForRead(
  key: string,
): Promise<DashboardArtifactStore | null> {
  const primary = getDashboardArtifactStore();
  if (await primary.exists(key)) return primary;
  const source = getArtifactSourceStore();
  if (source && (await source.exists(key))) return source;
  return null;
}

/** The store and key that actually hold `assetPath`, or null. */
async function existingDeploymentAsset(
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
  const store = getDashboardArtifactStore();

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

/** Point the app at a deployment. Also how rollback works. */
export async function setPublishedSha(
  project: IAppProject,
  sha: string,
): Promise<void> {
  await AppProject.updateOne(
    { _id: project._id },
    {
      $set: { publishedSha: sha, publishedAt: new Date() },
      $unset: { lastDeployError: 1 },
    },
  );
}

/**
 * Unpublish: the folder is gone from `main`, so nothing should serve. The
 * row stays (env vars, sharing, history); only the live pointer clears, and
 * with it the hourly reconcile's reason to keep re-enqueuing the app.
 */
export async function clearPublishedSha(project: IAppProject): Promise<void> {
  await AppProject.updateOne(
    { _id: project._id },
    { $unset: { publishedSha: 1, publishedAt: 1, lastDeployError: 1 } },
  );
}

const DEPLOY_ERROR_MAX_CHARS = 8_000;

/**
 * Remember why a deploy did not go live, on the row every status reader
 * already loads. Replaces shelling into the publish sandbox to append a
 * log line — which booted a box on the repoint path that needs none, and
 * wrote to a file the next build truncates anyway.
 */
export async function recordDeployFailure(
  project: IAppProject,
  sha: string,
  stage: "bindings" | "build" | "publish",
  error: unknown,
): Promise<void> {
  const full = error instanceof Error ? error.message : String(error);
  const message =
    full.length > DEPLOY_ERROR_MAX_CHARS
      ? `…${full.slice(-DEPLOY_ERROR_MAX_CHARS)}`
      : full;
  await AppProject.updateOne(
    { _id: project._id },
    { $set: { lastDeployError: { sha, stage, message, at: new Date() } } },
  ).catch(err => {
    logger.warn("Could not record apps deploy failure", {
      projectId: project._id.toString(),
      sha,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Whether a given sha's deployment still exists in the store. */
export async function deploymentExists(
  projectId: string,
  sha: string,
): Promise<boolean> {
  return (await existingDeploymentAsset(projectId, sha, "index.html")) !== null;
}

export interface DeploymentBindingReadiness {
  /** Parquet bindings that a published deployment must be able to serve. */
  required: string[];
  /** Bindings whose existing content-addressed artifact was reused. */
  reused: string[];
  /** Bindings materialized by this readiness check. */
  materialized: string[];
  /**
   * Files under bindings/ that are not servable (bad filename, no
   * connection). They do not block the release — their data URL 404s
   * exactly as it did before publish read bindings at all — but they are
   * reported so the log names the file to fix.
   */
  skipped: Array<{ path: string; error: string }>;
}

/**
 * Whether an artifact that already exists for `binding` may be served as-is.
 *
 * Content addressing answers "same query?", not "current data?". Scheduler
 * state is per binding NAME, so when a merge reverts a query to an earlier
 * text, the old text's artifact is still in the store (built before the
 * edit) while the scheduler believes it ran the binding this morning — it
 * did, for the other text. Reusing that artifact served day-old numbers for
 * a whole day (#992). A scheduled binding's artifact therefore counts only
 * if it is at least as fresh as the schedule's latest occurrence, judged by
 * the store's own write time: no state read, no warehouse query, and the
 * common case (built by this morning's sweep) still reuses. An unknown
 * write time is treated as stale — one extra warehouse query is the cheap
 * side of that mistake.
 *
 * The write time is the artifact's own, which is why it has the same scope
 * as the content-addressed key (another app, a branch build or the sweep may
 * all have written it). Two known limits: a binding on a sub-tick cron (every
 * 15 minutes) is almost always overdue at publish time, so a code-only
 * publish of such an app pays one warehouse query per such binding; and
 * adoptBindingArtifact (v1 → v2 migration) COPIES an old artifact, so its
 * write time is the adoption time until the scheduler's next tick rebuilds
 * it from the run it recorded at `builtAt`.
 */
async function isBindingArtifactCurrent(
  store: DashboardArtifactStore,
  key: string,
  binding: AppBinding,
  context: { projectId: string; sha: string; now: Date },
): Promise<boolean> {
  if (!binding.schedule) return true;
  const { projectId, sha, now } = context;
  // Validate the cron before paying the metadata round trip. The scheduler
  // skips a binding whose cron it cannot parse; publish treats it the same
  // way (effectively unscheduled) rather than failing the release.
  try {
    nextCronRunAt(binding.schedule, { timezone: binding.timezone, from: now });
  } catch (error) {
    logger.warn("Invalid binding schedule", {
      projectId,
      sha,
      binding: binding.name,
      schedule: binding.schedule,
      timezone: binding.timezone ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
  const builtAt = await store.getLastModified(key);
  if (
    builtAt &&
    !isCronDue({
      cron: binding.schedule,
      timezone: binding.timezone,
      lastRunAt: builtAt,
      now,
    })
  ) {
    return true;
  }
  logger.info("Apps deployment rebuilds stale binding artifact", {
    projectId,
    sha,
    binding: binding.name,
    key,
    storeType: store.type,
    schedule: binding.schedule,
    timezone: binding.timezone ?? null,
    builtAt: builtAt?.toISOString() ?? null,
    reason: builtAt ? "overdue" : "unknown-build-time",
  });
  return false;
}

/**
 * Make the data contract of a deployment ready before it becomes live.
 *
 * Binding definitions are read at the exact deployment commit, never from a
 * mutable worktree. Their artifacts are content-addressed, so an unchanged
 * query is a cheap existence check while a changed/new query is materialized
 * once — unless the binding is scheduled and the existing artifact predates
 * the schedule's latest occurrence (isBindingArtifactCurrent), in which case
 * it is rebuilt exactly like a missing one. A failure propagates to the
 * durable deploy job and, critically, the caller has not moved
 * `publishedSha` yet. That includes a scheduled binding whose query is
 * currently broken: once its artifact is overdue it blocks every publish
 * and rollback of the app (silent reuse of the old artifact IS #992) —
 * fix or unschedule the binding to release.
 */
export async function ensureDeploymentBindings(
  project: IAppProject,
  sha: string,
  options: {
    /** The moment freshness is judged against; injectable for tests. */
    now?: Date;
  } = {},
): Promise<DeploymentBindingReadiness> {
  const projectId = project._id.toString();
  const { bindings, skipped } = await readBindingsTolerant(
    project,
    PUBLISH_ACTOR,
    sha,
  );
  if (skipped.length > 0) {
    logger.warn("Apps deployment skips malformed bindings", {
      projectId,
      sha,
      skipped,
    });
  }
  const live = bindings.filter(binding => binding.materialization === "live");
  if (live.length > 0) {
    throw new Error(
      `Cannot publish live binding${live.length === 1 ? "" : "s"} ${live
        .map(binding => `"${binding.name}"`)
        .join(", ")}. Published apps require parquet materialization.`,
    );
  }

  const readiness: DeploymentBindingReadiness = {
    required: bindings.map(binding => binding.name),
    reused: [],
    materialized: [],
    skipped,
  };
  for (const binding of bindings) {
    const key = bindingArtifactKey(binding);
    const store = await artifactStoreForRead(key);
    // Judged per binding: an earlier binding's rebuild can take minutes, and
    // a schedule may have come due meanwhile.
    const now = options.now ?? new Date();
    if (
      store &&
      (await isBindingArtifactCurrent(store, key, binding, {
        projectId,
        sha,
        now,
      }))
    ) {
      readiness.reused.push(binding.name);
      continue;
    }
    await materializeAppBinding(project, binding.name, PUBLISH_ACTOR, {
      at: sha,
    });
    readiness.materialized.push(binding.name);
  }

  logger.info("Apps deployment bindings ready", {
    projectId,
    sha,
    required: readiness.required.length,
    reused: readiness.reused.length,
    materialized: readiness.materialized.length,
    skipped: readiness.skipped.length,
  });
  return readiness;
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
  const clean = assetPath.replace(/^\/+/, "") || "index.html";

  const candidates = [clean];
  if (!path.extname(clean)) candidates.push("index.html");

  for (const candidate of candidates) {
    const stored = await existingDeploymentAsset(projectId, sha, candidate);
    if (!stored) continue;
    const stream = await stored.store.openReadStream(stored.key);
    if (stream) {
      return {
        stream,
        contentType: contentTypeFor(candidate),
        size: await stored.store.getSize(stored.key),
      };
    }
  }
  return null;
}

/**
 * Install if needed and produce a production build in the app's sandbox.
 *
 * The single place that knows how an app is built. Publishing, deploy-on-push
 * and the preview all need exactly this, and having each keep its own copy is
 * how they drift — one gains a flag, another does not, and the thing you
 * previewed stops being the thing you shipped.
 *
 * `--base=./` because a deployment is always served under a path prefix
 * (`/live/`, `/api/share/<token>/app/`), never at a domain root.
 */
/**
 * The build's live log inside the sandbox. `buildApp` tees `npm install` and
 * `npm run build` into it (truncating first), so the client can tail it via
 * the `build/log` route and watch the build run — the same pattern the dev
 * boot log uses.
 */
export function buildLogPath(handle: WorktreeHandle): string {
  const project = handleProject(handle);
  const slug = project.slug || project._id.toString();
  return `/tmp/mako-build-${slug.replace(/[^A-Za-z0-9_-]/g, "-")}.log`;
}

export async function buildApp(
  handle: WorktreeHandle,
  exec: (
    handle: WorktreeHandle,
    command: string,
    options: { timeoutMs: number; env?: Record<string, string> },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; output: string }> {
  const log = buildLogPath(handle);
  // The app's NON-SECRET env vars (env.service): `vite build` inlines the
  // `VITE_*` ones into the bundle — which is the point, that class of key is
  // publishable — and the build target excludes secrets by construction, so
  // nothing secret can ever influence a published artifact.
  const env = await resolveAppEnv(handleProject(handle), "build");
  // Fresh log per build; `pipefail` so a failing step's exit code survives the
  // `tee`, and `2>&1 | tee` puts the whole stream both on the wire (for the
  // final payload) and in the file the client tails live.
  await exec(handle, `: > ${log}`, { timeoutMs: 15_000 }).catch(
    () => undefined,
  );
  const install = await exec(
    handle,
    // `--loglevel=http` so the install streams progress into the log (npm is
    // near-silent when its stdout is a pipe), and `--foreground-scripts` so
    // lifecycle-script output shows too — the client is watching this live.
    //
    // Freshness via OUR stamp, written only after a SUCCESSFUL install: npm
    // writes .package-lock.json early during reify, so a killed install left
    // a "fresh" stamp over a half-written tree (no vite binary) and every
    // later publish skipped the install forever. Stamp-after-success plus
    // rm -rf on miss makes the tree either complete or absent.
    `set -o pipefail; ( [ node_modules/.mako-installed -nt package.json ] || (rm -rf node_modules && npm install --no-audit --no-fund --loglevel=http --foreground-scripts && touch node_modules/.mako-installed) ) 2>&1 | tee -a ${log}`,
    { timeoutMs: 300_000 },
  );
  if (install.exitCode !== 0) {
    return {
      ok: false,
      output: `npm install failed\n${(install.stdout + install.stderr).slice(-4000)}`,
    };
  }
  const build = await exec(
    handle,
    `set -o pipefail; npm run build -- --base=./ 2>&1 | tee -a ${log}`,
    { timeoutMs: 300_000, env },
  );
  return {
    ok: build.exitCode === 0,
    output: `${(build.stdout + build.stderr).slice(-6000)}`,
  };
}

/**
 * Store a finished build as the deployment for `sha` and point the app at it.
 *
 * Deploying is exactly these two steps, and separating them from the build is
 * what lets `main` advance only after a build has succeeded (§13.3).
 */
export async function deployBuild(
  project: IAppProject,
  sha: string,
  handle: WorktreeHandle,
  options: { bindingsReady?: boolean } = {},
): Promise<PublishResult> {
  // The build output lives in the sandbox — it is not in git, and the API
  // host no longer keeps a copy of the working tree. Copy just `dist/` out,
  // deliberately narrowly: this is the one thing publishing needs that the
  // repository cannot provide.
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "mako-dist-"));
  try {
    await readBoxDir(boxCtx(handle), `${handle.appRoot}/dist`, staging);
    const result = await uploadDeployment(project, sha, staging);
    // Safe by default for every present and future caller. Existing release
    // paths can prepare bindings earlier to return a more specific error and
    // pass the proof here; a new caller that forgets still cannot publish a
    // frontend whose required data artifact is absent.
    if (!options.bindingsReady) {
      await ensureDeploymentBindings(project, sha);
    }
    await setPublishedSha(project, sha);
    return result;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/**
 * Serve one file of a published app: a build asset, or a materialized data
 * binding at `__data/<name>.parquet`.
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
}): Promise<Response | null> {
  const { projectId, sha, assetPath } = input;
  const cache = input.private ? "private, no-cache" : "no-cache";

  // Who the app is talking to — the SDK's useViewer(). Two small reads
  // (workspace, membership), only on this one request, never per asset.
  if (assetPath === "__data/viewer.json") {
    const project = input.viewer ? await AppProject.findById(projectId) : null;
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
    const project = await AppProject.findById(projectId);
    // AT the deployed commit — see readSource's `at`. Tolerant, like the
    // per-binding data path: a malformed neighbour must not 500 the table
    // index that every healthy binding's registration depends on.
    const names = project
      ? (await readBindingsTolerant(project, "", sha)).bindings.map(b => b.name)
      : [];
    return new Response(JSON.stringify(names), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": cache },
    });
  }

  const dataMatch = assetPath.match(
    /^__data\/([A-Za-z0-9_][A-Za-z0-9_-]*)\.parquet$/,
  );
  if (dataMatch) {
    // Resolve by name through the binding's DEFINITION, exactly as the
    // preview route does — artifacts are keyed
    // `apps/bindings/<connectionId>/<definitionHash>.parquet`. The old
    // `apps/<projectId>/<name>.parquet` key here was a scheme nothing
    // writes: published apps could never see their data (§13.19).
    const project = await AppProject.findById(projectId);
    const key = project
      ? await bindingArtifactKeyByName(project, dataMatch[1], "", sha)
      : null;
    if (!key) return null;
    const store = await artifactStoreForRead(key);
    if (!store) return null;
    return await serveParquetArtifact(store, key, {
      cacheControl: input.private ? "private, no-store" : "no-store",
    });
  }

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
