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
import { randomBytes, randomInt } from "node:crypto";
import {
  abandonScript,
  CHUNK_MARKER,
  chunkScript,
  CLEANUP_SURVIVORS_EXIT,
  HIDEPID_MARKER,
  incomingPath,
  ISOLATED_ROOT,
  ISOLATED_RUNTIME,
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

/** Write a file the way the box expects: as root when runs are isolated. */
function writeBoxFile(
  ctx: SandboxExecContext,
  remotePath: string,
  bytes: Uint8Array,
  owner: { asRoot: true } | undefined = boxOwner(),
): Promise<void> {
  const provider = getSandboxProvider();
  return owner
    ? provider.writeFile(ctx, remotePath, bytes, owner)
    : provider.writeFile(ctx, remotePath, bytes);
}

function execOptions(
  options: Omit<SandboxExecOptions, "asRoot">,
): SandboxExecOptions {
  return { ...options, ...boxOwner() };
}

function runtimeNode(ctx: SandboxExecContext, runtimeId: string): string {
  return path.posix.join(runtimeRoot(ctx, runtimeId), "node", "bin", "node");
}

/**
 * Put the connector's files in the box.
 *
 * Idempotent by sha: the directory name carries it, so an unchanged connector
 * is written once and reused across chunks, and a changed one can never be
 * served from a stale copy.
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
  const provider = getSandboxProvider();
  const dir = connectorDir(ctx, runtimeId, slug, sourceSha);

  const marker = path.posix.join(dir, ".materialized");
  const check = await provider.exec(
    ctx,
    `test -f ${shellQuote(marker)} && echo yes || echo no`,
    execOptions({ timeoutMs: 30_000 }),
  );
  if (check.stdout.trim() === "yes") return dir;

  const files =
    typeof input.files === "function" ? await input.files() : input.files;
  for (const [relative, bytes] of files) {
    // A path from the repo tree must not escape the directory it is being
    // written into. Nothing in a normal connector folder ever contains "..",
    // so this only ever fires on something built to escape.
    const target = path.posix.normalize(path.posix.join(dir, relative));
    if (!target.startsWith(`${dir}/`)) {
      throw new Error(
        `Refusing to write ${relative}: it escapes the connector directory`,
      );
    }
    await writeBoxFile(ctx, target, bytes);
  }
  if (runsIsolated()) {
    // Root wrote these; every run user must read them and none may change
    // them. The parents are opened for traversal only.
    await mustSucceed(
      provider.exec(
        ctx,
        `chmod a+rX,go-w ${shellQuote(path.posix.dirname(dir))} ${shellQuote(path.posix.dirname(path.posix.dirname(dir)))} && chmod -R a+rX,go-w ${shellQuote(dir)}`,
        execOptions({ timeoutMs: 30_000 }),
      ),
      "open the connector folder to run users",
    );
  }
  await writeBoxFile(ctx, marker, new TextEncoder().encode(sourceSha));
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

/** Is this exact SDK present and completely materialized in the box? */
export async function hasConnectorRuntime(
  ctx: SandboxExecContext,
  runtimeId: string,
): Promise<boolean> {
  const provider = getSandboxProvider();
  const marker = path.posix.join(runtimeRoot(ctx, runtimeId), ".materialized");
  // The box is tenant-controlled, so do not read even this marker into the API
  // process. `exec` bounds output and only returns the comparison result.
  const result = await provider.exec(
    ctx,
    `test -f ${shellQuote(marker)} && grep -Fqx ${shellQuote(runtimeId)} ${shellQuote(marker)} && echo yes || echo no`,
    execOptions({ timeoutMs: 30_000 }),
  );
  return result.stdout.trim() === "yes";
}

/** Install the SDK into the box's runtime root from a set of files. */
export async function installConnectorRuntime(
  ctx: SandboxExecContext,
  runtimeId: string,
  files: Map<string, Uint8Array>,
): Promise<void> {
  const provider = getSandboxProvider();
  const root = runtimeRoot(ctx, runtimeId);
  const base = path.posix.join(
    root,
    "node_modules",
    "@makoai",
    "connector-sdk",
  );
  for (const [relative, bytes] of files) {
    await writeBoxFile(ctx, path.posix.join(base, relative), bytes);
  }

  // E2B templates are independently versioned and cannot be assumed to carry
  // the Node version the SDK needs. Download inside the sandbox (never through
  // the API heap), pin the version, and verify Node's published checksum before
  // it becomes executable. The local provider reuses a compatible host Node so
  // development on macOS does not install a Linux binary.
  const node = runtimeNode(ctx, runtimeId);
  const installNode = await provider.exec(
    ctx,
    `set -eu
runtime_root=${shellQuote(root)}
runtime_node=${shellQuote(node)}
if test -x "$runtime_node"; then exit 0; fi
platform="$(uname -s)"
if test "$platform" = Linux; then
  case "$(uname -m)" in
    x86_64) node_arch=x64; expected=${CONNECTOR_NODE_SHA256.x64} ;;
    aarch64|arm64) node_arch=arm64; expected=${CONNECTOR_NODE_SHA256.arm64} ;;
    *) echo "Unsupported connector runtime architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  archive="node-v${CONNECTOR_NODE_VERSION}-linux-$node_arch.tar.xz"
  download="$runtime_root/$archive"
  mkdir -p "$runtime_root/node"
  curl -fsSL --retry 3 "https://nodejs.org/dist/v${CONNECTOR_NODE_VERSION}/$archive" -o "$download"
  printf '%s  %s\n' "$expected" "$download" | sha256sum -c -
  tar -xJf "$download" -C "$runtime_root/node" --strip-components=1
  rm -f "$download"
else
  system_node="$(command -v node || true)"
  if test -z "$system_node"; then echo "Node is not installed" >&2; exit 1; fi
  "$system_node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 6)) process.exit(1)'
  mkdir -p "$(dirname "$runtime_node")"
  ln -sf "$system_node" "$runtime_node"
fi
"$runtime_node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 6)) process.exit(1)'${
      runsIsolated()
        ? `
# Run users read and execute this tree; none of them may change it.
chmod -R a+rX,go-w "$runtime_root"
chmod a+rX,go-w "$(dirname "$runtime_root")" "$(dirname "$(dirname "$runtime_root")")" ${shellQuote(ISOLATED_ROOT)}`
        : ""
    }`,
    execOptions({ timeoutMs: 120_000 }),
  );
  if (installNode.timedOut) {
    throw new Error("Timed out while installing the connector Node runtime.");
  }
  if (installNode.exitCode !== 0) {
    const detail = (installNode.stderr || installNode.stdout).trim();
    throw new Error(
      `Could not install the connector Node runtime${detail ? `: ${detail.slice(0, 2000)}` : "."}`,
    );
  }
  // Written last: a killed or failed upload is retried rather than mistaken for
  // a complete runtime on the next invocation.
  await writeBoxFile(
    ctx,
    path.posix.join(root, ".materialized"),
    new TextEncoder().encode(runtimeId),
  );
}

async function mustSucceed(
  pending: Promise<{ exitCode: number; stderr: string; stdout: string }>,
  what: string,
): Promise<void> {
  const result = await pending;
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
    throw new Error(`Could not ${what}${detail ? `: ${detail}` : "."}`);
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
  load: () => Promise<Uint8Array>;
}): Promise<{ dir: string; entry: string }> {
  const { ctx, runtimeId, slug, hash } = input;
  const provider = getSandboxProvider();
  const dir = path.posix.join(
    runtimeRoot(ctx, runtimeId),
    "bundles",
    `${slug}@${hash}`,
  );
  const marker = path.posix.join(dir, ".materialized");
  const check = await provider.exec(
    ctx,
    `test -f ${shellQuote(marker)} && echo yes || echo no`,
    execOptions({ timeoutMs: 30_000 }),
  );
  if (check.stdout.trim() !== "yes") {
    const bytes = await input.load();
    await writeBoxFile(
      ctx,
      path.posix.join(dir, CONNECTOR_BUNDLE_ENTRY),
      bytes,
    );
    if (runsIsolated()) {
      // Root wrote it; every run user reads it and none may change it.
      await mustSucceed(
        provider.exec(
          ctx,
          `chmod a+rX,go-w ${shellQuote(path.posix.dirname(dir))} && chmod -R a+rX,go-w ${shellQuote(dir)}`,
          execOptions({ timeoutMs: 30_000 }),
        ),
        "open the connector bundle to run users",
      );
    }
    // Written last, as for the runtime: a half-written bundle is rewritten.
    await writeBoxFile(ctx, marker, new TextEncoder().encode(hash));
  }
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
  entry?: string;
  /**
   * Called when the run's cleanup failed. The result still returns; the
   * caller decides what the box is worth now (a lease kills it).
   */
  onCleanupFailure?: (reason: string) => void;
}): Promise<RunResult> {
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
    await (options
      ? provider.writeFiles(ctx, files, options)
      : provider.writeFiles(ctx, files));
    return;
  }
  for (const file of files) {
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

  let lastError = "";
  // A random UID can collide with one in use; a fresh user and run fixes it.
  for (let attempt = 0; attempt < 3; attempt++) {
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
        owner,
      );
      // Round trip 2: setup, launch, bound, cleanup.
      result = await provider.exec(
        ctx,
        chunkScript(
          layout,
          finalInputs,
          argv(layout.dir),
          MAX_CONNECTOR_PROTOCOL_BYTES,
        ),
        { ...owner, timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS },
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
    await writeAll(ctx, files);

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
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Nothing is ADDED to the environment on purpose: a connector has no
      // business reading even what an app may read. What it does see is the
      // provider's own fixed allowlist.
    });
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
