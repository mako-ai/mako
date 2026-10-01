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
 * 2. A CREDENTIAL LIVES ONLY AS LONG AS THE COMMAND. It is written to a
 *    per-run directory and deleted in a `finally`, because an E2B box that
 *    pauses snapshots its disk.
 * 3. NOTHING BUT A BOUNDED PROTOCOL COMES BACK. stdout is redirected to a file
 *    because `exec`'s output cap would truncate legitimate records. A bounded
 *    snapshot is made before that file crosses into the API process, so tenant
 *    code still cannot turn a large batch into an API heap exhaustion.
 */
import path from "node:path";
import {
  getSandboxProvider,
  type SandboxExecContext,
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
export const CONNECTOR_NODE_VERSION = "24.20.0";
const CONNECTOR_NODE_SHA256 = {
  arm64: "5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7",
  x64: "2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2",
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
    "versions",
    runtimeId,
  );
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
  files: Map<string, Uint8Array>;
}): Promise<string> {
  const { ctx, runtimeId, slug, sourceSha, files } = input;
  const provider = getSandboxProvider();
  const dir = connectorDir(ctx, runtimeId, slug, sourceSha);

  const marker = path.posix.join(dir, ".materialized");
  const check = await provider.exec(
    ctx,
    `test -f ${shellQuote(marker)} && echo yes || echo no`,
    {
      timeoutMs: 30_000,
    },
  );
  if (check.stdout.trim() === "yes") return dir;

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
    await provider.writeFile(ctx, target, bytes);
  }
  await provider.writeFile(ctx, marker, new TextEncoder().encode(sourceSha));
  return dir;
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
    { timeoutMs: 30_000 },
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
    await provider.writeFile(ctx, path.posix.join(base, relative), bytes);
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
"$runtime_node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 6)) process.exit(1)'`,
    { timeoutMs: 120_000 },
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
  await provider.writeFile(
    ctx,
    path.posix.join(root, ".materialized"),
    new TextEncoder().encode(runtimeId),
  );
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
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const runDir = path.posix.join(
    getSandboxProvider().scratch(ctx),
    "connector-runs",
    runId,
  );
  const outputPath = path.posix.join(runDir, "out.jsonl");
  const boundedOutputPath = path.posix.join(runDir, "out.bounded.jsonl");
  const encoder = new TextEncoder();

  const args = [
    command,
    "--connector",
    path.posix.join(input.connectorDir, input.entry ?? "connector.ts"),
  ];

  try {
    await provider.exec(ctx, `mkdir -p ${shellQuote(runDir)}`, {
      timeoutMs: 30_000,
    });

    for (const [name, value] of [
      ["config", input.config],
      ["catalog", input.catalog],
      ["state", input.state],
    ] as const) {
      if (value === undefined) continue;
      const file = path.posix.join(runDir, `${name}.json`);
      await provider.writeFile(
        ctx,
        file,
        encoder.encode(JSON.stringify(value)),
      );
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
    const command_ = `${shellQuote(runtimeNode(ctx, input.runtimeId))} ${shellQuote(bin)} ${args.map(shellQuote).join(" ")} > ${shellQuote(outputPath)}`;

    const result = await provider.exec(ctx, command_, {
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
      { timeoutMs: 30_000 },
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
            await provider.readFile(ctx, boundedOutputPath),
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
    await provider
      .exec(ctx, `rm -rf ${shellQuote(runDir)}`, { timeoutMs: 30_000 })
      .catch(error =>
        logger.error("Failed to clean a connector run directory", {
          error,
          runDir,
        }),
      );
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
