/**
 * Building an app in the publish box (install + build, one place) and
 * deploying the result.
 */
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { type IAppProject } from "../../database/workspace-schema";
import { markDeployStage } from "../deploy-progress";
import { loggers } from "../../logging";
import {
  PUBLISH_ACTOR,
  boxCtx,
  handleProject,
  type WorktreeHandle,
} from "../worktree.service";
import { readBoxDir } from "../box";
import { resolveAppEnv } from "../env.service";
import {
  INSTALL_IS_FRESH,
  installCommand,
  updateMakoPackagesCommand,
} from "../package-manager";
import { PublishResult, uploadDeployment } from "./store";
import { setPublishedSha } from "./pointer";
import { ensureDeploymentBindings } from "./bindings";

const logger = loggers.api("apps-deployment");

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
  // By app id: slugs are not unique per workspace once apps nest, and two
  // same-named apps building in the shared publish box would truncate and
  // interleave one log.
  return `/tmp/mako-build-${handleProject(handle)._id.toString()}.log`;
}

/** Percent of the box disk in use above which the publish box prunes. */
const PUBLISH_DISK_PRUNE_PERCENT = 80;

/**
 * Keep the publish box from filling its disk.
 *
 * The publish box builds every app in the workspace and keeps each one's
 * `node_modules` and `dist` so the next publish can skip the install. Nothing
 * ever removed them, so a workspace with several apps ended in "No space left
 * on device". Pruning only when the disk is nearly full keeps normal publishes
 * fast; it is safe because this box is write-free and `main` is the source of
 * truth — a pruned app just reinstalls on its next publish.
 *
 * Only the publish box: a user's box holds their running dev servers, and
 * deleting a sibling app's `node_modules` would break them.
 */
async function prunePublishBoxIfFull(
  handle: WorktreeHandle,
  exec: Parameters<typeof buildApp>[1],
): Promise<void> {
  if (handle.doc.userId !== PUBLISH_ACTOR) return;
  const script = [
    // Other apps = every node_modules/dist in the repo except this app's own.
    `top="$(git rev-parse --show-toplevel)"; here="$(pwd -P)"`,
    `used="$(df -P "$top" | awk 'NR==2 { gsub("%","",$5); print $5 }')"`,
    `[ "\${used:-0}" -ge ${PUBLISH_DISK_PRUNE_PERCENT} ] || exit 0`,
    `find "$top" -maxdepth 4 -type d \\( -name node_modules -o -name dist \\) -prune ! -path "$here/*" ! -path "$top/.git/*" -exec rm -rf {} + 2>/dev/null`,
    `rm -rf "$HOME/.npm/_cacache" "$HOME/.cache" /tmp/mako-build-*.log 2>/dev/null`,
    `echo pruned`,
  ].join("\n");
  const result = await exec(handle, script, { timeoutMs: 60_000 }).catch(
    () => undefined,
  );
  if (result?.stdout.includes("pruned")) {
    logger.warn("Publish box disk nearly full; pruned other apps' builds", {
      workspaceId: handle.doc.workspaceId.toString(),
    });
  }
}

/**
 * MiB of MemAvailable the publish box must have before a build starts. The box
 * has 2,079 MB; idle it uses about 330 MB, and one vite build peaks well under
 * the rest. Two builds run at once per workspace (apps-deploy.ts), so a build
 * that cannot find this much is starting into a box that will thrash.
 */
export const PUBLISH_BUILD_MIN_FREE_MB = 600;

/**
 * Age past which a build tool in the publish box is an orphan: longer than the
 * longest exec timeout (APPS_EXEC_MAX_TIMEOUT_MS, 10 min), so whatever
 * started it has given up on it.
 */
export const PUBLISH_ORPHAN_AGE_S = 15 * 60;

/** The publish box has too little free memory to start a build. */
export class PublishBoxLowMemoryError extends Error {
  constructor(readonly availableMb: number) {
    super(
      `The publish box has ${availableMb} MB of memory free; a build needs ${PUBLISH_BUILD_MIN_FREE_MB} MB. Retrying shortly.`,
    );
    this.name = "PublishBoxLowMemoryError";
  }
}

/**
 * Prints `avail <MiB>` after killing build tools (npm, pnpm, node running
 * vite/esbuild/rollup/tsc) older than PUBLISH_ORPHAN_AGE_S. Those outlived
 * every caller: an API instance that died mid-build never kills its tree.
 */
export const PUBLISH_BOX_MEMORY_SCRIPT = [
  `ps -eo pid=,etimes=,args= 2>/dev/null | awk -v max=${PUBLISH_ORPHAN_AGE_S} '$2 > max && $0 ~ /(^|[ \\/])(npm|pnpm|npx|vite|esbuild|rollup|tsc)( |$)/ { print $1 }' | while read -r p; do kill -KILL "$p" 2>/dev/null; done`,
  `awk '/^MemAvailable:/ { print "avail", int($2 / 1024) }' /proc/meminfo`,
].join("\n");

/** MemAvailable in MiB from PUBLISH_BOX_MEMORY_SCRIPT, or null if unreadable. */
export function parseAvailableMb(stdout: string): number | null {
  const match = /^avail (\d+)$/m.exec(stdout);
  return match ? Number(match[1]) : null;
}

/**
 * Never start a build in a publish box that is out of memory. On 18 Nov 2026
 * the box sat at 2,018 of 2,079 MB for 34 min, and 19 deploys each failed
 * with deadline_exceeded because envd could not start even a 15 s probe.
 * Reap orphaned build tools first; if memory is still short, throw a
 * retriable error instead of piling one more build onto the box.
 */
async function ensurePublishBoxMemory(
  handle: WorktreeHandle,
  exec: Parameters<typeof buildApp>[1],
): Promise<void> {
  if (handle.doc.userId !== PUBLISH_ACTOR) return;
  const result = await exec(handle, PUBLISH_BOX_MEMORY_SCRIPT, {
    timeoutMs: 30_000,
  });
  const availableMb = parseAvailableMb(result.stdout);
  if (availableMb === null || availableMb >= PUBLISH_BUILD_MIN_FREE_MB) return;
  logger.warn("Publish box low on memory; not starting a build", {
    workspaceId: handle.doc.workspaceId.toString(),
    availableMb,
  });
  throw new PublishBoxLowMemoryError(availableMb);
}

export async function buildApp(
  handle: WorktreeHandle,
  exec: (
    handle: WorktreeHandle,
    command: string,
    options: { timeoutMs: number; env?: Record<string, string> },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; output: string }> {
  await prunePublishBoxIfFull(handle, exec);
  await ensurePublishBoxMemory(handle, exec);
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
    // npm or pnpm, as the app's own lockfile says (package-manager.ts), in
    // its verbose form — the client is watching this log live.
    //
    // Freshness via OUR stamp, written only after a SUCCESSFUL install: npm
    // writes .package-lock.json early during reify, so a killed install left
    // a "fresh" stamp over a half-written tree (no vite binary) and every
    // later publish skipped the install forever. Stamp-after-success plus
    // rm -rf on miss makes the tree either complete or absent.
    `set -o pipefail; ( ${INSTALL_IS_FRESH} || (rm -rf node_modules && ${installCommand({ verbose: true })} && touch node_modules/.mako-installed) ) 2>&1 | tee -a ${log}`,
    { timeoutMs: 300_000 },
  );
  if (install.exitCode !== 0) {
    return {
      ok: false,
      output: `dependency install failed\n${(install.stdout + install.stderr).slice(-4000)}`,
    };
  }
  // Newest @makoai/* inside the app's declared range, on every build — also
  // when node_modules was fresh, or a published SDK fix would wait for the
  // app's next dependency change. Never fails the build (see the command).
  await exec(
    handle,
    `set -o pipefail; ( ${updateMakoPackagesCommand()} ) 2>&1 | tee -a ${log}`,
    { timeoutMs: 120_000 },
  ).catch(() => undefined);
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
  options: {
    bindingsReady?: boolean;
    /** Stale artifacts this release goes live on (see setPublishedSha). */
    refreshing?: string[];
    /** Repoint only if the live pointer is still this (see setPublishedSha). */
    expected?: string | null;
  } = {},
): Promise<PublishResult> {
  // The build output lives in the sandbox — it is not in git, and the API
  // host no longer keeps a copy of the working tree. Copy just `dist/` out,
  // deliberately narrowly: this is the one thing publishing needs that the
  // repository cannot provide.
  await markDeployStage(project, sha, "publishing");
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "mako-dist-"));
  try {
    await readBoxDir(boxCtx(handle), `${handle.appRoot}/dist`, staging);
    const result = await uploadDeployment(project, sha, staging);
    // Safe by default for every present and future caller. Existing release
    // paths can prepare bindings earlier to return a more specific error and
    // pass the proof here; a new caller that forgets still cannot publish a
    // frontend whose required data artifact is absent.
    const refreshing = options.bindingsReady
      ? options.refreshing
      : (await ensureDeploymentBindings(project, sha)).refreshing;
    const repointed = await setPublishedSha(project, sha, {
      expected: options.expected,
      refreshing,
    });
    return { ...result, repointed };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
