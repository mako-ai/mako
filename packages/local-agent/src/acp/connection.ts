/**
 * Spawns an ACP agent adapter and opens a long-lived client connection.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { promises as fs } from "node:fs";
import type { ClientConnection, ClientContext } from "@agentclientprotocol/sdk";
import type { AcpProviderId } from "./providers";
import type { ResolvedAdapterCommand } from "./resolve-command";
import {
  extractTerminalAuthLaunch,
  formatTerminalAuthCommand,
} from "./terminal-auth";
import {
  explainAdapterLaunchFailure,
  sanitizeAdapterStderrForUi,
} from "./connection-errors";
import { acpLog } from "./log";

export type AcpSdk = typeof import("@agentclientprotocol/sdk");

let sdkPromise: Promise<AcpSdk> | null = null;

export function loadAcpSdk(): Promise<AcpSdk> {
  if (!sdkPromise) {
    sdkPromise = import("@agentclientprotocol/sdk");
  }
  return sdkPromise;
}

export interface PermissionRequestPayload {
  sessionId: string;
  requestId: string;
  toolCall: unknown;
  options: unknown[];
}

export type PermissionHandler = (
  payload: PermissionRequestPayload,
) => Promise<{ outcome: "cancelled" | "selected"; optionId?: string }>;

export interface AcpAuthMethodInfo {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  /** Shell-ish command for UI copy/paste when type is terminal. */
  terminalCommand?: string;
  /** Raw terminal-auth launch from adapter _meta (when present). */
  terminalAuth?: {
    command: string;
    args: string[];
    label?: string;
  };
}

export interface AcpProviderConnection {
  providerId: AcpProviderId;
  child: ChildProcess;
  connection: ClientConnection;
  agent: ClientContext;
  protocolVersion: number;
  authMethods: AcpAuthMethodInfo[];
  authRequired: boolean;
  authenticated: boolean;
  /** Rolling stderr from the adapter process (for UI diagnostics). */
  lastStderr: string;
  close: () => void;
}

function nodeToWebStreams(child: ChildProcess): {
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
} {
  if (!child.stdin || !child.stdout) {
    throw new Error("ACP adapter stdio pipes are not available");
  }
  return {
    input: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    output: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  };
}

function adapterEnv(providerId: AcpProviderId): NodeJS.ProcessEnv {
  const allow = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_THINKING_DISPLAY",
    "CLAUDE_CODE_EXTRA_BODY",
    "MAX_THINKING_TOKENS",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  // Opus 4.7+ defaults thinking.display to "omitted" (empty agent_thought_chunk).
  // Opt into summarized so Chat can render Thinking blocks like native Mako.
  if (providerId === "claude" && !env.CLAUDE_CODE_THINKING_DISPLAY) {
    env.CLAUDE_CODE_THINKING_DISPLAY = "summarized";
  }
  return env;
}

export async function openProviderConnection(options: {
  providerId: AcpProviderId;
  launch: ResolvedAdapterCommand;
  onPermission: PermissionHandler;
}): Promise<AcpProviderConnection> {
  const acp = await loadAcpSdk();
  const { providerId, launch, onPermission } = options;

  const child = spawn(launch.command, launch.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: adapterEnv(providerId),
    windowsHide: true,
  });

  let lastStderr = "";
  child.stderr?.on("data", (buf: Buffer) => {
    const text = buf.toString("utf8").trim();
    if (text) {
      lastStderr = `${lastStderr}\n${text}`.slice(-4000).trim();
      // Keep the object field in sync for status/diagnostics.
      if (connectionHolder) connectionHolder.lastStderr = lastStderr;
      acpLog.info("ACP adapter stderr", {
        providerId,
        text: text.slice(0, 2000),
      });
    }
  });

  child.on("exit", (code, signal) => {
    acpLog.info("ACP adapter exited", { providerId, code, signal });
  });

  // Filled after connect so stderr handler can update it.
  let connectionHolder: AcpProviderConnection | null = null;

  const { input, output } = nodeToWebStreams(child);
  const stream = acp.ndJsonStream(input, output);

  let permissionSeq = 0;

  const connection = acp
    .client({ name: "mako-local-agent" })
    .onRequest(acp.methods.client.session.requestPermission, async ctx => {
      permissionSeq += 1;
      const requestId = `perm_${Date.now()}_${permissionSeq}`;
      const params = ctx.params as {
        sessionId?: string;
        toolCall?: unknown;
        options?: unknown[];
      };
      const decision = await onPermission({
        sessionId: String(params.sessionId || ""),
        requestId,
        toolCall: params.toolCall,
        options: Array.isArray(params.options) ? params.options : [],
      });
      if (decision.outcome === "cancelled" || !decision.optionId) {
        return { outcome: { outcome: "cancelled" as const } };
      }
      return {
        outcome: {
          outcome: "selected" as const,
          optionId: decision.optionId,
        },
      };
    })
    // session/update notifications are consumed via ActiveSession.nextUpdate()
    // while a prompt is running — avoid a parallel fan-out that would double-emit.
    .onRequest(acp.methods.client.fs.readTextFile, async ctx => {
      const params = ctx.params as {
        path: string;
        line?: number | null;
        limit?: number | null;
      };
      const content = await fs.readFile(params.path, "utf8");
      if (params.line == null && params.limit == null) {
        return { content };
      }
      const lines = content.split("\n");
      const start = Math.max(0, (params.line ?? 1) - 1);
      const end =
        params.limit != null ? start + params.limit : Number.POSITIVE_INFINITY;
      return { content: lines.slice(start, end).join("\n") };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, async ctx => {
      const params = ctx.params as { path: string; content: string };
      await fs.writeFile(params.path, params.content, "utf8");
      return {};
    })
    .connect(stream);

  const agent = connection.agent;
  let initResult;
  try {
    initResult = await agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: {
        name: "mako-local-agent",
        version: "0.1.0",
      },
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        // Claude ACP advertises terminal login only when the client opts in.
        auth: {
          terminal: true,
        },
        _meta: {
          "terminal-auth": true,
        },
      },
    });
  } catch (error) {
    const tip = explainAdapterLaunchFailure(lastStderr);
    const stderrUi = sanitizeAdapterStderrForUi(lastStderr);
    const detail = tip
      ? `\n${tip}`
      : stderrUi
        ? ` Adapter stderr: ${stderrUi.slice(-800)}`
        : "";
    const base =
      error instanceof Error ? error.message : "ACP initialize failed";
    try {
      connection.close?.();
    } catch {
      // ignore
    }
    if (!child.killed) child.kill("SIGTERM");
    throw new Error(`${base}${detail ? `.${detail}` : ""}`.trim());
  }

  const authMethods: AcpAuthMethodInfo[] = Array.isArray(initResult.authMethods)
    ? initResult.authMethods.map(m => {
        const raw = m as {
          id?: string;
          name?: string;
          description?: string;
          type?: string;
          args?: unknown;
          _meta?: unknown;
        };
        const launch = extractTerminalAuthLaunch(raw);
        return {
          id: String(raw.id || ""),
          name: raw.name ?? undefined,
          description: raw.description ?? undefined,
          type: raw.type ?? (launch ? "terminal" : undefined),
          terminalCommand: launch
            ? formatTerminalAuthCommand(launch)
            : undefined,
          terminalAuth: launch
            ? {
                command: launch.command,
                args: launch.args,
                label: launch.label,
              }
            : undefined,
        };
      })
    : [];

  connectionHolder = {
    providerId,
    child,
    connection,
    agent,
    protocolVersion: Number(initResult.protocolVersion ?? acp.PROTOCOL_VERSION),
    authMethods,
    authRequired: authMethods.length > 0,
    authenticated: authMethods.length === 0,
    lastStderr,
    close: () => {
      try {
        connection.close?.();
      } catch {
        // ignore
      }
      if (!child.killed) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 2000).unref?.();
      }
    },
  };
  return connectionHolder;
}
