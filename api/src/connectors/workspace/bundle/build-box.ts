/**
 * The build box: where a connector folder becomes one `.mjs`.
 *
 * An E2B box with network (npm has to reach the registry) and no credentials:
 *
 * - every build gets a box of its own, keyed
 *   `connector-build:<workspaceId>:<buildId>`, and the box is destroyed when
 *   the build ends. A build never shares a disk with a sync box's credential
 *   files, with another workspace, or with an earlier build: nothing a build
 *   leaves behind (npm cache, bundler, a stray process) reaches the next one,
 *   and no box is held open after the build;
 * - nothing but the folder's files is written into it, copied in exactly as
 *   the sync box copies them. It never clones the repo, so it never gets the
 *   workspace's `mgt_` git token (RFC connectors-as-code §6.3);
 * - commands run with the provider's allowlisted environment and nothing
 *   added, so no Mako secret reaches `npm ci` or esbuild.
 *
 * `npm ci --ignore-scripts` installs exactly the lockfile, from the npm
 * registry only (the folder's lockfile is checked for that before a build, and
 * the registry is passed to npm), and runs no package lifecycle scripts.
 * `--allow-git/remote/file=none` refuses those fetches on an npm that knows
 * the flags; an older npm ignores them, and the lockfile check still holds.
 * The bundler is installed with `--ignore-scripts` too. esbuild bundles the
 * entry with every dependency inlined, except `@makoai/connector-sdk`, which
 * the sync runtime provides at the version the hash was computed with.
 */
import path from "node:path";
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "../../../apps/sandbox/provider";
import { loggers } from "../../../logging";
import { connectorRuntimeNodePath } from "../sync-box";
import { ensureConnectorRuntime } from "../resolver";
import { NPM_REGISTRY, NPMRC, SHRINKWRAP } from "./manifest";
import { BUNDLE_ESBUILD_VERSION } from "./source-hash";
import { MAX_BUNDLE_BYTES } from "./store";

const logger = loggers.connector();

/**
 * One build's box: never a sync box, never a session box, never another
 * build's box.
 */
export function buildBoxContext(
  workspaceId: string,
  buildId: string,
): SandboxExecContext {
  return { sessionKey: `connector-build:${workspaceId}:${buildId}` };
}

/** The bundle entry as an esbuild argument: a path, never a flag. */
export function esbuildEntryArg(entry: string): string {
  return entry.startsWith("./") ? entry : `./${entry}`;
}

const INSTALL_TOOLS_TIMEOUT_MS = 3 * 60 * 1000;
const INSTALL_DEPS_TIMEOUT_MS = 5 * 60 * 1000;
const BUNDLE_TIMEOUT_MS = 2 * 60 * 1000;

/** Lets a bundled CommonJS dependency `require` Node built-ins from ESM. */
const ESM_REQUIRE_BANNER =
  'import { createRequire as __makoCreateRequire } from "node:module"; const require = __makoCreateRequire(import.meta.url);';

const q = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export type BuildResult =
  { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

/** The tail of a failed command's output: where npm and esbuild say why. */
function tail(result: { stderr: string; stdout: string }): string {
  const text = (result.stderr || result.stdout).trim();
  return text.length > 2000 ? `…${text.slice(-2000)}` : text;
}

export async function buildBundleInBox(input: {
  workspaceId: string;
  slug: string;
  hash: string;
  entry: string;
  files: ReadonlyMap<string, Uint8Array>;
}): Promise<BuildResult> {
  const { workspaceId, slug, hash, entry, files } = input;
  const provider = getSandboxProvider();
  const buildId = `${hash.slice(0, 16)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = buildBoxContext(workspaceId, buildId);

  try {
    // The manifest check refuses these first; this is the last line.
    for (const refused of [NPMRC, SHRINKWRAP]) {
      if (files.has(refused)) {
        return {
          ok: false,
          reason: `Refusing to build: ${refused} is not allowed in a connector folder.`,
        };
      }
    }

    // The runtime root brings the pinned Node, and with it npm.
    const runtimeId = await ensureConnectorRuntime(ctx);
    const nodeBin = path.posix.dirname(
      connectorRuntimeNodePath(ctx, runtimeId),
    );
    const scratch = provider.scratch(ctx);
    const tools = path.posix.join(
      scratch,
      "connector-build-tools",
      `esbuild-${BUNDLE_ESBUILD_VERSION}`,
    );
    const cache = path.posix.join(scratch, "connector-build-cache", "npm");
    const buildDir = path.posix.join(scratch, "connector-builds", buildId);
    const srcDir = path.posix.join(buildDir, "src");
    const outFile = path.posix.join(buildDir, "out", "connector.mjs");
    // Settings npm would otherwise take from a user or global .npmrc are
    // pinned here: the registry and no user config. The global config is
    // the pinned Node tarball's own.
    const env = `export PATH=${q(nodeBin)}:"$PATH" npm_config_cache=${q(cache)} npm_config_registry=${q(NPM_REGISTRY)} npm_config_userconfig=/dev/null npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false`;

    for (const [relative, bytes] of files) {
      const target = path.posix.normalize(path.posix.join(srcDir, relative));
      if (!target.startsWith(`${srcDir}/`)) {
        return {
          ok: false,
          reason: `Refusing to build: ${relative} escapes the connector directory.`,
        };
      }
      await provider.writeFile(ctx, target, new Uint8Array(bytes));
    }

    // The bundler, pinned and installed in the build's box. Built in a
    // temporary directory and moved into place, so a killed install is never
    // mistaken for a complete one.
    const tools_ = await provider.exec(
      ctx,
      `set -eu
${env}
tools=${q(tools)}
if test -x "$tools/node_modules/.bin/esbuild"; then exit 0; fi
mkdir -p "$(dirname "$tools")"
tmp="$(mktemp -d "$tools.XXXXXX")"
npm install --prefix "$tmp" --no-save --no-package-lock --ignore-scripts --registry=${q(NPM_REGISTRY)} esbuild@${BUNDLE_ESBUILD_VERSION} >&2
test -e "$tools" || mv "$tmp" "$tools"
rm -rf "$tmp"
test -x "$tools/node_modules/.bin/esbuild"`,
      { timeoutMs: INSTALL_TOOLS_TIMEOUT_MS },
    );
    if (tools_.exitCode !== 0 || tools_.timedOut) {
      return {
        ok: false,
        reason: `Could not install the bundler: ${tools_.timedOut ? "timed out" : tail(tools_)}`,
      };
    }

    const install = await provider.exec(
      ctx,
      `set -eu
${env}
cd ${q(srcDir)}
npm ci --ignore-scripts --registry=${q(NPM_REGISTRY)} --allow-git=none --allow-remote=none --allow-file=none --no-audit --no-fund >&2`,
      { timeoutMs: INSTALL_DEPS_TIMEOUT_MS },
    );
    if (install.timedOut) {
      return { ok: false, reason: "npm ci timed out after 5 minutes." };
    }
    if (install.exitCode !== 0) {
      return { ok: false, reason: `npm ci failed: ${tail(install)}` };
    }

    const bundle = await provider.exec(
      ctx,
      `set -eu
${env}
cd ${q(srcDir)}
mkdir -p ${q(path.posix.dirname(outFile))}
${q(path.posix.join(tools, "node_modules", ".bin", "esbuild"))} ${q(esbuildEntryArg(entry))} --bundle --platform=node --format=esm --target=node22 --external:@makoai/connector-sdk --legal-comments=none --log-level=warning --banner:js=${q(ESM_REQUIRE_BANNER)} --outfile=${q(outFile)} >&2
wc -c < ${q(outFile)}`,
      { timeoutMs: BUNDLE_TIMEOUT_MS },
    );
    if (bundle.timedOut) {
      return { ok: false, reason: "esbuild timed out after 2 minutes." };
    }
    if (bundle.exitCode !== 0) {
      return { ok: false, reason: `esbuild failed: ${tail(bundle)}` };
    }
    // The size is measured in the box before a byte crosses into the API:
    // the box ran third-party install code, so its output is not trusted.
    const size = Number(bundle.stdout.trim().split("\n").pop());
    if (!Number.isSafeInteger(size) || size <= 0) {
      return { ok: false, reason: "esbuild produced no bundle." };
    }
    if (size > MAX_BUNDLE_BYTES) {
      return {
        ok: false,
        reason: `The bundle is ${size} bytes, over the ${MAX_BUNDLE_BYTES} byte limit. Drop large dependencies.`,
      };
    }
    const bytes = await provider.readFile(ctx, outFile);
    if (bytes.byteLength > MAX_BUNDLE_BYTES) {
      return {
        ok: false,
        reason: `The bundle exceeds the ${MAX_BUNDLE_BYTES} byte limit.`,
      };
    }
    logger.info("Built a workspace connector bundle", {
      workspaceId,
      slug,
      hash,
      bytes: bytes.byteLength,
    });
    return { ok: true, bytes };
  } finally {
    // The box is the build's alone: destroying it is the cleanup.
    await destroyBuildBox(ctx);
  }
}

async function destroyBuildBox(ctx: SandboxExecContext): Promise<void> {
  const provider = getSandboxProvider();
  try {
    if (provider.destroySession) {
      await provider.destroySession(ctx.sessionKey);
      return;
    }
    // A provider without sessions to destroy: remove what the build wrote.
    await provider.exec(
      ctx,
      `rm -rf ${q(path.posix.join(provider.scratch(ctx), "connector-builds"))}`,
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    logger.error("Failed to destroy a connector build box", {
      error,
      sessionKey: ctx.sessionKey,
    });
  }
}
