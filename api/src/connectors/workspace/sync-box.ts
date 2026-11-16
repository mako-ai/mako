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
 *    next one. See `openRun`.
 * 3. NOTHING BUT A BOUNDED PROTOCOL COMES BACK. stdout is redirected to a file
 *    because `exec`'s output cap would truncate legitimate records. A bounded
 *    snapshot is made before that file crosses into the API process, so tenant
 *    code still cannot turn a large batch into an API heap exhaustion.
 */
import { randomBytes, randomInt } from "node:crypto";
import {
  CLEANUP_SURVIVORS_EXIT,
  cleanupScript,
  ISOLATED_ROOT,
  ISOLATED_RUNTIME,
  launchScript,
  preflightScript,
  runLayout,
  stagedPath,
  setupScript,
  shellQuote,
  snapshotScript,
  type RunLayout,
} from "./run-isolation";
import path from "node:path";
import {
  getSandboxProvider,
  isSandboxGone,
  type SandboxExecContext,
  type SandboxExecOptions,
} from "../../apps/sandbox/provider";
import { loggers } from "../../logging";

const logger = loggers.connector();

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

export type ConnectorCommand = "spec" | "check" | "discover" | "read";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** A protocol chunk may be large, but it may never be unbounded. */
export const MAX_CONNECTOR_PROTOCOL_BYTES = 32 * 1024 * 1024;
export const MAX_CONNECTOR_PROTOCOL_MESSAGES = 50_000;

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

/**
 * One run's private corner of the box.
 *
 * `dir` holds the run's inputs. `launch` turns a connector command line into
 * one that runs it with stdout on `outputFile`; `snapshot` makes the bounded
 * copy at `boundedFile`. `close` deletes everything the run left behind.
 */
export interface OpenRun {
  dir: string;
  /** The run's Unix user, or null where the provider has no real users. */
  user: string | null;
  /**
   * Options for the API's own file and exec calls for this run: as root,
   * and pinned to the sandbox the run was set up in.
   */
  owner: { asRoot: true; expectSandboxId?: string } | undefined;
  outputFile: string;
  boundedFile: string;
  /** Where to write the input whose final path is `input` (isolated: the root-only stage). */
  stagePath(input: string): string;
  launch(inputs: string[], command: string): string;
  snapshot(maxBytes: number): string;
  /** Throws when cleanup could not prove the run is gone (isolated only). */
  close(): Promise<void>;
}

/** The run's cleanup failed: the box may still hold its credential or code. */
export class RunCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCleanupError";
  }
}

/** Boxes whose template passed the tool preflight, per process. */
const preflighted = new Set<string>();

/**
 * Check, once per box, that the template has every tool run isolation needs.
 * A template without them cannot isolate a run, and every run would fail at
 * setup; this says which tool is missing, in the log and in the error.
 */
async function preflight(ctx: SandboxExecContext): Promise<void> {
  if (preflighted.has(ctx.sessionKey)) return;
  const result = await getSandboxProvider().exec(ctx, preflightScript(), {
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
  preflighted.add(ctx.sessionKey);
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
  preflighted.delete(key);
  await getSandboxProvider().destroySession?.(key);
}

/**
 * Open a run: on E2B a fresh Unix user, its directories and nothing else
 * (see run-isolation.ts for the layout and why root never opens a path the
 * run user controls); elsewhere a plain directory, as before.
 */
export async function openRun(ctx: SandboxExecContext): Promise<OpenRun> {
  const provider = getSandboxProvider();
  const runId = randomBytes(8).toString("hex");

  if (!runsIsolated()) {
    const dir = path.posix.join(provider.scratch(ctx), "connector-runs", runId);
    const outputFile = path.posix.join(dir, "out.jsonl");
    const boundedFile = path.posix.join(dir, "out.bounded.jsonl");
    await provider.exec(ctx, `mkdir -p ${shellQuote(dir)}`, {
      timeoutMs: 30_000,
    });
    return {
      dir,
      user: null,
      owner: undefined,
      outputFile,
      boundedFile,
      stagePath: input => input,
      launch: (_inputs, command) => `${command} > ${shellQuote(outputFile)}`,
      snapshot: maxBytes =>
        `if test -f ${shellQuote(outputFile)}; then head -c ${maxBytes + 1} ${shellQuote(outputFile)} > ${shellQuote(boundedFile)} && wc -c < ${shellQuote(boundedFile)}; else echo missing; fi`,
      close: async () => {
        await provider
          .exec(ctx, `rm -rf ${shellQuote(dir)}`, { timeoutMs: 30_000 })
          .catch(error =>
            logger.error("Failed to clean a connector run directory", {
              error,
              runDir: dir,
            }),
          );
      },
    };
  }

  await preflight(ctx);
  let layout: RunLayout | null = null;
  let pinned: string | undefined;
  let lastError = "";
  // A random UID can collide with one in use; a fresh name and UID fixes it.
  for (let attempt = 0; attempt < 3 && !layout; attempt++) {
    const candidate = runLayout(
      runId,
      `mkc${randomBytes(6).toString("hex")}`,
      randomInt(200_000, 2_000_000_000),
      randomInt(200_000, 2_000_000_000),
    );
    const setup = await provider.exec(ctx, setupScript(candidate), {
      timeoutMs: 30_000,
      asRoot: true,
    });
    if (setup.exitCode === 0) {
      layout = candidate;
      pinned = setup.sandboxId;
    } else lastError = (setup.stderr || setup.stdout).trim().slice(0, 2000);
  }
  if (!layout) {
    throw new Error(
      `Could not create an isolated user for the connector run${lastError ? `: ${lastError}` : "."}`,
    );
  }

  const l = layout;
  return {
    dir: l.dir,
    user: l.user,
    owner: { asRoot: true, expectSandboxId: pinned },
    outputFile: l.outputFile,
    boundedFile: l.boundedFile,
    stagePath: input => stagedPath(l, input),
    launch: (inputs, command) => launchScript(l, inputs, command),
    snapshot: maxBytes => snapshotScript(l, maxBytes),
    close: async () => {
      let detail: string;
      try {
        const result = await provider.exec(ctx, cleanupScript(l), {
          timeoutMs: 60_000,
          asRoot: true,
          expectSandboxId: pinned,
        });
        if (result.exitCode === 0 && !result.timedOut) return;
        detail = result.timedOut
          ? "cleanup timed out"
          : result.exitCode === CLEANUP_SURVIVORS_EXIT
            ? "the run's processes would not die"
            : (result.stderr || `exit ${result.exitCode}`).slice(0, 500);
      } catch (error) {
        // The box itself is gone (killed under the run, e.g. by another
        // run's failed cleanup): so is everything the run left in it.
        if (isSandboxGone(error)) return;
        detail = error instanceof Error ? error.message : String(error);
      }
      logger.error("Failed to remove a connector run", {
        runDir: l.dir,
        user: l.user,
        detail,
      });
      throw new RunCleanupError(`Connector run cleanup failed: ${detail}`);
    },
  };
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
 */
export async function runConnectorCommand(input: {
  ctx: SandboxExecContext;
  runtimeId: string;
  connectorDir: string;
  command: ConnectorCommand;
  config?: Record<string, unknown>;
  catalog?: Record<string, unknown>;
  state?: Record<string, unknown> | unknown[];
  maxIterations?: number;
  timeoutMs?: number;
  entry?: string;
  /**
   * Called when the run's cleanup failed. The result still returns; the
   * caller decides what the box is worth now (a lease kills it).
   */
  onCleanupFailure?: (reason: string) => void;
}): Promise<RunResult> {
  const provider = getSandboxProvider();
  const { ctx, command } = input;
  const run = await openRun(ctx);
  const runDir = run.dir;
  const boundedOutputPath = run.boundedFile;
  const encoder = new TextEncoder();

  const args = [
    command,
    "--connector",
    path.posix.join(input.connectorDir, input.entry ?? "connector.ts"),
  ];

  try {
    const inputs: string[] = [];
    for (const [name, value] of [
      ["config", input.config],
      ["catalog", input.catalog],
      ["state", input.state],
    ] as const) {
      if (value === undefined) continue;
      const file = path.posix.join(runDir, `${name}.json`);
      // Isolated runs: written into the root-only stage, handed to the run
      // user and moved to `file` only at launch, so no other run can open
      // it while it still has the mode the write gave it.
      await writeBoxFile(
        ctx,
        run.stagePath(file),
        encoder.encode(JSON.stringify(value)),
        run.owner,
      );
      inputs.push(file);
      args.push(`--${name}`, file);
    }
    if (input.maxIterations !== undefined) {
      args.push("--max-iterations", String(input.maxIterations));
    }

    const bin = path.posix.join(
      runtimeRoot(ctx, input.runtimeId),
      "node_modules",
      "@makoai",
      "connector-sdk",
      "bin",
      "mako-connector.js",
    );
    // stdout is opened by the API's own shell (root on E2B) on a file the
    // connector cannot reach by path; the connector only holds the descriptor.
    const command_ = run.launch(
      inputs,
      `${shellQuote(runtimeNode(ctx, input.runtimeId))} ${shellQuote(bin)} ${args.map(shellQuote).join(" ")}`,
    );

    const result = await provider.exec(ctx, command_, {
      ...run.owner,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Nothing is ADDED to the environment on purpose: a connector has no
      // business reading even what an app may read. What it does see is the
      // provider's own fixed allowlist (PATH, HOME, LANG, TERM and a couple
      // of non-interactive flags) — `env` is spread over that base, so this
      // omission is the whole of the story and the isolation is the
      // provider's, not this call's.
    });

    // Never read the connector's own file directly. `head` creates an immutable
    // snapshot of at most limit + 1 bytes inside the sandbox, even if malicious
    // connector code left a child process appending to stdout after it exited.
    const snapshot = await provider.exec(
      ctx,
      run.snapshot(MAX_CONNECTOR_PROTOCOL_BYTES),
      { ...run.owner, timeoutMs: 30_000 },
    );
    const sizeText = snapshot.stdout.trim();
    // Root opens the output file before an isolated connector starts, so it
    // exists whatever the connector did. Missing means the box under the run
    // was replaced: fail the chunk rather than report a short, empty success.
    if (sizeText === "missing" && run.user) {
      throw new Error(
        "The connector's output is missing: its box was replaced during the run.",
      );
    }
    if (sizeText !== "missing") {
      const outputBytes = Number(sizeText);
      if (!Number.isSafeInteger(outputBytes) || outputBytes < 0) {
        throw new Error("Could not determine the connector protocol size.");
      }
      if (outputBytes > MAX_CONNECTOR_PROTOCOL_BYTES) {
        throw new Error(
          `Connector protocol output exceeded the ${MAX_CONNECTOR_PROTOCOL_BYTES} byte limit. Reduce the page or batch size.`,
        );
      }
    }

    // A command that died before creating its output file is a failure with
    // stderr as the only evidence; that is more useful than a read error.
    const raw =
      sizeText === "missing"
        ? ""
        : new TextDecoder().decode(
            await (run.owner
              ? provider.readFile(ctx, boundedOutputPath, run.owner)
              : provider.readFile(ctx, boundedOutputPath)),
          );

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
        throw new Error(
          `Connector protocol output exceeded the ${MAX_CONNECTOR_PROTOCOL_MESSAGES} message limit. Reduce the page or batch size.`,
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
  } finally {
    // The credential was in this directory. A paused box snapshots its disk,
    // so leaving it would mean the key outlives the run inside a suspended VM.
    try {
      await run.close();
    } catch (error) {
      input.onCleanupFailure?.(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
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
