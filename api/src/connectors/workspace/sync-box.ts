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
import path from "node:path";
import {
  getSandboxProvider,
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
  return { sessionKey: `connector-sync:${workspaceId}` };
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
  return path.posix.join(
    getSandboxProvider().scratch(ctx),
    "connector-runtime",
    // A root-owned tree lives apart from the old user-owned one. A box that
    // ran connectors before per-run users existed may hold a runtime a
    // connector could have rewritten; its marker would still match, so the
    // isolated layout never trusts it and installs afresh.
    ...(runsIsolated() ? ["isolated"] : []),
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

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

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
  files: () => Promise<Map<string, Uint8Array>>;
  ensureRuntime: (ctx: SandboxExecContext) => Promise<string>;
}): Promise<{ runtimeId: string; dir: string }> {
  const runtimeId = await input.ensureRuntime(input.ctx);
  const dir = await materializeConnector({
    ctx: input.ctx,
    runtimeId,
    slug: input.slug,
    sourceSha: input.hash,
    files: input.files,
  });
  return { runtimeId, dir };
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
chmod a+rX "$(dirname "$runtime_root")" "$(dirname "$(dirname "$runtime_root")")"`
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
 * `dir` holds the run's config, catalog, state and output. `wrap` turns a
 * command line into one that runs the connector as the run's own user.
 * `close` deletes everything the run left behind; it never throws.
 */
export interface OpenRun {
  dir: string;
  /** The run's Unix user, or null where the provider has no real users. */
  user: string | null;
  /** Options for the API's own file and exec calls inside `dir`. */
  owner: { asRoot: true } | undefined;
  wrap(command: string): string;
  /** Hand files root wrote into `dir` to the run user, read-only. */
  handOver(files: string[]): string;
  close(): Promise<void>;
}

const PATH_FOR_ROOT =
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Create a run directory, and on E2B a Unix user that alone can read it.
 *
 * Why a user and not just 0700: every command in the box used to run as the
 * template user, so a 0700 directory was still readable by every other run in
 * the same box. A connector could list `connector-runs/`, read a concurrent
 * run's `config.json` (another connection's credential), or leave a process
 * behind that read every later run's. Now:
 *
 * - `connector-runs/` is root-owned 0711: runs can enter their own directory
 *   but cannot list anyone else's;
 * - each run directory is 0700 and owned by a user created for the run, with
 *   a random UID so a deleted user's leftover files never belong to a later
 *   run;
 * - the connector is started with `runuser`, so it has no rights over other
 *   runs' files or processes;
 * - `close` kills every process of that user, deletes its files in the
 *   world-writable directories, and deletes the user.
 */
export async function openRun(ctx: SandboxExecContext): Promise<OpenRun> {
  const provider = getSandboxProvider();
  const runsRoot = path.posix.join(provider.scratch(ctx), "connector-runs");
  const runId = randomBytes(8).toString("hex");
  const dir = path.posix.join(runsRoot, runId);

  if (!runsIsolated()) {
    await provider.exec(ctx, `mkdir -p ${shellQuote(dir)}`, {
      timeoutMs: 30_000,
    });
    return {
      dir,
      user: null,
      owner: undefined,
      wrap: command => command,
      handOver: () => "true",
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

  let user = "";
  let lastError: unknown;
  // A random UID can collide with one in use; a fresh name and UID fixes it.
  for (let attempt = 0; attempt < 3 && !user; attempt++) {
    const candidate = `mkc${randomBytes(6).toString("hex")}`;
    const uid = randomInt(200_000, 2_000_000_000);
    const setup = await provider.exec(
      ctx,
      `set -eu
${PATH_FOR_ROOT}
runs=${shellQuote(runsRoot)}
dir=${shellQuote(dir)}
user=${shellQuote(candidate)}
command -v runuser >/dev/null
command -v useradd >/dev/null
# Only a root-owned directory may hold run directories. Anything else here was
# made before runs were isolated, or by a connector, and is not trusted.
if [ -L "$runs" ] || { [ -e "$runs" ] && [ "$(stat -c %u "$runs")" != 0 ]; }; then rm -rf "$runs"; fi
mkdir -p "$runs"
chown root:root "$runs"
chmod 0711 "$runs"
# useradd takes a lock on /etc/passwd; concurrent runs retry it.
n=0
until err=$(useradd -M -U -u ${uid} -d "$dir" -s /usr/sbin/nologin "$user" 2>&1); do
  n=$((n + 1))
  if [ "$n" -ge 20 ]; then echo "$err" >&2; exit 1; fi
  sleep 0.2
done
if ! { mkdir -m 0700 "$dir" && chown "$user:$user" "$dir"; }; then
  userdel "$user" 2>/dev/null || true
  exit 1
fi`,
      { timeoutMs: 30_000, asRoot: true },
    );
    if (setup.exitCode === 0) user = candidate;
    else lastError = (setup.stderr || setup.stdout).trim().slice(0, 2000);
  }
  if (!user) {
    throw new Error(
      `Could not create an isolated user for the connector run${lastError ? `: ${String(lastError)}` : "."}`,
    );
  }

  const owner = { asRoot: true } as const;
  return {
    dir,
    user,
    owner,
    wrap: command =>
      `cd ${shellQuote(dir)} && runuser -u ${shellQuote(user)} -- env HOME=${shellQuote(dir)} TMPDIR=${shellQuote(dir)} ${command}`,
    handOver: files =>
      files.length === 0
        ? "true"
        : `chown ${shellQuote(`${user}:${user}`)} ${files.map(shellQuote).join(" ")} && chmod 0400 ${files.map(shellQuote).join(" ")}`,
    close: async () => {
      await provider
        .exec(
          ctx,
          `${PATH_FOR_ROOT}
user=${shellQuote(user)}
pkill -KILL -u "$user" 2>/dev/null || true
rm -rf ${shellQuote(dir)}
find /tmp /var/tmp /dev/shm -xdev -user "$user" -exec rm -rf {} + 2>/dev/null || true
userdel "$user" 2>/dev/null || { sleep 0.5; pkill -KILL -u "$user" 2>/dev/null || true; userdel -f "$user"; }`,
          { timeoutMs: 30_000, asRoot: true },
        )
        .then(result => {
          if (result.exitCode !== 0) {
            logger.error("Failed to remove a connector run user", {
              runDir: dir,
              user,
              stderr: result.stderr.slice(0, 500),
            });
          }
        })
        .catch(error =>
          logger.error("Failed to clean a connector run directory", {
            error,
            runDir: dir,
            user,
          }),
        );
    },
  };
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
}): Promise<RunResult> {
  const provider = getSandboxProvider();
  const { ctx, command } = input;
  const run = await openRun(ctx);
  const runDir = run.dir;
  const outputPath = path.posix.join(runDir, "out.jsonl");
  const boundedOutputPath = path.posix.join(runDir, "out.bounded.jsonl");
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
      await writeBoxFile(
        ctx,
        file,
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
    const connectorCommand = run.wrap(
      `${shellQuote(runtimeNode(ctx, input.runtimeId))} ${shellQuote(bin)} ${args.map(shellQuote).join(" ")}`,
    );
    // The redirect is opened by the API's own shell (root on E2B), so the
    // output file sits in the run directory whoever the connector runs as.
    const command_ = run.user
      ? `${run.handOver(inputs)} && ${connectorCommand} > ${shellQuote(outputPath)}`
      : `${connectorCommand} > ${shellQuote(outputPath)}`;

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
      `if test -f ${shellQuote(outputPath)}; then head -c ${MAX_CONNECTOR_PROTOCOL_BYTES + 1} ${shellQuote(outputPath)} > ${shellQuote(boundedOutputPath)} && wc -c < ${shellQuote(boundedOutputPath)}; else echo missing; fi`,
      { ...run.owner, timeoutMs: 30_000 },
    );
    const sizeText = snapshot.stdout.trim();
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
    await run.close();
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
