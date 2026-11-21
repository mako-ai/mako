/**
 * The sync box: where a workspace's connector code actually runs.
 *
 * One sandbox per workspace, separate from anyone's session box, holding
 * nothing but a copy of the connector folder and the SDK. Three properties
 * matter and each is enforced here rather than documented:
 *
 * 1. THE SYNC BOX NEVER CLONES THE REPO. A box that is given a git remote also
 *    gets a workspace-scoped `mgt_` token in a file (apps/box.ts), and that
 *    token can push to the workspace repo — which holds the apps, the flows,
 *    the dbt models and every other connector. Cloning would silently turn
 *    "runs tenant connector code" into "can rewrite the workspace". The folder
 *    is copied in instead, so the box holds no Mako token at all.
 * 2. A CREDENTIAL LIVES ONLY AS LONG AS THE COMMAND, AND ONLY ITS RUN CAN READ
 *    IT. It is written to a per-run directory and deleted in a `finally`,
 *    because an E2B box that pauses snapshots its disk. On E2B every run also
 *    gets its own Unix user and a 0700 directory owned by that user, so two
 *    runs sharing a box cannot read each other's credential files, and the
 *    runtime they execute is owned by root, so no run can plant code for the
 *    next one. See `runIsolated` and run-isolation.ts.
 * 3. NOTHING BUT A BOUNDED PROTOCOL COMES BACK. stdout is redirected to a file
 *    because `exec`'s output cap would truncate legitimate records. A bounded
 *    snapshot is made before that file crosses into the API process, so tenant
 *    code still cannot turn a large batch into an API heap exhaustion.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  abandonScript,
  CHUNK_MARKER,
  chunkScript,
  CLEANUP_SURVIVORS_EXIT,
  CONNECTOR_RUN_MIN_FREE_MB,
  HIDEPID_MARKER,
  incomingPath,
  ISOLATED_ROOT,
  ISOLATED_RUNTIME,
  lowMemoryMb,
  prepareBoxScript,
  resultPath,
  runLayout,
  shellQuote,
  type RunLayout,
} from "./run-isolation";
import path from "node:path";
import {
  getSandboxProvider,
  isSandboxGone,
  type SandboxExecContext,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxFileOptions,
} from "../../apps/sandbox/provider";
import { BoxLowMemoryError } from "../../apps/sandbox/box-memory";
import {
  assertLaunchDeadline,
  LaunchDeadlineError,
} from "../../apps/sandbox/launch-deadline";
import { loggers } from "../../logging";

const logger = loggers.connector();

/** Hidepid reports, by category so Cloud Logging can count them. */
const boxLogger = loggers.api("connector-box");

/** What a command's output said about hidepid on its box. */
export type HidepidReport = "off" | "off-capable";

/** The `MAKO_HIDEPID` line of a command's output, if any. */
export function hidepidReport(stdout: string): HidepidReport | null {
  const line = stdout
    .split("\n")
    .map(l => l.trim())
    .find(l => l.startsWith(`${HIDEPID_MARKER} off`));
  if (!line) return null;
  return line === `${HIDEPID_MARKER} off capable` ? "off-capable" : "off";
}

/**
 * A command's output said its box has no hidepid on /proc: other runs there
 * can read its argv. Logged on every run with `hidepidOff: true`, so Cloud
 * Logging counts them. An error when root could have remounted /proc: a
 * template or kernel change turned the protection off.
 */
export function noteHidepidOff(
  stdout: string,
  ctx: SandboxExecContext,
  box: string | undefined,
  what: "chunk" | "session",
): HidepidReport | null {
  const report = hidepidReport(stdout);
  if (!report) return null;
  const fields = {
    hidepidOff: true,
    capable: report === "off-capable",
    sandboxId: box,
    sessionKey: ctx.sessionKey,
    what,
  };
  if (report === "off-capable") {
    boxLogger.error(
      "Connector box has no hidepid on /proc although root could remount it: other runs can read every argv",
      fields,
    );
  } else {
    boxLogger.warn(
      "Connector box runs without hidepid on /proc: other runs can read every argv",
      fields,
    );
  }
  return report;
}

/** One command's worth of the protocol. */
export interface ProtocolMessage {
  type: string;
  [key: string]: unknown;
}

export interface RunResult {
  exitCode: number;
  messages: ProtocolMessage[];
  /** Lines that were not valid JSON. Never silently dropped. */
  malformed: string[];
  stderr: string;
  timedOut: boolean;
}

export type ConnectorCommand =
  | "spec"
  | "check"
  | "discover"
  | "read"
  // A batch of stored, verified webhook events (webhook-batch.ts).
  | "webhook";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** A protocol chunk may be large, but it may never be unbounded. */
export const MAX_CONNECTOR_PROTOCOL_BYTES = 32 * 1024 * 1024;
export const MAX_CONNECTOR_PROTOCOL_MESSAGES = 50_000;

/**
 * A chunk's protocol output passed MAX_CONNECTOR_PROTOCOL_BYTES or
 * MAX_CONNECTOR_PROTOCOL_MESSAGES. Typed, because the same chunk retried with
 * the same budget fails the same way: the caller has to ask for less.
 */
export class ConnectorOutputTooLargeError extends Error {
  constructor(
    message: string,
    readonly limit: "bytes" | "messages",
  ) {
    super(message);
    this.name = "ConnectorOutputTooLargeError";
  }
}

/** The line the bounding step prints: the bounded file's size, or `missing`. */
const BOUNDED_MARKER = "MAKO_BOUNDED_OUTPUT";

/**
 * The sandbox template is not the connector runtime. Templates in the wild
 * can lag (the current E2B image has Node 20), so the content-addressed
 * runtime carries a pinned Node that can import TypeScript connectors.
 */
export const CONNECTOR_NODE_VERSION = "24.22.1";
const CONNECTOR_NODE_SHA256 = {
  arm64: "dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e",
  x64: "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6",
} as const;

/**
 * The sync box's affinity key.
 *
 * Prefixed so it can never collide with a session box's key, which is a
 * worktree id: a connector must not land in the box someone is editing an app
 * in, where the repo — and its token — are checked out.
 */
export function syncBoxContext(workspaceId: string): SandboxExecContext {
  // v2: boxes made before per-run users ran connectors as `user`, who has
  // passwordless sudo in the template, and they pause with memory. A process
  // a connector left in one could become root, so those boxes are never
  // reused: the key moved, and `retireLegacySyncBox` kills the old box.
  return { sessionKey: `connector-sync:v2:${workspaceId}` };
}

/** The pre-isolation key. Only ever used to kill that box. */
export function legacySyncBoxKey(workspaceId: string): string {
  return `connector-sync:${workspaceId}`;
}

const legacyRetired = new Map<string, Promise<void>>();

/**
 * Kill the workspace's pre-isolation sync box, once per process.
 *
 * Runs before the first command in the new box. A failure is retried on the
 * next command rather than ignored, because a surviving legacy box is a
 * standing root shell for whatever a pre-fix connector left running in it.
 */
export async function retireLegacySyncBox(workspaceId: string): Promise<void> {
  const provider = getSandboxProvider();
  if (!provider.supportsRunUsers || !provider.destroySession) return;
  let pending = legacyRetired.get(workspaceId);
  if (!pending) {
    pending = provider
      .destroySession(legacySyncBoxKey(workspaceId))
      .catch(error => {
        legacyRetired.delete(workspaceId);
        logger.warn("Could not retire a pre-isolation sync box", {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    legacyRetired.set(workspaceId, pending);
  }
  await pending;
}

/** Where a connector's copied folder lives, keyed so a new sha is a new dir. */
export function connectorDir(
  ctx: SandboxExecContext,
  runtimeId: string,
  slug: string,
  sourceSha: string,
): string {
  return path.posix.join(
    runtimeRoot(ctx, runtimeId),
    "connectors",
    `${slug}@${sourceSha}`,
  );
}

/**
 * A content-addressed runtime root.
 *
 * A rolling API deployment can have two SDK versions using one workspace box
 * concurrently. Giving each SDK its own root prevents either process from
 * replacing files underneath the other, while connector imports still resolve
 * through the root's node_modules directory.
 */
function runtimeRoot(ctx: SandboxExecContext, runtimeId: string): string {
  // Isolated boxes keep the runtime under /var/lib, a root-only parent. Under
  // /tmp a connector or a stray process could pre-create or symlink a parent
  // directory before root writes into it.
  if (runsIsolated()) {
    return path.posix.join(ISOLATED_RUNTIME, "versions", runtimeId);
  }
  return path.posix.join(
    getSandboxProvider().scratch(ctx),
    "connector-runtime",
    "versions",
    runtimeId,
  );
}

/**
 * Does this box give each run its own Unix user?
 *
 * True on E2B. Then every file the API writes into the box is written as
 * root (so connector code, which never runs as root or as the template user,
 * cannot modify the runtime or another connector's folder), and every run
 * drops to a fresh Unix user that owns a 0700 run directory. The local
 * provider is one user on a developer machine, never production, and keeps
 * the original behaviour.
 */
function runsIsolated(): boolean {
  return getSandboxProvider().supportsRunUsers === true;
}

/** File options for the API's own writes into the sync box. */
function boxOwner(): { asRoot: true } | undefined {
  return runsIsolated() ? { asRoot: true } : undefined;
}

function execOptions(
  options: Omit<SandboxExecOptions, "asRoot">,
): SandboxExecOptions {
  return { ...options, ...boxOwner() };
}

function runtimeNode(ctx: SandboxExecContext, runtimeId: string): string {
  return path.posix.join(runtimeRoot(ctx, runtimeId), "node", "bin", "node");
}

/** Lists every file's sha256 in a materialized connector or bundle folder. */
export const TREE_MANIFEST = ".files-sha256";

/**
 * Shell lines that define `verify_tree <dir> <id>`: the marker names `id` and
 * every file in the folder's manifest matches its sha256.
 *
 * A marker alone is not proof. On 2026-11-18 at 13:40 UTC a box held
 * `connectors/close@9436ddc2/.materialized` without `connector.ts`, and
 * every ws:close run failed for 26 minutes.
 */
export function verifyTreeShell(): string {
  return `sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --status "$1" >/dev/null 2>&1; else shasum -a 256 -c --status "$1" >/dev/null 2>&1; fi
}
verify_tree() {
  test -f "$1/.materialized" || return 1
  grep -Fqx "$2" "$1/.materialized" || return 1
  test -f "$1/${TREE_MANIFEST}" || return 1
  if test -n "\${3:-}"; then
    printf '%s\\n' "$3" | cmp -s - "$1/${TREE_MANIFEST}" || return 1
  fi
  (cd "$1" && sha256_check ${TREE_MANIFEST}) || return 1
}`;
}

/**
 * Put a folder of files at `dir` in the box, atomically, once per `id`.
 *
 * The check verifies the marker and every file's hash, so a folder left
 * half-written (by a box swap mid-copy, or by an older API) is rewritten.
 * A miss writes into a private staging folder pinned to the box the check
 * ran in, verifies it there, and swaps it in under a lock. A box swap fails
 * the write instead of finishing it in another box.
 */
async function installVerifiedTree(input: {
  ctx: SandboxExecContext;
  dir: string;
  id: string;
  what: string;
  files: () => Promise<Map<string, Uint8Array>>;
  /** One trusted manifest line for bundles whose bytes are pinned externally. */
  expectedManifestLine?: string;
  /** Parents to open for traversal by run users, on isolated boxes. */
  parents: string[];
}): Promise<void> {
  const { ctx, dir, id, what } = input;
  const expected = shellQuote(input.expectedManifestLine ?? "");
  const provider = getSandboxProvider();
  const check = await provider.exec(
    ctx,
    `${verifyTreeShell()}
verify_tree ${shellQuote(dir)} ${shellQuote(id)} ${expected} && echo yes || echo no`,
    execOptions({ timeoutMs: 30_000 }),
  );
  if (check.stdout.trim() === "yes") return;
  const pin = check.sandboxId ? { expectSandboxId: check.sandboxId } : {};

  const files = await input.files();
  const stage = `${dir}.staging-${randomBytes(6).toString("hex")}`;
  const staged: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const [relative, bytes] of files) {
    // A path from the repo tree must not escape the directory it is being
    // written into. Nothing in a normal connector folder ever contains "..",
    // so this only ever fires on something built to escape.
    const target = path.posix.normalize(path.posix.join(stage, relative));
    if (!target.startsWith(`${stage}/`)) {
      throw new Error(
        `Refusing to write ${relative}: it escapes the connector directory`,
      );
    }
    staged.push({ path: target, bytes });
  }
  staged.push({
    path: path.posix.join(stage, TREE_MANIFEST),
    bytes: new TextEncoder().encode(treeManifest(files)),
  });
  const fileOptions: SandboxFileOptions = { ...boxOwner(), ...pin };
  if (provider.writeFiles) {
    await provider.writeFiles(ctx, staged, fileOptions);
  } else {
    for (const file of staged) {
      await provider.writeFile(ctx, file.path, file.bytes, fileOptions);
    }
  }

  const swap = await provider.exec(
    ctx,
    `set -eu
dir=${shellQuote(dir)}
stage=${shellQuote(stage)}
id=${shellQuote(id)}
trap 'rm -rf "$stage"' EXIT
${verifyTreeShell()}
printf '%s' "$id" > "$stage/.materialized"
if ! verify_tree "$stage" "$id" ${expected}; then
  echo "The staged ${what} failed its check: a file is missing or changed." >&2
  exit 1
fi${
      runsIsolated()
        ? `
# Root wrote these; every run user must read them and none may change them.
# The parents are opened for traversal only.
chmod -R a+rX,go-w "$stage"
chmod a+rX,go-w ${input.parents.map(shellQuote).join(" ")}`
        : ""
    }
if command -v flock >/dev/null 2>&1; then
  exec 9>"$dir.lock"
  flock -w 60 9
fi
if verify_tree "$dir" "$id" ${expected}; then exit 0; fi
discard="$dir.discard-$$"
if test -e "$dir" || test -L "$dir"; then mv "$dir" "$discard"; fi
mv "$stage" "$dir"
rm -rf "$discard"`,
    { ...execOptions({ timeoutMs: 60_000 }), ...pin },
  );
  if (swap.timedOut) throw new Error(`Timed out while writing the ${what}.`);
  if (swap.exitCode !== 0) {
    const detail = (swap.stderr || swap.stdout).trim().slice(0, 2000);
    throw new Error(
      `Could not write the ${what}${detail ? `: ${detail}` : "."}`,
    );
  }
}

/** The manifest `sha256sum -c` reads, with paths relative to the folder. */
export function treeManifest(files: Map<string, Uint8Array>): string {
  return [...files.keys()]
    .sort()
    .map(name => {
      const digest = createHash("sha256")
        .update(files.get(name) as Uint8Array)
        .digest("hex");
      return `${digest}  ${name}\n`;
    })
    .join("");
}

/**
 * Put the connector's files in the box.
 *
 * Idempotent by sha: the directory name carries it, so an unchanged connector
 * is written once and reused across chunks, and a changed one can never be
 * served from a stale copy. Verified by hash, not by marker alone.
 */
export async function materializeConnector(input: {
  ctx: SandboxExecContext;
  runtimeId: string;
  slug: string;
  sourceSha: string;
  /** The folder's files, or a loader called only when the box lacks them. */
  files: Map<string, Uint8Array> | (() => Promise<Map<string, Uint8Array>>);
}): Promise<string> {
  const { ctx, runtimeId, slug, sourceSha } = input;
  const dir = connectorDir(ctx, runtimeId, slug, sourceSha);
  const loader = input.files;
  await installVerifiedTree({
    ctx,
    dir,
    id: sourceSha,
    what: `connector folder ${slug}@${sourceSha}`,
    files: async () => (typeof loader === "function" ? loader() : loader),
    parents: [
      path.posix.dirname(dir),
      path.posix.dirname(path.posix.dirname(dir)),
    ],
  });
  return dir;
}

/**
 * THE BUNDLE HOOK: given a box and a bundle hash, make the box's runtime root
 * hold that bundle, and say where it is.
 *
 * Every leased run calls this right after it gets its box, and the reconcile
 * `spec` does too. Today a "bundle" is the SDK runtime plus the connector
 * folder copied in, keyed by the folder's source sha. Iteration 1 (bundles,
 * RFC connector-runtime §5) replaces the body with "fetch the `.mjs` for this
 * hash and put it under the runtime root"; the callers do not change.
 *
 * Idempotent per box and hash: a box that already holds the bundle (a
 * resumed box, or one restored from its key's snapshot) costs one marker
 * check and never loads the files.
 */
export async function ensureBundle(input: {
  ctx: SandboxExecContext;
  hash: string;
  slug: string;
  /** The connector's own entry, used when it runs from its copied folder. */
  entry: string;
  files: () => Promise<Map<string, Uint8Array>>;
  ensureRuntime: (ctx: SandboxExecContext) => Promise<string>;
  /**
   * Iteration 1's bundle path: a folder with dependencies runs its built
   * `.mjs` (installConnectorBundle). Returns null for a folder without
   * dependencies, which is copied in as before.
   */
  bundle?: (args: {
    ctx: SandboxExecContext;
    runtimeId: string;
    files: Map<string, Uint8Array>;
  }) => Promise<{ dir: string; entry: string } | null>;
}): Promise<{ runtimeId: string; dir: string; entry: string }> {
  const runtimeId = await input.ensureRuntime(input.ctx);
  if (input.bundle) {
    const files = await input.files();
    const bundled = await input.bundle({ ctx: input.ctx, runtimeId, files });
    if (bundled) return { runtimeId, ...bundled };
    const dir = await materializeConnector({
      ctx: input.ctx,
      runtimeId,
      slug: input.slug,
      sourceSha: input.hash,
      files,
    });
    return { runtimeId, dir, entry: input.entry };
  }
  const dir = await materializeConnector({
    ctx: input.ctx,
    runtimeId,
    slug: input.slug,
    sourceSha: input.hash,
    files: input.files,
  });
  return { runtimeId, dir, entry: input.entry };
}

/** Lists every SDK file's sha256, relative to the runtime root. */
export const RUNTIME_MANIFEST = ".sdk-sha256";

/** Where the SDK package sits inside a runtime root. */
const SDK_PACKAGE_DIR = "node_modules/@makoai/connector-sdk";

/**
 * Shell lines that define `verify_runtime <root> <runtimeId>`.
 *
 * A runtime is usable only if all three hold: the marker names this
 * runtime, every SDK file matches the manifest's sha256, and the pinned Node
 * can import the SDK's entry (which imports every `src/` module). A marker
 * alone is not proof: on 2026-11-18 a box held the marker, `bin/` and
 * `package.json` but no `src/run.js`, and every connector start failed
 * with ERR_MODULE_NOT_FOUND for 7 minutes.
 */
export function verifyRuntimeShell(): string {
  return `sha256_check() {
  # GNU sha256sum still prints "<file>: FAILED open or read" on stdout for a
  # missing file under --status; the exit status alone is the answer.
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --status "$1" >/dev/null 2>&1; else shasum -a 256 -c --status "$1" >/dev/null 2>&1; fi
}
verify_runtime() {
  test -f "$1/.materialized" || return 1
  grep -Fqx "$2" "$1/.materialized" || return 1
  test -f "$1/${RUNTIME_MANIFEST}" || return 1
  (cd "$1" && sha256_check ${RUNTIME_MANIFEST}) || return 1
  test -x "$1/node/bin/node" || return 1
  "$1/node/bin/node" --input-type=module -e 'await import(process.argv[1])' "$1/${SDK_PACKAGE_DIR}/index.js" >/dev/null 2>&1 || return 1
}`;
}

/**
 * Shell lines that swap a verified `$stage` in as `$runtime_root`, under a
 * lock so two installers in one box never interleave.
 *
 * The root also holds every materialized connector (`connectors/`) and
 * bundle (`bundles/`). Runs that cached those paths keep using them without
 * re-verifying the SDK, so the swap carries both folders into the new root
 * instead of deleting them with the old one.
 */
export function swapRuntimeShell(): string {
  return `if command -v flock >/dev/null 2>&1; then
  exec 9>"$runtime_root.lock"
  flock -w 60 9
fi
if verify_runtime "$runtime_root" "$runtime_id"; then exit 0; fi
if test -d "$runtime_root" && ! test -L "$runtime_root"; then
  for kept in connectors bundles; do
    if test -d "$runtime_root/$kept" && ! test -L "$runtime_root/$kept"; then
      rm -rf "$stage/$kept"
      mv "$runtime_root/$kept" "$stage/$kept"
    fi
  done
fi
discard="$runtime_root.discard-$$"
if test -e "$runtime_root" || test -L "$runtime_root"; then mv "$runtime_root" "$discard"; fi
mv "$stage" "$runtime_root"
rm -rf "$discard"`;
}

/** The manifest `sha256sum -c` reads: one `<hex>  <path>` line per SDK file. */
export function runtimeManifest(files: Map<string, Uint8Array>): string {
  return [...files.keys()]
    .sort()
    .map(name => {
      const digest = createHash("sha256")
        .update(files.get(name) as Uint8Array)
        .digest("hex");
      return `${digest}  ${SDK_PACKAGE_DIR}/${name}\n`;
    })
    .join("");
}

/**
 * Is this exact SDK present, complete and importable in the box?
 *
 * Checks the files and an import, not just the marker, so a root left
 * half-written by an older API (or by anything else) is reinstalled instead
 * of being reused forever.
 */
export async function hasConnectorRuntime(
  ctx: SandboxExecContext,
  runtimeId: string,
): Promise<boolean> {
  const provider = getSandboxProvider();
  const root = runtimeRoot(ctx, runtimeId);
  // The box is tenant-controlled, so do not read even this marker into the API
  // process. `exec` bounds output and only returns the comparison result.
  const result = await provider.exec(
    ctx,
    `${verifyRuntimeShell()}
verify_runtime ${shellQuote(root)} ${shellQuote(runtimeId)} && echo yes || echo no`,
    execOptions({ timeoutMs: 30_000 }),
  );
  return result.stdout.trim() === "yes";
}

/**
 * Install the SDK into the box's runtime root from a set of files.
 *
 * Atomic per box. Every file, the pinned Node and the marker go into a
 * private staging directory first. The staged runtime must pass the same
 * check `hasConnectorRuntime` runs (hashes and an import of the SDK) before a
 * `mv` puts it in place, under a lock. A failed or interrupted install leaves
 * the previous root untouched and never writes a marker for a partial one.
 *
 * Pinned to one sandbox. When several boxes exist for one session key, the
 * E2B provider kills all but one, and an unpinned installer whose box died
 * mid-upload would carry on in the survivor: the rest of the files and the
 * marker landed there without `src/`. Every call after the first is pinned
 * to the box the first one ran in, so a box swap fails the install instead.
 */
export async function installConnectorRuntime(
  ctx: SandboxExecContext,
  runtimeId: string,
  files: Map<string, Uint8Array>,
): Promise<void> {
  const provider = getSandboxProvider();
  const root = runtimeRoot(ctx, runtimeId);
  const stage = `${root}.staging-${randomBytes(6).toString("hex")}`;
  const base = path.posix.join(stage, SDK_PACKAGE_DIR);

  const mkdir = await provider.exec(
    ctx,
    `mkdir -p ${shellQuote(base)}`,
    execOptions({ timeoutMs: 30_000 }),
  );
  if (mkdir.exitCode !== 0) {
    throw new Error(
      `Could not stage the connector runtime: ${(mkdir.stderr || mkdir.stdout).trim().slice(0, 2000)}`,
    );
  }
  const pin = mkdir.sandboxId ? { expectSandboxId: mkdir.sandboxId } : {};
  const fileOptions: SandboxFileOptions = { ...boxOwner(), ...pin };
  const staged = [
    ...[...files].map(([relative, bytes]) => ({
      path: path.posix.join(base, relative),
      bytes,
    })),
    {
      path: path.posix.join(stage, RUNTIME_MANIFEST),
      bytes: new TextEncoder().encode(runtimeManifest(files)),
    },
  ];
  if (provider.writeFiles) {
    await provider.writeFiles(ctx, staged, fileOptions);
  } else {
    for (const file of staged) {
      await provider.writeFile(ctx, file.path, file.bytes, fileOptions);
    }
  }

  // E2B templates are independently versioned and cannot be assumed to carry
  // the Node version the SDK needs. Download inside the sandbox (never through
  // the API heap), pin the version, and verify Node's published checksum before
  // it becomes executable. The local provider reuses a compatible host Node so
  // development on macOS does not install a Linux binary.
  const install = await provider.exec(
    ctx,
    `set -eu
runtime_root=${shellQuote(root)}
stage=${shellQuote(stage)}
runtime_id=${shellQuote(runtimeId)}
trap 'rm -rf "$stage"' EXIT
${verifyRuntimeShell()}
runtime_node="$stage/node/bin/node"
platform="$(uname -s)"
if test "$platform" = Linux; then
  case "$(uname -m)" in
    x86_64) node_arch=x64; expected=${CONNECTOR_NODE_SHA256.x64} ;;
    aarch64|arm64) node_arch=arm64; expected=${CONNECTOR_NODE_SHA256.arm64} ;;
    *) echo "Unsupported connector runtime architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  archive="node-v${CONNECTOR_NODE_VERSION}-linux-$node_arch.tar.xz"
  download="$stage/$archive"
  mkdir -p "$stage/node"
  curl -fsSL --retry 3 "https://nodejs.org/dist/v${CONNECTOR_NODE_VERSION}/$archive" -o "$download"
  printf '%s  %s\n' "$expected" "$download" | sha256sum -c -
  tar -xJf "$download" -C "$stage/node" --strip-components=1
  rm -f "$download"
else
  system_node="$(command -v node || true)"
  if test -z "$system_node"; then echo "Node is not installed" >&2; exit 1; fi
  "$system_node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 6)) process.exit(1)'
  mkdir -p "$(dirname "$runtime_node")"
  ln -sf "$system_node" "$runtime_node"
fi
"$runtime_node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 6)) process.exit(1)'
printf '%s' "$runtime_id" > "$stage/.materialized"
if ! verify_runtime "$stage" "$runtime_id"; then
  echo "The staged connector runtime failed its check: an SDK file is missing or changed, or the SDK does not import." >&2
  exit 1
fi${
      runsIsolated()
        ? `
# Run users read and execute this tree; none of them may change it.
chmod -R a+rX,go-w "$stage"
chmod a+rX,go-w "$(dirname "$runtime_root")" "$(dirname "$(dirname "$runtime_root")")" ${shellQuote(ISOLATED_ROOT)}`
        : ""
    }
${swapRuntimeShell()}`,
    { ...execOptions({ timeoutMs: 120_000 }), ...pin },
  );
  if (install.timedOut) {
    throw new Error("Timed out while installing the connector runtime.");
  }
  if (install.exitCode !== 0) {
    const detail = (install.stderr || install.stdout).trim();
    throw new Error(
      `Could not install the connector runtime${detail ? `: ${detail.slice(0, 2000)}` : "."}`,
    );
  }
}

/** The run's cleanup failed: the box may still hold its credential or code. */
export class RunCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCleanupError";
  }
}

/**
 * Boxes prepared for isolated runs, per process: the tool preflight passed
 * and the root-only inbox exists. Keyed by session, valued by the sandbox id
 * that was prepared, which every later call of a run is pinned to: a box
 * replaced since was never prepared, and must not receive a credential.
 */
const prepared = new Map<string, string | undefined>();

/**
 * Prepare a box once: check it has every tool run isolation needs, and make
 * the root-only inbox and results directories. A template without the tools
 * cannot isolate a run; this says which tool is missing.
 */
export async function prepareBox(
  ctx: SandboxExecContext,
): Promise<string | undefined> {
  if (prepared.has(ctx.sessionKey)) return prepared.get(ctx.sessionKey);
  const result = await getSandboxProvider().exec(ctx, prepareBoxScript(), {
    timeoutMs: 30_000,
    asRoot: true,
  });
  const missing = result.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  if (result.exitCode !== 0 || missing.length > 0) {
    logger.error("Connector box template lacks the tools run isolation needs", {
      sessionKey: ctx.sessionKey,
      missing,
      stderr: result.stderr.slice(0, 500),
    });
    throw new Error(
      `This box cannot isolate connector runs: missing ${missing.join(", ") || "tools (preflight failed)"}.`,
    );
  }
  prepared.set(ctx.sessionKey, result.sandboxId);
  return result.sandboxId;
}

/**
 * A connector box had too little free memory to start another run
 * (memoryGateScript, CONNECTOR_RUN_MIN_FREE_MB). The runs already in it end
 * and free their memory, so the caller waits and tries again (flow steps:
 * withBoxMemoryWaits). Matched as an infrastructure and a transient failure,
 * so it never counts against a flow or a connector.
 */
export class ConnectorBoxLowMemoryError extends BoxLowMemoryError {
  constructor(
    readonly sessionKey: string,
    availableMb: number,
  ) {
    super(
      `The connector box ${sessionKey} has ${availableMb} MB of memory free; a connector run needs ${CONNECTOR_RUN_MIN_FREE_MB} MB. Waiting for the runs in it to finish.`,
      availableMb,
      CONNECTOR_RUN_MIN_FREE_MB,
    );
    this.name = "ConnectorBoxLowMemoryError";
  }
}

/** Log the gate's refusal (Cloud Logging counts `boxLowMemory`) and build its error. */
export function connectorBoxLowMemory(
  ctx: SandboxExecContext,
  sandboxId: string | undefined,
  availableMb: number,
  what: "chunk" | "session",
): ConnectorBoxLowMemoryError {
  boxLogger.warn("Connector box low on memory; not starting a run", {
    boxLowMemory: true,
    sessionKey: ctx.sessionKey,
    sandboxId,
    availableMb,
    requiredMb: CONNECTOR_RUN_MIN_FREE_MB,
    what,
  });
  return new ConnectorBoxLowMemoryError(ctx.sessionKey, availableMb);
}

/** Forget a prepared box, so the next call prepares (and pins) it again. */
export function forgetPreparedBox(sessionKey: string): void {
  prepared.delete(sessionKey);
}

/**
 * Kill the workspace's v2 sync box after a run's cleanup failed in it.
 *
 * The flag-off path has no lease to mark unhealthy, so this is its hook: a
 * box where a run's thread or file may have survived is never handed to the
 * next run. The next command creates a fresh box under the same key.
 */
export async function retireSyncBox(
  workspaceId: string,
  reason: string,
): Promise<void> {
  const key = syncBoxContext(workspaceId).sessionKey;
  logger.error("Killing a connector sync box after a failed run cleanup", {
    workspaceId,
    reason,
  });
  prepared.delete(key);
  await getSandboxProvider().destroySession?.(key);
}

/** The pinned Node binary of a runtime root, for boxes that build bundles. */
export function connectorRuntimeNodePath(
  ctx: SandboxExecContext,
  runtimeId: string,
): string {
  return runtimeNode(ctx, runtimeId);
}

/** The file name a bundle has inside the box. */
export const CONNECTOR_BUNDLE_ENTRY = "connector.mjs";

/**
 * Put a built bundle in the box's runtime root, once per hash.
 *
 * The bundle lives under the runtime root so its one external import,
 * `@makoai/connector-sdk`, resolves through the root's node_modules exactly as
 * a TypeScript entry's does. `load` is called only when the box does not
 * already hold this hash, so a warm box never touches object storage.
 */
export async function installConnectorBundle(input: {
  ctx: SandboxExecContext;
  runtimeId: string;
  slug: string;
  hash: string;
  expectedSha256?: string;
  load: () => Promise<Uint8Array>;
}): Promise<{ dir: string; entry: string }> {
  const { ctx, runtimeId, slug, hash, expectedSha256 } = input;
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error(
      "Expected connector bundle digest must be a SHA-256 hex string.",
    );
  }
  const id = expectedSha256 ? `${hash}-${expectedSha256}` : hash;
  const dir = path.posix.join(
    runtimeRoot(ctx, runtimeId),
    "bundles",
    `${slug}@${id}`,
  );
  await installVerifiedTree({
    ctx,
    dir,
    id,
    what: `connector bundle ${slug}@${hash}`,
    expectedManifestLine: expectedSha256
      ? `${expectedSha256}  ${CONNECTOR_BUNDLE_ENTRY}`
      : undefined,
    files: async () => new Map([[CONNECTOR_BUNDLE_ENTRY, await input.load()]]),
    parents: [path.posix.dirname(dir)],
  });
  return { dir, entry: CONNECTOR_BUNDLE_ENTRY };
}

/**
 * Run one protocol command against a materialized connector.
 *
 * Inputs that are objects (config, catalog, state) are written as files rather
 * than passed as arguments: a command line is visible in the box's process
 * table, and a credential must not be.
 *
 * Three round trips to the box on the critical path, where bench G1 measured
 * 8 provider calls (and per-run users would have added 3 more):
 * 1. one request writes every input file;
 * 2. one command runs the connector, deletes its inputs the moment it exits,
 *    takes the bounded snapshot of its output and prints the snapshot's size.
 *    On E2B the same command first creates the run's own Unix user and last
 *    removes it with every thread and file it left (run-isolation.ts);
 * 3. one read brings the snapshot back.
 * Removing the snapshot is a 4th call, off the critical path: the credential
 * is already gone by then.
 */
export async function runConnectorCommand(input: {
  ctx: SandboxExecContext;
  runtimeId: string;
  connectorDir: string;
  command: ConnectorCommand;
  config?: Record<string, unknown>;
  catalog?: Record<string, unknown>;
  state?: Record<string, unknown> | unknown[];
  /** A `webhook` command's events (`--batch`). Never holds a signing secret. */
  batch?: Record<string, unknown>;
  maxIterations?: number;
  /**
   * A `read` stops after the page that takes its records past this many
   * bytes (`--max-bytes`), so a chunk of large rows stays under
   * MAX_CONNECTOR_PROTOCOL_BYTES however many pages it was allowed.
   */
  maxBytes?: number;
  timeoutMs?: number;
  /** Remaining caller budget, checked immediately before launching the command. */
  remainingMs?: () => number;
  entry?: string;
  /**
   * Called when the run's cleanup failed. The result still returns; the
   * caller decides what the box is worth now (a lease kills it).
   */
  onCleanupFailure?: (reason: string) => void;
}): Promise<RunResult> {
  assertLaunchDeadline(input.remainingMs);
  const { ctx } = input;
  const encoder = new TextEncoder();
  const inputs: RunFiles = [];
  for (const [name, value] of [
    ["config", input.config],
    ["catalog", input.catalog],
    ["state", input.state],
    ["batch", input.batch],
  ] as const) {
    if (value === undefined) continue;
    inputs.push({
      name: `${name}.json`,
      bytes: encoder.encode(JSON.stringify(value)),
    });
  }
  /** The connector's argv, given where its inputs will be. */
  const argv = (inputDir: string): string =>
    connectorCommandLine({
      ctx,
      runtimeId: input.runtimeId,
      connectorDir: input.connectorDir,
      entry: input.entry,
      command: input.command,
      inputs: inputs.map(file => path.posix.join(inputDir, file.name)),
      maxIterations: input.maxIterations,
      maxBytes: input.maxBytes,
    });
  return runsIsolated()
    ? runIsolated(input, inputs, argv)
    : runShared(input, inputs, argv);
}

/**
 * The shell-quoted command line of one connector command: the runtime's
 * pinned Node, the SDK runner, the connector entry, and one `--<name>` per
 * input file (`config.json` -> `--config`). Shared by chunk runs and read
 * sessions (session-read.ts), so both run the same runner the same way.
 */
export function connectorCommandLine(input: {
  ctx: SandboxExecContext;
  runtimeId: string;
  connectorDir: string;
  entry?: string;
  command: ConnectorCommand;
  /** Input file paths, named `<input>.json`. */
  inputs: string[];
  maxIterations?: number;
  maxBytes?: number;
  /** Flags after the rest, e.g. `--session`. */
  extra?: string[];
}): string {
  const { ctx } = input;
  const bin = path.posix.join(
    runtimeRoot(ctx, input.runtimeId),
    "node_modules",
    "@makoai",
    "connector-sdk",
    "bin",
    "mako-connector.js",
  );
  const args = [
    input.command,
    "--connector",
    path.posix.join(input.connectorDir, input.entry ?? "connector.ts"),
  ];
  for (const file of input.inputs) {
    args.push(`--${path.posix.basename(file).replace(/\.json$/, "")}`, file);
  }
  if (input.maxIterations !== undefined) {
    args.push("--max-iterations", String(input.maxIterations));
  }
  if (input.maxBytes !== undefined) {
    args.push("--max-bytes", String(input.maxBytes));
  }
  args.push(...(input.extra ?? []));
  return `${shellQuote(runtimeNode(ctx, input.runtimeId))} ${shellQuote(bin)} ${args.map(shellQuote).join(" ")}`;
}

/** The runtime's pinned Node binary, for a session's root supervisor. */
export function connectorRuntimeNode(
  ctx: SandboxExecContext,
  runtimeId: string,
): string {
  return runtimeNode(ctx, runtimeId);
}

type RunInput = Parameters<typeof runConnectorCommand>[0];
type RunFiles = Array<{ name: string; bytes: Uint8Array }>;

/** Write files in one request where the provider can, as `options` says. */
export async function writeAll(
  ctx: SandboxExecContext,
  files: Array<{ path: string; bytes: Uint8Array }>,
  options?: SandboxFileOptions,
): Promise<void> {
  if (files.length === 0) return;
  const provider = getSandboxProvider();
  if (provider.writeFiles) {
    assertLaunchDeadline(options?.remainingMs);
    await (options
      ? provider.writeFiles(ctx, files, options)
      : provider.writeFiles(ctx, files));
    return;
  }
  for (const file of files) {
    assertLaunchDeadline(options?.remainingMs);
    await (options
      ? provider.writeFile(ctx, file.path, file.bytes, options)
      : provider.writeFile(ctx, file.path, file.bytes));
  }
}

/**
 * The run in a box with real Unix users (E2B): the per-run user, its setup
 * and its cleanup all happen inside the one command (chunkScript).
 */
async function runIsolated(
  input: RunInput,
  inputs: RunFiles,
  argv: (inputDir: string) => string,
): Promise<RunResult> {
  const provider = getSandboxProvider();
  const { ctx } = input;
  let pinned: string | undefined;
  try {
    pinned = await prepareBox(ctx);
  } catch (error) {
    if (isSandboxGone(error)) prepared.delete(ctx.sessionKey);
    throw error;
  }
  // Every call of the run is pinned to the box that was prepared. A box
  // replaced since then fails the call instead of receiving the credential.
  const owner = { asRoot: true as const, expectSandboxId: pinned };
  const inputOwner = input.remainingMs
    ? { ...owner, remainingMs: input.remainingMs }
    : owner;

  let lastError = "";
  // A random UID can collide with one in use; a fresh user and run fixes it.
  for (let attempt = 0; attempt < 3; attempt++) {
    assertLaunchDeadline(input.remainingMs);
    const layout = runLayout(
      randomBytes(8).toString("hex"),
      `mkc${randomBytes(6).toString("hex")}`,
      randomInt(200_000, 2_000_000_000),
      randomInt(200_000, 2_000_000_000),
    );
    const finalInputs = inputs.map(file =>
      path.posix.join(layout.dir, file.name),
    );
    let result: SandboxExecResult;
    let marker: string | undefined;
    try {
      // Round trip 1: every input into the root-only inbox.
      await writeAll(
        ctx,
        inputs.map(file => ({
          path: incomingPath(layout.runId, file.name),
          bytes: file.bytes,
        })),
        inputOwner,
      );
      assertLaunchDeadline(input.remainingMs);
      // Round trip 2: setup, launch, bound, cleanup.
      result = await provider.exec(
        ctx,
        chunkScript(
          layout,
          finalInputs,
          argv(layout.dir),
          MAX_CONNECTOR_PROTOCOL_BYTES,
        ),
        {
          ...owner,
          timeoutMs: Math.min(
            input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            input.remainingMs?.() ?? Infinity,
          ),
          ...(input.remainingMs ? { remainingMs: input.remainingMs } : {}),
        },
      );
      marker = lastMarker(result.stdout, CHUNK_MARKER);
      noteHidepidOff(result.stdout, ctx, result.sandboxId, "chunk");
    } catch (error) {
      if (isSandboxGone(error)) prepared.delete(ctx.sessionKey);
      await abandonRun(input, layout, owner);
      throw error;
    }

    // Cut off before the end (a timeout, a kill): the command's own cleanup
    // may not have run, so it runs now, and the chunk fails.
    if (!marker || result.timedOut) {
      await abandonRun(input, layout, owner);
      if (result.preLaunchDeadline) throw new LaunchDeadlineError();
      if (result.timedOut) {
        return {
          exitCode: result.exitCode,
          messages: [],
          malformed: [],
          stderr: result.stderr,
          timedOut: true,
        };
      }
      throw new Error(
        `The connector run ended without its report${result.stderr ? `: ${result.stderr.trim().slice(0, 500)}` : "."}`,
      );
    }

    // The memory gate refused the run before any of it existed, and removed
    // its inbox: nothing to abandon.
    const lowMb = lowMemoryMb(marker);
    if (lowMb !== null) {
      throw connectorBoxLowMemory(
        ctx,
        result.sandboxId ?? pinned,
        lowMb,
        "chunk",
      );
    }
    const [sizeText, cleanupText] = marker.split(/\s+/);
    if (sizeText === "setup-failed") {
      lastError = (result.stderr || result.stdout).trim().slice(0, 2000);
      // A fresh UID fixes a collision, never an account that cannot be
      // locked: refuse the run at once (hardenScript, in every setup).
      if (/empty passwords left|could not lock/.test(lastError)) {
        logger.error(
          "Could not lock passwordless accounts in a connector box",
          {
            sessionKey: ctx.sessionKey,
            detail: lastError.slice(0, 500),
          },
        );
        break;
      }
      continue;
    }
    const cleanupCode = Number(cleanupText);
    if (cleanupCode !== 0) {
      const reason =
        cleanupCode === CLEANUP_SURVIVORS_EXIT
          ? "the run's processes would not die"
          : `cleanup exited ${cleanupText}: ${result.stderr.trim().slice(0, 500)}`;
      logger.error("Failed to remove a connector run", {
        runDir: layout.dir,
        user: layout.user,
        reason,
      });
      input.onCleanupFailure?.(`Connector run cleanup failed: ${reason}`);
    }
    if (sizeText === "inputs-missing") {
      prepared.delete(ctx.sessionKey);
      throw new Error(
        "The connector's inputs are missing: its box was replaced before the run.",
      );
    }
    // Root opens the output file before the connector starts, so it exists
    // whatever the connector did. Missing means the box under the run was
    // replaced: fail the chunk rather than report a short, empty success.
    if (sizeText === "missing") {
      throw new Error(
        "The connector's output is missing: its box was replaced during the run.",
      );
    }
    const resultFile = resultPath(layout.runId);
    try {
      const outputBytes = boundedSize(sizeText);
      // Round trip 3: the bounded output.
      const raw =
        outputBytes === 0
          ? ""
          : new TextDecoder().decode(
              await provider.readFile(ctx, resultFile, owner),
            );
      return parseProtocol(raw, input.command, result);
    } finally {
      // Data, not a credential: removed off the critical path.
      void provider
        .exec(ctx, `rm -f ${shellQuote(resultFile)}`, {
          ...owner,
          timeoutMs: 30_000,
        })
        .catch(error =>
          logger.error("Failed to remove a connector run's output", {
            error,
            resultFile,
          }),
        );
    }
  }
  throw new Error(
    `Could not create an isolated user for the connector run${lastError ? `: ${lastError}` : "."}`,
  );
}

/**
 * The cleanup for a run whose command was cut off. Awaited: the credential
 * may still be on disk. A box that is gone took the run with it.
 */
async function abandonRun(
  input: RunInput,
  layout: RunLayout,
  owner: SandboxFileOptions & { asRoot: true },
): Promise<void> {
  let detail: string;
  try {
    const result = await getSandboxProvider().exec(
      input.ctx,
      abandonScript(layout),
      { ...owner, timeoutMs: 60_000 },
    );
    if (result.exitCode === 0 && !result.timedOut) return;
    detail = result.timedOut
      ? "cleanup timed out"
      : result.exitCode === CLEANUP_SURVIVORS_EXIT
        ? "the run's processes would not die"
        : (result.stderr || `exit ${result.exitCode}`).slice(0, 500);
  } catch (error) {
    if (isSandboxGone(error)) return;
    detail = error instanceof Error ? error.message : String(error);
  }
  logger.error("Failed to remove a connector run", {
    runDir: layout.dir,
    user: layout.user,
    detail,
  });
  input.onCleanupFailure?.(`Connector run cleanup failed: ${detail}`);
}

/**
 * The run where the provider has one user (local development): a plain run
 * directory, the same three round trips.
 */
async function runShared(
  input: RunInput,
  inputs: RunFiles,
  argv: (inputDir: string) => string,
): Promise<RunResult> {
  const provider = getSandboxProvider();
  const { ctx } = input;
  const runId = randomBytes(8).toString("hex");
  const runDir = path.posix.join(
    provider.scratch(ctx),
    "connector-runs",
    runId,
  );
  const outputPath = path.posix.join(runDir, "out.jsonl");
  const boundedOutputPath = path.posix.join(runDir, "out.bounded.jsonl");
  const files = inputs.map(file => ({
    path: path.posix.join(runDir, file.name),
    bytes: file.bytes,
  }));

  // Set once the command has deleted its inputs itself. Until then the run
  // directory may hold a credential, and the cleanup below must finish
  // before this function returns.
  let inputsDeleted = false;
  try {
    // Round trip 1: every input in one request.
    await writeAll(
      ctx,
      files,
      input.remainingMs ? { remainingMs: input.remainingMs } : undefined,
    );
    assertLaunchDeadline(input.remainingMs);

    // Round trip 2: run, delete the inputs, bound the output, report its
    // size. `head` makes an immutable snapshot of at most limit + 1 bytes,
    // even if connector code left a child process appending to stdout.
    const inputPaths = files.map(file => shellQuote(file.path)).join(" ");
    const script = [
      `mkdir -p ${shellQuote(runDir)}`,
      `${argv(runDir)} > ${shellQuote(outputPath)}`,
      `status=$?`,
      ...(inputPaths ? [`rm -f ${inputPaths}`] : []),
      `if test -f ${shellQuote(outputPath)}; then`,
      `  if head -c ${MAX_CONNECTOR_PROTOCOL_BYTES + 1} ${shellQuote(outputPath)} > ${shellQuote(boundedOutputPath)}; then`,
      `    echo "${BOUNDED_MARKER} $(wc -c < ${shellQuote(boundedOutputPath)})"`,
      `  else echo "${BOUNDED_MARKER} error"; fi`,
      `  rm -f ${shellQuote(outputPath)}`,
      `else echo "${BOUNDED_MARKER} missing"; fi`,
      `exit $status`,
    ].join("\n");
    const result = await provider.exec(ctx, script, {
      timeoutMs: Math.min(
        input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        input.remainingMs?.() ?? Infinity,
      ),
      ...(input.remainingMs ? { remainingMs: input.remainingMs } : {}),
      // Nothing is ADDED to the environment on purpose: a connector has no
      // business reading even what an app may read. What it does see is the
      // provider's own fixed allowlist.
    });
    if (result.preLaunchDeadline) throw new LaunchDeadlineError();
    if (result.timedOut) {
      return {
        exitCode: result.exitCode,
        messages: [],
        malformed: [],
        stderr: result.stderr,
        timedOut: true,
      };
    }
    const marker = lastMarker(result.stdout, BOUNDED_MARKER);
    // The marker is printed after `rm -f` of the inputs. Without it, the
    // script may have died before deleting them, so the cleanup is awaited.
    inputsDeleted = marker !== undefined;
    const outputBytes = marker === "missing" ? 0 : boundedSize(marker ?? "");
    // Round trip 3: the bounded snapshot.
    const raw =
      outputBytes === 0
        ? ""
        : new TextDecoder().decode(
            await provider.readFile(ctx, boundedOutputPath),
          );
    return parseProtocol(raw, input.command, result);
  } finally {
    const cleanup = provider
      .exec(ctx, `rm -rf ${shellQuote(runDir)}`, { timeoutMs: 30_000 })
      .catch(error =>
        logger.error("Failed to clean a connector run directory", {
          error,
          runDir,
        }),
      );
    if (!inputsDeleted) await cleanup;
  }
}

/** The value after the last `<marker> ` line, if the command printed one. */
function lastMarker(stdout: string, marker: string): string | undefined {
  return stdout
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith(`${marker} `))
    .at(-1)
    ?.slice(marker.length + 1)
    .trim();
}

/** The bounded output's size, refusing anything over the cap. */
function boundedSize(sizeText: string): number {
  const outputBytes = Number(sizeText);
  if (!sizeText || !Number.isSafeInteger(outputBytes) || outputBytes < 0) {
    throw new Error("Could not determine the connector protocol size.");
  }
  if (outputBytes > MAX_CONNECTOR_PROTOCOL_BYTES) {
    throw new ConnectorOutputTooLargeError(
      `Connector protocol output exceeded the ${MAX_CONNECTOR_PROTOCOL_BYTES} byte limit. Reduce the page or batch size.`,
      "bytes",
    );
  }
  return outputBytes;
}

/** JSON lines -> messages, capped, with non-protocol lines kept aside. */
export function parseProtocol(
  raw: string,
  command: ConnectorCommand,
  result: SandboxExecResult,
): RunResult {
  const messages: ProtocolMessage[] = [];
  const malformed: string[] = [];
  let cursor = 0;
  let protocolLines = 0;
  while (cursor < raw.length) {
    const newline = raw.indexOf("\n", cursor);
    const line = raw.slice(cursor, newline < 0 ? raw.length : newline);
    cursor = newline < 0 ? raw.length : newline + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    protocolLines++;
    if (protocolLines > MAX_CONNECTOR_PROTOCOL_MESSAGES) {
      throw new ConnectorOutputTooLargeError(
        `Connector protocol output exceeded the ${MAX_CONNECTOR_PROTOCOL_MESSAGES} message limit. Reduce the page or batch size.`,
        "messages",
      );
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.type === "string"
      ) {
        messages.push(parsed as ProtocolMessage);
      } else {
        malformed.push(trimmed);
      }
    } catch {
      malformed.push(trimmed);
    }
  }
  if (malformed.length > 0) {
    logger.warn("Connector emitted lines that are not protocol messages", {
      command,
      count: malformed.length,
      sample: malformed[0]?.slice(0, 200),
    });
  }
  return {
    exitCode: result.exitCode,
    messages,
    malformed,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}

/** The first message of a given type, which is all most commands emit. */
export function firstOfType<T = ProtocolMessage>(
  messages: ProtocolMessage[],
  type: string,
): T | undefined {
  return messages.find(message => message.type === type) as T | undefined;
}

/**
 * The error a failed command should report.
 *
 * A connector's own TRACE message says what went wrong in its words; stderr is
 * the fallback. Reporting "exit code 1" when the connector said "401: this key
 * was revoked" is the difference between a fixable error and a mystery.
 */
export function failureMessage(result: RunResult): string | null {
  if (result.timedOut) return "The connector timed out.";
  const trace = result.messages.find(
    message =>
      message.type === "TRACE" && (message.trace as any)?.type === "ERROR",
  );
  const traced = (trace?.trace as any)?.error?.message;
  if (traced) return String(traced);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    return stderr
      ? stderr.slice(0, 2000)
      : `The connector exited with code ${result.exitCode}.`;
  }
  return null;
}
