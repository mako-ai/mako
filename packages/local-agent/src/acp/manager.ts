/**
 * Session manager: one ACP adapter process per provider, many sessions.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type { ActiveSession } from "@agentclientprotocol/sdk";
import {
  openProviderConnection,
  type AcpProviderConnection,
  loadAcpSdk,
} from "./connection";
import {
  ACP_PROVIDERS,
  ACP_PROVIDER_IDS,
  isAcpProviderId,
  type AcpProviderId,
} from "./providers";
import { resolveAdapterCommand } from "./resolve-command";
import { shouldAutoApprovePermission } from "./permissions";
import type {
  AcpBridgeEvent,
  AcpProviderStatus,
  AcpSessionInfo,
  AcpStatusResponse,
  CreateAcpSessionRequest,
  PermissionResponseRequest,
} from "./types";
import { acpLog } from "./log";

type Listener = (event: AcpBridgeEvent) => void;

/** Cap per-session replay buffer so long sessions don't unbounded-grow. */
const MAX_EVENT_LOG = 4000;

interface PendingPermission {
  resolve: (value: {
    outcome: "cancelled" | "selected";
    optionId?: string;
  }) => void;
  sessionId: string;
  toolCall: unknown;
  options: unknown[];
  createdAt: number;
}

interface ManagedSession {
  info: AcpSessionInfo;
  active: ActiveSession | null;
  busy: boolean;
  listeners: Set<Listener>;
  /** Transcript/events for SSE reconnect replay (in-memory for process lifetime). */
  eventLog: AcpBridgeEvent[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultCwd(): string {
  return process.env.MAKO_ACP_DEFAULT_CWD?.trim() || homedir();
}

function normalizeBearerAuth(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

export class AcpSessionManager {
  private connections = new Map<AcpProviderId, AcpProviderConnection>();
  private sessions = new Map<string, ManagedSession>();
  private pendingPermissions = new Map<string, PendingPermission>();
  /** Global listeners (all sessions) — used by tests. */
  private globalListeners = new Set<Listener>();

  getStatus(): AcpStatusResponse {
    const providers: AcpProviderStatus[] = ACP_PROVIDER_IDS.map(id => {
      const def = ACP_PROVIDERS[id];
      const launch = resolveAdapterCommand(def);
      const conn = this.connections.get(id);
      return {
        id,
        label: def.label,
        description: def.description,
        authProduct: def.authProduct,
        installHint: def.installHint,
        adapterCommand: launch
          ? [launch.command, ...launch.args].join(" ")
          : null,
        adapterFound: Boolean(launch),
        connected: Boolean(conn),
        authRequired: conn?.authRequired ?? false,
        authMethods: conn?.authMethods ?? [],
      };
    });

    return {
      available: true,
      defaultCwd: defaultCwd(),
      providers,
    };
  }

  listSessions(): AcpSessionInfo[] {
    return [...this.sessions.values()]
      .map(s => ({ ...s.info, busy: s.busy }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSession(sessionId: string): AcpSessionInfo | null {
    const s = this.sessions.get(sessionId);
    return s ? { ...s.info, busy: s.busy } : null;
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown ACP session: ${sessionId}`);
    }
    session.listeners.add(listener);
    return () => {
      session.listeners.delete(listener);
    };
  }

  /**
   * Subscribe and immediately replay the in-memory transcript/event log.
   * Attach-before-replay with a frozen end index so concurrent live events
   * are delivered once (via the listener) and not duplicated by replay.
   */
  subscribeWithReplay(sessionId: string, listener: Listener): () => void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown ACP session: ${sessionId}`);
    }
    session.listeners.add(listener);
    const end = session.eventLog.length;
    for (let i = 0; i < end; i++) {
      try {
        listener(session.eventLog[i]!);
      } catch (error) {
        acpLog.error("ACP session replay listener failed", {
          error: String(error),
          sessionId,
        });
      }
    }
    return () => {
      session.listeners.delete(listener);
    };
  }

  /**
   * Events recorded for this session (for SSE backlog replay). Excludes
   * permission_request — those are only meaningful while a request is pending.
   */
  getEventLog(sessionId: string): AcpBridgeEvent[] {
    const session = this.sessions.get(sessionId);
    return session ? [...session.eventLog] : [];
  }

  subscribeAll(listener: Listener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  private record(sessionId: string, event: AcpBridgeEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Permission prompts are ephemeral; replaying them on reconnect is wrong.
    if (event.type === "permission_request") return;
    session.eventLog.push(event);
    if (session.eventLog.length > MAX_EVENT_LOG) {
      session.eventLog.splice(0, session.eventLog.length - MAX_EVENT_LOG);
    }
  }

  private emit(sessionId: string, event: AcpBridgeEvent): void {
    this.record(sessionId, event);
    const session = this.sessions.get(sessionId);
    if (session) {
      for (const listener of session.listeners) {
        try {
          listener(event);
        } catch (error) {
          acpLog.error("ACP session listener failed", {
            error: String(error),
            sessionId,
          });
        }
      }
    }
    for (const listener of this.globalListeners) {
      try {
        listener(event);
      } catch (error) {
        acpLog.error("ACP global listener failed", {
          error: String(error),
          sessionId,
        });
      }
    }
  }

  private async ensureConnection(
    providerId: AcpProviderId,
  ): Promise<AcpProviderConnection> {
    const existing = this.connections.get(providerId);
    if (existing && !existing.child.killed) {
      return existing;
    }

    const def = ACP_PROVIDERS[providerId];
    const launch = resolveAdapterCommand(def);
    if (!launch) {
      throw new Error(
        `${def.label} adapter not found. ${def.installHint}`,
      );
    }

    acpLog.info("Starting ACP adapter", {
      providerId,
      command: launch.command,
      args: launch.args,
      via: launch.via,
    });

    const conn = await openProviderConnection({
      providerId,
      launch,
      onPermission: payload => this.handlePermission(payload),
    });

    this.connections.set(providerId, conn);
    conn.child.on("exit", () => {
      if (this.connections.get(providerId) === conn) {
        this.connections.delete(providerId);
      }
    });
    return conn;
  }

  private handlePermission(payload: {
    sessionId: string;
    requestId: string;
    toolCall: unknown;
    options: unknown[];
  }): Promise<{ outcome: "cancelled" | "selected"; optionId?: string }> {
    const auto = shouldAutoApprovePermission({
      toolCall: payload.toolCall,
      options: payload.options,
    });
    if (auto) {
      acpLog.info("Auto-approving ACP permission", {
        sessionId: payload.sessionId,
        optionId: auto.optionId,
      });
      return Promise.resolve({
        outcome: "selected",
        optionId: auto.optionId,
      });
    }

    const timeoutMs = 5 * 60 * 1000;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(payload.requestId);
        resolve({ outcome: "cancelled" });
      }, timeoutMs);

      this.pendingPermissions.set(payload.requestId, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        sessionId: payload.sessionId,
        toolCall: payload.toolCall,
        options: payload.options,
        createdAt: Date.now(),
      });

      this.emit(payload.sessionId, {
        type: "permission_request",
        sessionId: payload.sessionId,
        requestId: payload.requestId,
        toolCall: payload.toolCall,
        options: payload.options,
        at: nowIso(),
      });
    });
  }

  async authenticate(
    providerId: AcpProviderId,
    methodId?: string,
  ): Promise<{ ok: true; methodId: string }> {
    const acp = await loadAcpSdk();
    const conn = await this.ensureConnection(providerId);
    const method =
      methodId ||
      conn.authMethods[0]?.id ||
      (conn.authMethods.length === 0 ? null : null);
    if (!method) {
      conn.authenticated = true;
      return { ok: true, methodId: "none" };
    }
    await conn.agent.request(acp.methods.agent.authenticate, {
      methodId: method,
    });
    conn.authenticated = true;
    return { ok: true, methodId: method };
  }

  async createSession(
    body: CreateAcpSessionRequest,
  ): Promise<AcpSessionInfo> {
    const providerId: AcpProviderId = isAcpProviderId(
      String(body.providerId || "claude"),
    )
      ? (body.providerId as AcpProviderId)
      : "claude";

    const cwd = resolvePath(body.cwd?.trim() || defaultCwd());
    const title =
      body.title?.trim() ||
      `${ACP_PROVIDERS[providerId].label} · ${cwd.split(/[/\\]/).pop() || cwd}`;

    const conn = await this.ensureConnection(providerId);
    if (conn.authRequired && !conn.authenticated) {
      // Best-effort: try first auth method (agent-login often opens a browser).
      try {
        await this.authenticate(providerId);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Authentication failed";
        throw new Error(
          `${ACP_PROVIDERS[providerId].label} requires sign-in (${ACP_PROVIDERS[providerId].authProduct}): ${message}`,
        );
      }
    }

    const attachMakoMcp = Boolean(
      body.attachMakoMcp && body.mcpUrl?.trim() && body.mcpAuthorization?.trim(),
    );
    const mcpServerName = (
      body.mcpServerName?.trim() || "mako-workspace"
    ).replace(/[^a-zA-Z0-9_-]/g, "-");
    const makoToolPrefix = `mcp__${mcpServerName}__`;

    // For Claude ACP, allowlist our attached server so the Agent SDK does not
    // prompt on every Mako tool (acceptEdits does NOT cover MCP).
    let builder =
      attachMakoMcp && providerId === "claude"
        ? conn.agent.buildSession({
            cwd,
            mcpServers: [],
            _meta: {
              claudeCode: {
                options: {
                  allowedTools: [`${makoToolPrefix}*`, `mcp__${mcpServerName}`],
                  // Prefer the Bearer-authenticated workspace MCP we attach —
                  // not Claude.ai's optional "Mako" connector (needs separate OAuth).
                  systemPrompt: {
                    type: "preset",
                    preset: "claude_code",
                    append: `\n\n# Mako workspace\nYou are running inside Mako. Workspace databases, SQL, connections, consoles, and apps are available via the already-authenticated MCP server \`${mcpServerName}\` (tools named \`${makoToolPrefix}*\`, e.g. list_connections, sql_execute_query, run_console). Prefer those tools. Do not ask the user to run \`claude mcp\` or authorize a Claude.ai "Mako" connector — that is a different, unauthenticated connector. Do not use Gmail/Drive for questions about data in Mako.`,
                  },
                },
              },
            },
          })
        : conn.agent.buildSession(cwd);
    if (attachMakoMcp) {
      const mcpUrl = String(body.mcpUrl).trim();
      const authorization = normalizeBearerAuth(
        String(body.mcpAuthorization),
      );
      builder = builder.withMcpServer({
        type: "http",
        name: mcpServerName,
        url: mcpUrl,
        headers: [{ name: "Authorization", value: authorization }],
      });
      acpLog.info("Attaching Mako MCP to ACP session", {
        providerId,
        mcpUrl,
        mcpServerName,
      });
    }

    const active = await builder.start();
    const id = active.sessionId;
    const info: AcpSessionInfo = {
      id,
      providerId,
      title,
      cwd,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      busy: false,
      makoMcpAttached: attachMakoMcp,
    };

    this.sessions.set(id, {
      info,
      active,
      busy: false,
      listeners: new Set(),
      eventLog: [],
    });

    acpLog.info("Created ACP session", {
      sessionId: id,
      providerId,
      cwd,
      makoMcpAttached: attachMakoMcp,
    });
    return info;
  }

  async prompt(
    sessionId: string,
    text: string,
  ): Promise<{ stopReason: string }> {
    const session = this.sessions.get(sessionId);
    if (!session?.active) {
      throw new Error(`Unknown ACP session: ${sessionId}`);
    }
    if (session.busy) {
      throw new Error("Session is already processing a prompt");
    }
    if (!text.trim()) {
      throw new Error("Prompt text is required");
    }

    session.busy = true;
    session.info.busy = true;
    session.info.updatedAt = nowIso();

    // Persist the user turn on the bridge so SSE reconnect can rebuild the
    // transcript. Claude keeps context even when the UI does not.
    this.emit(sessionId, {
      type: "session_update",
      sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: text.trim() },
      },
      at: nowIso(),
    });

    try {
      const promptPromise = session.active.prompt(text);
      for (;;) {
        const message = await session.active.nextUpdate();
        if (message.kind === "session_update") {
          this.emit(sessionId, {
            type: "session_update",
            sessionId,
            update: message.update,
            at: nowIso(),
          });
        } else {
          this.emit(sessionId, {
            type: "turn_done",
            sessionId,
            stopReason: message.stopReason,
            at: nowIso(),
          });
          await promptPromise;
          return { stopReason: message.stopReason };
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "ACP prompt failed";
      this.emit(sessionId, {
        type: "error",
        sessionId,
        message,
        at: nowIso(),
      });
      throw error;
    } finally {
      session.busy = false;
      session.info.busy = false;
      session.info.updatedAt = nowIso();
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown ACP session: ${sessionId}`);
    }
    const acp = await loadAcpSdk();
    const conn = this.connections.get(session.info.providerId);
    if (!conn) return;
    await conn.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  respondPermission(
    sessionId: string,
    requestId: string,
    body: PermissionResponseRequest,
  ): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`Unknown permission request: ${requestId}`);
    }
    if (pending.sessionId && pending.sessionId !== sessionId) {
      throw new Error("Permission request does not belong to this session");
    }
    this.pendingPermissions.delete(requestId);
    if (body.outcome === "cancelled") {
      pending.resolve({ outcome: "cancelled" });
      return;
    }
    if (!body.optionId) {
      throw new Error("optionId is required when outcome is selected");
    }
    pending.resolve({ outcome: "selected", optionId: body.optionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Cancel any pending permissions for this session.
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.sessionId === sessionId) {
        this.pendingPermissions.delete(id);
        pending.resolve({ outcome: "cancelled" });
      }
    }

    try {
      const acp = await loadAcpSdk();
      const conn = this.connections.get(session.info.providerId);
      if (conn) {
        await conn.agent
          .request(acp.methods.agent.session.close, { sessionId })
          .catch(() => undefined);
      }
    } finally {
      session.active?.dispose();
      this.sessions.delete(sessionId);
    }
  }

  /** Test helper — inject a pre-built session id label. */
  nextLocalId(): string {
    return randomUUID();
  }

  shutdown(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      void this.closeSession(sessionId);
    }
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
  }
}

/** Process-wide singleton used by HTTP routes. */
export const acpSessionManager = new AcpSessionManager();
