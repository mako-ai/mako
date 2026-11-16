/**
 * The build box: where a connector folder becomes one `.mjs`.
 *
 * An E2B box with network (npm has to reach the registry) and no credentials:
 *
 * - it is keyed `connector-build:<workspaceId>`, never the sync box, so a
 *   build never shares a disk with a run's per-run credential files;
 * - nothing but the folder's files is written into it, copied in exactly as
 *   the sync box copies them. It never clones the repo, so it never gets the
 *   workspace's `mgt_` git token (RFC connectors-as-code §6.3);
 * - commands run with the provider's allowlisted environment and nothing
 *   added, so no Mako secret reaches `npm ci` or esbuild.
 *
 * `npm ci --ignore-scripts` installs exactly the lockfile and runs no package
 * lifecycle scripts. esbuild bundles the entry with every dependency inlined,
 * except `@makoai/connector-sdk`, which the sync runtime provides at the
 * version the hash was computed with.
 */
import path from "node:path";
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "../../../apps/sandbox/provider";
import { loggers } from "../../../logging";
import { connectorRuntimeNodePath } from "../sync-box";
import { ensureConnectorRuntime } from "../resolver";
import { BUNDLE_ESBUILD_VERSION } from "./source-hash";
import { MAX_BUNDLE_BYTES } from "./store";

const logger = loggers.connector();

/** The build box's affinity key: never a sync box, never a session box. */
export function buildBoxContext(workspaceId: string): SandboxExecContext {
  return { sessionKey: `connector-build:${workspaceId}` };
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
  const ctx = buildBoxContext(workspaceId);

  // The runtime root brings the pinned Node, and with it npm.
  const runtimeId = await ensureConnectorRuntime(ctx);
  const nodeBin = path.posix.dirname(connectorRuntimeNodePath(ctx, runtimeId));
  const scratch = provider.scratch(ctx);
  const tools = path.posix.join(
    scratch,
    "connector-build-tools",
    `esbuild-${BUNDLE_ESBUILD_VERSION}`,
  );
  const cache = path.posix.join(scratch, "connector-build-cache", "npm");
  const buildId = `${hash.slice(0, 16)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const buildDir = path.posix.join(scratch, "connector-builds", buildId);
  const srcDir = path.posix.join(buildDir, "src");
  const outFile = path.posix.join(buildDir, "out", "connector.mjs");
  const env = `export PATH=${q(nodeBin)}:"$PATH" npm_config_cache=${q(cache)} npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false`;

  try {
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

    // The bundler, pinned and installed once per box. Built in a temporary
    // directory and moved into place, so a concurrent or killed install is
    // never mistaken for a complete one.
    const tools_ = await provider.exec(
      ctx,
      `set -eu
${env}
tools=${q(tools)}
if test -x "$tools/node_modules/.bin/esbuild"; then exit 0; fi
mkdir -p "$(dirname "$tools")"
tmp="$(mktemp -d "$tools.XXXXXX")"
npm install --prefix "$tmp" --no-save --no-package-lock esbuild@${BUNDLE_ESBUILD_VERSION} >&2
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
npm ci --ignore-scripts --no-audit --no-fund >&2`,
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
${q(path.posix.join(tools, "node_modules", ".bin", "esbuild"))} ${q(entry)} --bundle --platform=node --format=esm --target=node22 --external:@makoai/connector-sdk --legal-comments=none --log-level=warning --banner:js=${q(ESM_REQUIRE_BANNER)} --outfile=${q(outFile)} >&2
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
    await provider
      .exec(ctx, `rm -rf ${q(buildDir)}`, { timeoutMs: 30_000 })
      .catch(error =>
        logger.error("Failed to clean a connector build directory", {
          error,
          buildDir,
        }),
      );
  }
}
