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
 * 3. NOTHING BUT THE PROTOCOL COMES BACK. stdout is redirected to a file and
 *    parsed as JSON Lines; `exec` caps output, so a chatty connector would
 *    otherwise truncate its own records.
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
  slug: string,
  sourceSha: string,
): string {
  const scratch = getSandboxProvider().scratch(ctx);
  return path.posix.join(
    scratch,
    "connector-runtime",
    "connectors",
    `${slug}@${sourceSha}`,
  );
}

/** Where the SDK is placed so Node resolves `@makoai/connector-sdk` upward. */
function runtimeRoot(ctx: SandboxExecContext): string {
  return path.posix.join(
    getSandboxProvider().scratch(ctx),
    "connector-runtime",
  );
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
  slug: string;
  sourceSha: string;
  files: Map<string, Uint8Array>;
}): Promise<string> {
  const { ctx, slug, sourceSha, files } = input;
  const provider = getSandboxProvider();
  const dir = connectorDir(ctx, slug, sourceSha);

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

/** Is the SDK present in the box's runtime root? */
export async function hasConnectorRuntime(
  ctx: SandboxExecContext,
): Promise<boolean> {
  const provider = getSandboxProvider();
  const entry = path.posix.join(
    runtimeRoot(ctx),
    "node_modules",
    "@makoai",
    "connector-sdk",
    "package.json",
  );
  const result = await provider.exec(
    ctx,
    `test -f ${shellQuote(entry)} && echo yes || echo no`,
    {
      timeoutMs: 30_000,
    },
  );
  return result.stdout.trim() === "yes";
}

/** Install the SDK into the box's runtime root from a set of files. */
export async function installConnectorRuntime(
  ctx: SandboxExecContext,
  files: Map<string, Uint8Array>,
): Promise<void> {
  const provider = getSandboxProvider();
  const base = path.posix.join(
    runtimeRoot(ctx),
    "node_modules",
    "@makoai",
    "connector-sdk",
  );
  for (const [relative, bytes] of files) {
    await provider.writeFile(ctx, path.posix.join(base, relative), bytes);
  }
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
      runtimeRoot(ctx),
      "node_modules",
      "@makoai",
      "connector-sdk",
      "bin",
      "mako-connector.js",
    );
    const command_ = `node ${shellQuote(bin)} ${args.map(shellQuote).join(" ")} > ${shellQuote(outputPath)}`;

    const result = await provider.exec(ctx, command_, {
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Nothing is ADDED to the environment on purpose: a connector has no
      // business reading even what an app may read. What it does see is the
      // provider's own fixed allowlist (PATH, HOME, LANG, TERM and a couple
      // of non-interactive flags) — `env` is spread over that base, so this
      // omission is the whole of the story and the isolation is the
      // provider's, not this call's.
    });

    let raw = "";
    try {
      raw = new TextDecoder().decode(await provider.readFile(ctx, outputPath));
    } catch {
      // A command that died before creating its output file is a failure with
      // stderr as the only evidence; that is more useful than a read error.
      raw = "";
    }

    const messages: ProtocolMessage[] = [];
    const malformed: string[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
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
