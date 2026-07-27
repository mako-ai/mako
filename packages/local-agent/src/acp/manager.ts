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
import { assertAllowedMakoMcpUrl } from "./mako-mcp-url";
import { probeMakoMcpHttp } from "./mcp-probe";
import {
  hasCodexAuthFile,
  probeCodexLoginStatus,
  shouldAutoAuthenticateOnSessionNew,
} from "./codex-login-status";
import { buildMakoSystemPromptAppend } from "./mako-system-append";
import {
  acpReconnectMessage,
  explainAdapterLaunchFailure,
  isAcpConnectionClosedError,
  sanitizeAdapterStderrForUi,
  userFacingAcpError,
} from "./connection-errors";
import {
  defaultTerminalLoginLaunch,
  launchTerminalAuth,
} from "./terminal-auth";
import {
  currentModelFromConfigOptions,
  modelChoicesFromConfigOptions,
  parseConfigOptions,
  resolveModelConfigValue,
  type AcpConfigOptionSnapshot,
  type AcpModelChoice,
} from "./session-config";
import type {
  AcpAuthenticateResult,
  AcpBridgeEvent,
  AcpProviderStatus,
  AcpSessionInfo,
  AcpStatusResponse,
  AcpWarmModelsResponse,
  CreateAcpSessionRequest,
  PermissionResponseRequest,
} from "./types";
import { acpLog } from "./log";
import {
  DESKTOP_MCP_PATH,
  DESKTOP_MCP_SERVER_NAME,
} from "../desktop-bridge/mcp";
import {
  explainCodexModelFailure,
  isChatGptRejectedCodexModel,
  isCodexChatGptModelRejectedError,
  isForeignGatewayCodexModel,
  pickChatGptCompatibleCodexModel,
  pickSafeCodexModel,
} from "./codex-models";
import {
  ensureAdapterPackages,
  type AcpEnsureAdapterResult,
} from "./ensure-adapter";
import { applyNonClaudeGuidanceToPrompt } from "./prompt-guidance";

/** Keep in sync with `DEFAULT_AGENT_PORT` in server.ts (avoid circular import). */
const LOCAL_AGENT_PORT = 41720;

function isConnectionAlive(conn: AcpProviderConnection | undefined): boolean {
  if (!conn) return false;
  const child = conn.child;
  if (child.killed) return false;
  if (child.exitCode !== null) return false;
  if (child.signalCode) return false;
  return true;
}

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
  /** Latest session/configOptions snapshot from the adapter. */
  configOptions: AcpConfigOptionSnapshot[];
  /**
   * Mako system/workspace guidance. Claude gets it via systemPrompt.append;
   * Codex (and any provider without append) gets it once on the first prompt.
   */
  guidanceAppend: string;
  guidanceInjectedIntoPrompt: boolean;
}

interface ProviderModelCache {
  availableModels: AcpModelChoice[];
  currentModel: string | null;
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
  private lastAdapterError: string | null = null;
  /** Last-known model picker state per provider (survives session close). */
  private providerModels = new Map<AcpProviderId, ProviderModelCache>();
  /** Deduplicate concurrent `npm i -g` ensures per provider. */
  private ensureInFlight = new Map<
    AcpProviderId,
    Promise<AcpEnsureAdapterResult>
  >();
  /** Last forced ensure after a prompt/metadata failure (rate-limit). */
  private lastForceEnsureAt = new Map<AcpProviderId, number>();
  /** Deduplicate throwaway session/new model warmups. */
  private modelWarmInFlight = new Map<
    AcpProviderId,
    Promise<AcpWarmModelsResponse>
  >();
  /** Live ensure progress exposed on GET /acp/status. */
  private ensureStatus = new Map<
    AcpProviderId,
    {
      state: "idle" | "running" | "ok" | "error";
      message?: string;
      startedAt?: string;
      errorCode?: string;
    }
  >();

  private rememberProviderModels(
    providerId: AcpProviderId,
    configOptions: AcpConfigOptionSnapshot[],
  ): void {
    const availableModels = modelChoicesFromConfigOptions(configOptions);
    if (availableModels.length === 0) return;
    this.providerModels.set(providerId, {
      availableModels,
      currentModel: currentModelFromConfigOptions(configOptions),
    });
  }

  private applyConfigOptionsToSession(
    session: ManagedSession,
    rawConfigOptions: unknown,
  ): void {
    const configOptions = parseConfigOptions(rawConfigOptions);
    session.configOptions = configOptions;
    session.info.availableModels = modelChoicesFromConfigOptions(configOptions);
    session.info.currentModel = currentModelFromConfigOptions(configOptions);
    this.rememberProviderModels(session.info.providerId, configOptions);
  }

  getStatus(): AcpStatusResponse {
    const providers: AcpProviderStatus[] = ACP_PROVIDER_IDS.map(id => {
      const def = ACP_PROVIDERS[id];
      const launch = resolveAdapterCommand(def);
      const conn = this.connections.get(id);
      const models = this.providerModels.get(id);
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
        connected: isConnectionAlive(conn),
        authRequired: conn?.authRequired ?? false,
        // Sync file check only — avoid blocking GET /acp/status on `codex login status`.
        cliLoggedIn: id === "codex" ? hasCodexAuthFile() : undefined,
        authMethods: (conn?.authMethods ?? []).map(m => ({
          id: m.id,
          name: m.name,
          description: m.description,
          type: m.type,
          terminalCommand: m.terminalCommand,
        })),
        availableModels: models?.availableModels,
        currentModel: models?.currentModel ?? null,
      };
    });

    // Warm model catalogs in the background so Chat's picker shows real
    // Claude/Codex ids before the user starts a turn. Tests set
    // MAKO_ACP_DISABLE_BACKGROUND_WARM=1 so getStatus cannot spawn PATH
    // adapters (codex-acp) and keep the Node test process open.
    if (process.env.MAKO_ACP_DISABLE_BACKGROUND_WARM !== "1") {
      const warmOnly = process.env.MAKO_ACP_PROVIDER?.trim() as
        | AcpProviderId
        | undefined;
      for (const p of providers) {
        if (warmOnly && p.id !== warmOnly) continue;
        if (
          p.adapterFound &&
          (!p.availableModels || p.availableModels.length === 0) &&
          !this.modelWarmInFlight.has(p.id)
        ) {
          void this.ensureProviderModels(p.id).catch(error => {
            acpLog.info("Background ACP model warm failed", {
              providerId: p.id,
              error: String(error),
            });
          });
        }
      }
    }

    const ensureByProvider: AcpStatusResponse["ensureByProvider"] = {};
    for (const id of ACP_PROVIDER_IDS) {
      const st = this.ensureStatus.get(id);
      if (st) ensureByProvider[id] = st;
    }

    return {
      available: true,
      defaultCwd: defaultCwd(),
      providers,
      acpBridge: {
        version: 7,
        terminalAuth: true,
        mcpProbe: true,
        reconnect: true,
        sessionConfig: true,
        desktopMcp: true,
        hitlTools: true,
        adapterEnsure: true,
        modelWarm: true,
      },
      lastAdapterError: this.lastAdapterError,
      ensureByProvider,
    };
  }

  /**
   * Populate `availableModels` via a throwaway session/new (no Mako MCP).
   * Safe to call from status/warm endpoints and before model switches.
   */
  async ensureProviderModels(
    providerId: AcpProviderId,
  ): Promise<AcpWarmModelsResponse> {
    const cached = this.providerModels.get(providerId);
    if (cached?.availableModels?.length) {
      return {
        providerId,
        availableModels: cached.availableModels,
        currentModel: cached.currentModel,
        warmed: false,
      };
    }

    const existing = this.modelWarmInFlight.get(providerId);
    if (existing) return existing;

    const promise = (async (): Promise<AcpWarmModelsResponse> => {
      acpLog.info("Warming ACP model catalog", { providerId });
      const session = await this.createSessionInternal(
        {
          providerId,
          cwd: defaultCwd(),
          title: `${ACP_PROVIDERS[providerId].label} · model probe`,
          attachMakoMcp: false,
        },
        true,
      );
      const models = this.providerModels.get(providerId);
      try {
        await this.closeSession(session.id);
      } catch {
        // best-effort — cache already populated
      }
      return {
        providerId,
        availableModels: models?.availableModels ?? session.availableModels ?? [],
        currentModel: models?.currentModel ?? session.currentModel ?? null,
        warmed: true,
      };
    })()
      .catch(error => {
        acpLog.info("ACP model warm failed", {
          providerId,
          error: String(error),
        });
        const fallback = this.providerModels.get(providerId);
        return {
          providerId,
          availableModels: fallback?.availableModels ?? [],
          currentModel: fallback?.currentModel ?? null,
          warmed: false,
        };
      })
      .finally(() => {
        this.modelWarmInFlight.delete(providerId);
      });

    this.modelWarmInFlight.set(providerId, promise);
    return promise;
  }

  /**
   * Install/update ACP adapter (+ Codex CLI) via npm on this machine.
   * Called automatically on session/new; Chat can also invoke explicitly.
   */
  async ensureAdapter(
    providerId: AcpProviderId,
    options?: { force?: boolean },
  ): Promise<AcpEnsureAdapterResult> {
    const existing = this.ensureInFlight.get(providerId);
    if (existing) return existing;

    this.ensureStatus.set(providerId, {
      state: "running",
      message: `Installing/updating ${ACP_PROVIDERS[providerId].label} tools…`,
      startedAt: nowIso(),
    });

    const promise = ensureAdapterPackages(providerId, {
      force: options?.force,
    })
      .then(result => {
        if (result.updated) {
          // Drop any stale adapter process so the next connect uses the new bin.
          this.invalidateProvider(providerId, "adapter packages updated");
        }
        this.ensureStatus.set(providerId, {
          state: result.ok ? "ok" : "error",
          message: result.message,
          startedAt: this.ensureStatus.get(providerId)?.startedAt,
          errorCode: result.errorCode,
        });
        return result;
      })
      .catch(error => {
        const message =
          error instanceof Error ? error.message : "Failed to update adapter";
        this.ensureStatus.set(providerId, {
          state: "error",
          message,
          startedAt: this.ensureStatus.get(providerId)?.startedAt,
          errorCode: "npm_failed",
        });
        throw error;
      })
      .finally(() => {
        this.ensureInFlight.delete(providerId);
      });
    this.ensureInFlight.set(providerId, promise);
    return promise;
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
   * Live-only subscribe (no backlog). Chat turns use this so reconnecting the
   * SSE pipe does not paint prior agent_message chunks into the new bubble.
   */
  subscribeLive(sessionId: string, listener: Listener): () => void {
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

  /**
   * Drop a dead/dying adapter and every session that depended on it so Chat
   * cannot keep prompting a closed ACP pipe ("ACP connection closed").
   */
  private invalidateProvider(
    providerId: AcpProviderId,
    reason: string,
  ): void {
    const label = ACP_PROVIDERS[providerId].label;
    const conn = this.connections.get(providerId);
    const stderr = sanitizeAdapterStderrForUi(conn?.lastStderr);
    if (stderr) {
      this.lastAdapterError = stderr;
    }
    const npxTip = stderr ? explainAdapterLaunchFailure(stderr) : null;
    const message = npxTip
      ? `${acpReconnectMessage(label)} (${reason}).\n${npxTip}`
      : stderr
        ? `${acpReconnectMessage(label)} (${reason}). Adapter: ${stderr.slice(-400)}`
        : `${acpReconnectMessage(label)} (${reason})`;
    if (conn) {
      this.connections.delete(providerId);
      try {
        conn.close();
      } catch {
        // already dead
      }
    }

    const deadSessionIds: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.info.providerId !== providerId) continue;
      deadSessionIds.push(sessionId);
      session.active = null;
      session.busy = false;
      session.info.busy = false;
      this.emit(sessionId, {
        type: "session_invalidated",
        sessionId,
        message,
        at: nowIso(),
      });
      this.emit(sessionId, {
        type: "error",
        sessionId,
        message,
        at: nowIso(),
      });
    }
    for (const sessionId of deadSessionIds) {
      this.sessions.delete(sessionId);
    }

    for (const [requestId, pending] of this.pendingPermissions) {
      if (!deadSessionIds.includes(pending.sessionId)) continue;
      this.pendingPermissions.delete(requestId);
      pending.resolve({ outcome: "cancelled" });
    }

    acpLog.info("Invalidated ACP provider connection", {
      providerId,
      reason,
      droppedSessions: deadSessionIds.length,
    });
  }

  private async ensureConnection(
    providerId: AcpProviderId,
  ): Promise<AcpProviderConnection> {
    const existing = this.connections.get(providerId);
    if (existing && isConnectionAlive(existing)) {
      return existing;
    }
    if (existing) {
      this.invalidateProvider(providerId, "stale adapter process");
    }

    const def = ACP_PROVIDERS[providerId];
    let launch = resolveAdapterCommand(def);
    if (!launch) {
      const ensured = await this.ensureAdapter(providerId, { force: true });
      launch = resolveAdapterCommand(def);
      if (!launch) {
        throw new Error(
          ensured.message ||
            `${def.label} adapter not found. ${def.installHint}`,
        );
      }
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
    conn.child.on("exit", (code, signal) => {
      if (this.connections.get(providerId) !== conn) return;
      this.invalidateProvider(
        providerId,
        `adapter exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
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
  ): Promise<AcpAuthenticateResult> {
    // Codex without ChatGPT login often cannot even initialize the ACP
    // adapter (fails with CODEX_API_KEY / OPENAI_API_KEY). Open `codex login`
    // first — do not require a live connection for Sign in.
    // Important: never start a new `codex login` when already signed in —
    // that OAuth flow can wipe ~/.codex/auth.json.
    if (providerId === "codex" && !methodId) {
      if (await probeCodexLoginStatus()) {
        try {
          const conn = await this.ensureConnection(providerId);
          conn.authenticated = true;
        } catch {
          // Status said logged in; connection may still fail for other reasons.
        }
        return {
          ok: true,
          methodId: "codex-login",
          launchedTerminal: false,
          message:
            "Codex is already signed in with ChatGPT. Open Chat, pick Codex (local), and Enable workspace tools.",
        };
      }
      const { commandLine, opened } = launchTerminalAuth(
        defaultTerminalLoginLaunch("codex"),
      );
      return {
        ok: true,
        methodId: "codex-login",
        launchedTerminal: opened,
        terminalCommand: commandLine,
        message: opened
          ? "Complete ChatGPT sign-in in the Terminal window (`codex login`), then pick Codex in Chat and Enable workspace tools."
          : `Run this in Terminal, then pick Codex in Chat:\n${commandLine}`,
      };
    }

    const acp = await loadAcpSdk();
    let conn;
    try {
      conn = await this.ensureConnection(providerId);
    } catch (error) {
      if (isAcpConnectionClosedError(error)) {
        this.invalidateProvider(providerId, "connection closed during auth");
        conn = await this.ensureConnection(providerId);
      } else if (
        providerId === "codex" &&
        /CODEX_API_KEY|OPENAI_API_KEY/i.test(
          error instanceof Error ? error.message : String(error),
        )
      ) {
        const { commandLine, opened } = launchTerminalAuth(
          defaultTerminalLoginLaunch("codex"),
        );
        return {
          ok: true,
          methodId: "codex-login",
          launchedTerminal: opened,
          terminalCommand: commandLine,
          message: opened
            ? "Codex needs ChatGPT login. Complete sign-in in the Terminal window (`codex login`), then retry."
            : `Codex needs ChatGPT login. Run this in Terminal, then retry:\n${commandLine}`,
        };
      } else {
        throw error;
      }
    }

    const preferred =
      (methodId
        ? conn.authMethods.find(m => m.id === methodId)
        : undefined) ||
      conn.authMethods.find(m => m.id === "claude-ai-login") ||
      conn.authMethods.find(m => m.type === "terminal") ||
      conn.authMethods[0];

    if (!preferred) {
      conn.authenticated = true;
      return {
        ok: true,
        methodId: "none",
        message:
          "No sign-in required — Claude credentials look available. Open Chat and pick a local model.",
      };
    }

    // Terminal login (Claude / Codex); agent.authenticate often throws
    // "Method not implemented." Open a real Terminal instead.
    if (preferred.type === "terminal" || preferred.terminalAuth) {
      const launch =
        preferred.terminalAuth || defaultTerminalLoginLaunch(providerId);
      const { commandLine, opened } = launchTerminalAuth(launch);
      return {
        ok: true,
        methodId: preferred.id,
        launchedTerminal: opened,
        terminalCommand: commandLine,
        message: opened
          ? "Complete sign-in in the Terminal window that just opened, then click Enable workspace tools in Chat."
          : `Run this in Terminal, then return to Chat:\n${commandLine}`,
      };
    }

    try {
      await conn.agent.request(acp.methods.agent.authenticate, {
        methodId: preferred.id,
      });
      conn.authenticated = true;
      return {
        ok: true,
        methodId: preferred.id,
        message: "Signed in. Open Chat and pick a local model.",
      };
    } catch (error) {
      if (isAcpConnectionClosedError(error)) {
        this.invalidateProvider(providerId, "connection closed during auth");
        throw new Error(acpReconnectMessage(ACP_PROVIDERS[providerId].label));
      }
      const message =
        error instanceof Error ? error.message : "Authentication failed";
      // Adapters that reject authenticate RPC — fall back to CLI login.
      if (/not implemented/i.test(message)) {
        const { commandLine, opened } = launchTerminalAuth(
          defaultTerminalLoginLaunch(providerId),
        );
        return {
          ok: true,
          methodId: preferred.id,
          launchedTerminal: opened,
          terminalCommand: commandLine,
          message: opened
            ? "Complete sign-in in the Terminal window that just opened, then return to Mako."
            : `Run this in Terminal, then return to Mako:\n${commandLine}`,
        };
      }
      throw error;
    }
  }

  async createSession(
    body: CreateAcpSessionRequest,
  ): Promise<AcpSessionInfo> {
    return this.createSessionInternal(body, /* allowRetry */ true);
  }

  private async createSessionInternal(
    body: CreateAcpSessionRequest,
    allowRetry: boolean,
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

    try {
      // Keep adapters current, but never block session/new on `npm i -g` when
      // a global binary is already on PATH (Codex hang: "Installing/updating…").
      // Missing / npx-only installs still await ensure so first-run can recover.
      const launch = resolveAdapterCommand(ACP_PROVIDERS[providerId]);
      if (!launch || launch.via === "npx") {
        await this.ensureAdapter(providerId, { force: false });
      } else {
        void this.ensureAdapter(providerId, { force: false }).catch(error => {
          acpLog.info("Background ACP ensure failed", {
            providerId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      const conn = await this.ensureConnection(providerId);
      // Claude/Codex use Terminal CLI login — do NOT auto-open Terminal on
      // every session/new (Sign in owns that). Auto-auth for Codex used to
      // run `codex login` and wipe ~/.codex/auth.json even when ChatGPT
      // credentials already existed.
      if (
        shouldAutoAuthenticateOnSessionNew({
          providerId,
          authRequired: conn.authRequired,
          authenticated: conn.authenticated,
          authMethods: conn.authMethods,
        })
      ) {
        try {
          await this.authenticate(providerId);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Authentication failed";
          throw new Error(
            `${ACP_PROVIDERS[providerId].label} requires sign-in (${ACP_PROVIDERS[providerId].authProduct}): ${message}`,
          );
        }
      } else if (
        providerId === "codex" &&
        conn.authRequired &&
        !conn.authenticated &&
        (await probeCodexLoginStatus())
      ) {
        // Adapter still advertises auth methods after ChatGPT login; treat
        // disk/CLI status as authenticated so session/new can proceed.
        conn.authenticated = true;
      }

      const attachMakoMcp = Boolean(
        body.attachMakoMcp &&
          body.mcpUrl?.trim() &&
          body.mcpAuthorization?.trim(),
      );
      const mcpServerName = (
        body.mcpServerName?.trim() || "mako-workspace"
      ).replace(/[^a-zA-Z0-9_-]/g, "-");
      const makoToolPrefix = `mcp__${mcpServerName}__`;
      const desktopToolPrefix = `mcp__${DESKTOP_MCP_SERVER_NAME}__`;
      const systemAppend = attachMakoMcp
        ? buildMakoSystemPromptAppend({
            mcpServerName,
            desktopMcpServerName: DESKTOP_MCP_SERVER_NAME,
            extraAppend: body.systemPromptAppend,
          })
        : body.systemPromptAppend?.trim() || "";

      // For Claude ACP: allowlist Mako MCP tools, lean system append, and
      // request summarized thinking (Opus 4.7+ defaults to omitted → empty
      // agent_thought_chunk, so Chat shows no Thinking blocks).
      let builder =
        providerId === "claude"
          ? conn.agent.buildSession({
              cwd,
              mcpServers: [],
              _meta: {
                claudeCode: {
                  options: {
                    thinking: { type: "adaptive", display: "summarized" },
                    ...(attachMakoMcp
                      ? {
                          allowedTools: [
                            `${makoToolPrefix}*`,
                            `mcp__${mcpServerName}`,
                            `${desktopToolPrefix}*`,
                            `mcp__${DESKTOP_MCP_SERVER_NAME}`,
                          ],
                        }
                      : {}),
                    ...(systemAppend
                      ? {
                          systemPrompt: {
                            type: "preset",
                            preset: "claude_code",
                            append: systemAppend,
                          },
                        }
                      : {}),
                  },
                },
              },
            })
          : conn.agent.buildSession(cwd);
      if (attachMakoMcp) {
        // Never probe/attach an arbitrary URL with the workspace Bearer —
        // that would exfiltrate mcpat_* to an attacker-controlled host.
        const mcpUrl = assertAllowedMakoMcpUrl(String(body.mcpUrl));
        const authorization = normalizeBearerAuth(
          String(body.mcpAuthorization),
        );
        // Fail before Claude/Codex starts if Local Agent can't reach Mako MCP
        // (wrong host, 401, network). Surfaces as createSession error in Chat.
        try {
          await probeMakoMcpHttp({ mcpUrl, authorization });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Mako MCP probe failed";
          acpLog.error("Mako MCP probe failed", { mcpUrl, message });
          throw new Error(message);
        }
        builder = builder.withMcpServer({
          type: "http",
          name: mcpServerName,
          url: mcpUrl,
          headers: [{ name: "Authorization", value: authorization }],
        });
        const parsedPort = Number.parseInt(
          process.env.MAKO_AGENT_PORT || "",
          10,
        );
        const agentPort =
          Number.isFinite(parsedPort) && parsedPort > 0
            ? parsedPort
            : LOCAL_AGENT_PORT;
        const desktopMcpUrl = `http://127.0.0.1:${agentPort}${DESKTOP_MCP_PATH}`;
        builder = builder.withMcpServer({
          type: "http",
          name: DESKTOP_MCP_SERVER_NAME,
          url: desktopMcpUrl,
          headers: [],
        });
        acpLog.info("Attaching Mako MCP to ACP session", {
          providerId,
          mcpUrl,
          mcpServerName,
          desktopMcpUrl,
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

      const managed: ManagedSession = {
        info,
        active,
        busy: false,
        listeners: new Set(),
        eventLog: [],
        configOptions: [],
        guidanceAppend: systemAppend,
        // Claude already has systemPrompt.append — don't double-inject on prompt.
        guidanceInjectedIntoPrompt: providerId === "claude" && Boolean(systemAppend),
      };
      this.sessions.set(id, managed);
      this.applyConfigOptionsToSession(
        managed,
        active.newSessionResponse?.configOptions,
      );

      const preferredModel = body.model?.trim();
      let modelToApply: string | null = null;
      if (providerId === "codex") {
        const before = managed.info.currentModel;
        const resolvedPreferred = preferredModel
          ? resolveModelConfigValue(
              preferredModel,
              managed.info.availableModels,
            )
          : undefined;
        const safe = pickSafeCodexModel(
          resolvedPreferred,
          managed.info.availableModels,
          before,
        );
        if (safe && safe.toLowerCase() !== (before || "").toLowerCase()) {
          modelToApply = safe;
          if (before && isForeignGatewayCodexModel(before)) {
            acpLog.info(
              "Codex session had a foreign gateway model — switching",
              { sessionId: id, from: before, to: safe },
            );
          }
        }
      } else if (preferredModel) {
        modelToApply = resolveModelConfigValue(
          preferredModel,
          managed.info.availableModels,
        );
      }
      if (modelToApply) {
        try {
          await this.setSessionConfig(id, {
            configId: "model",
            value: modelToApply,
          });
        } catch (error) {
          acpLog.info("ACP preferred model not applied at session/new", {
            sessionId: id,
            preferredModel: modelToApply,
            error: String(error),
          });
          // Fail clearly for both providers — silent fallback left Chat showing
          // Opus/Sol while the adapter stayed on default.
          const raw = error instanceof Error ? error.message : String(error);
          const label = ACP_PROVIDERS[providerId].label;
          throw new Error(
            /not found|invalid value|unknown/i.test(raw)
              ? `${label} could not switch to model "${modelToApply}". ` +
                  `Update the adapter in Settings → Coding Agents, fully quit/` +
                  `reopen Desktop, then pick the model again. (${raw})`
              : raw,
          );
        }
      }

      acpLog.info("Created ACP session", {
        sessionId: id,
        providerId,
        cwd,
        makoMcpAttached: attachMakoMcp,
        currentModel: managed.info.currentModel,
      });
      return { ...managed.info, busy: managed.busy };
    } catch (error) {
      if (allowRetry && isAcpConnectionClosedError(error)) {
        this.invalidateProvider(
          providerId,
          "connection closed during session/new",
        );
        acpLog.info("Retrying ACP session/new after connection close", {
          providerId,
        });
        return this.createSessionInternal(body, false);
      }
      if (isAcpConnectionClosedError(error)) {
        this.invalidateProvider(
          providerId,
          "connection closed during session/new",
        );
        throw new Error(acpReconnectMessage(ACP_PROVIDERS[providerId].label));
      }
      throw error;
    }
  }

  /**
   * Wait until `session.busy` clears (e.g. after cancel), or throw on timeout.
   * Chat can overlap abort+resend; hard-failing with "already processing"
   * leaves the UI thinking the turn died while Claude is still working.
   */
  private async waitForSessionIdle(
    session: ManagedSession,
    timeoutMs = 15_000,
  ): Promise<void> {
    if (!session.busy) return;
    const started = Date.now();
    while (session.busy) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          "Session is still processing a previous prompt. Wait a moment and try again, or cancel the turn.",
        );
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  async prompt(
    sessionId: string,
    text: string,
  ): Promise<{ stopReason: string }> {
    const session = this.sessions.get(sessionId);
    if (!session?.active) {
      throw new Error(
        `Unknown or expired ACP session: ${sessionId}. Send again to reconnect.`,
      );
    }
    if (!text.trim()) {
      throw new Error("Prompt text is required");
    }

    // Overlapping prompt (UI abort/resend, double-submit): cancel the in-flight
    // turn and wait for busy to clear instead of failing immediately.
    if (session.busy) {
      acpLog.info("ACP prompt while busy — cancelling prior turn", {
        sessionId,
      });
      try {
        await this.cancel(sessionId);
      } catch {
        // cancel is best-effort; waitForSessionIdle still gates below
      }
      await this.waitForSessionIdle(session);
    }

    const providerId = session.info.providerId;
    if (!isConnectionAlive(this.connections.get(providerId))) {
      this.invalidateProvider(providerId, "adapter not alive before prompt");
      throw new Error(acpReconnectMessage(ACP_PROVIDERS[providerId].label));
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

    let promptText = text.trim();
    if (session.guidanceAppend && providerId !== "claude") {
      const guided = applyNonClaudeGuidanceToPrompt({
        userText: promptText,
        guidanceAppend: session.guidanceAppend,
        alreadyInjected: session.guidanceInjectedIntoPrompt,
      });
      promptText = guided.text;
      if (!session.guidanceInjectedIntoPrompt && guided.injectedFull) {
        acpLog.info("Injected Mako guidance into first ACP prompt", {
          sessionId,
          providerId,
          guidanceChars: session.guidanceAppend.length,
        });
      }
      session.guidanceInjectedIntoPrompt = true;
    }

    // Capture after the null guard — nested async closures lose the narrow.
    const active = session.active;
    const drainPrompt = async (): Promise<{ stopReason: string }> => {
      const promptPromise = active.prompt(promptText);
      for (;;) {
        const message = await active.nextUpdate();
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
    };

    try {
      return await drainPrompt();
    } catch (error) {
      if (isAcpConnectionClosedError(error)) {
        this.invalidateProvider(providerId, "connection closed during prompt");
        const message = acpReconnectMessage(ACP_PROVIDERS[providerId].label);
        // Session may already be gone after invalidate; best-effort emit.
        this.emit(sessionId, {
          type: "error",
          sessionId,
          message,
          at: nowIso(),
        });
        throw new Error(message);
      }
      const raw =
        error instanceof Error ? error.message : "ACP prompt failed";
      const conn = this.connections.get(providerId);
      const stderr =
        sanitizeAdapterStderrForUi(conn?.lastStderr) ||
        sanitizeAdapterStderrForUi(this.lastAdapterError) ||
        "";
      const combined = stderr ? `${raw}\n${stderr.slice(-600)}` : raw;

      // ChatGPT login rejects Sol (and similar). Switch to Terra once and retry.
      if (
        providerId === "codex" &&
        isCodexChatGptModelRejectedError(combined)
      ) {
        const fallback = pickChatGptCompatibleCodexModel(
          session.info.availableModels,
          session.info.currentModel,
        );
        try {
          acpLog.info("Retrying Codex prompt on ChatGPT-compatible model", {
            sessionId,
            from: session.info.currentModel,
            to: fallback,
          });
          await this.setSessionConfig(sessionId, {
            configId: "model",
            value: fallback,
          });
          return await drainPrompt();
        } catch (retryError) {
          const retryRaw =
            retryError instanceof Error
              ? retryError.message
              : "ACP prompt failed after model switch";
          const tip = explainCodexModelFailure(retryRaw) || retryRaw;
          this.emit(sessionId, {
            type: "error",
            sessionId,
            message: tip,
            at: nowIso(),
          });
          throw new Error(tip);
        }
      }

      const tip =
        providerId === "codex" ? explainCodexModelFailure(combined) : null;
      let message = tip || raw;

      // Stale Codex CLI / ACP adapter → force npm update once, then ask retry.
      if (
        providerId === "codex" &&
        /model metadata|internal error|not found/i.test(combined)
      ) {
        const last = this.lastForceEnsureAt.get(providerId) || 0;
        if (Date.now() - last > 60 * 60 * 1000) {
          this.lastForceEnsureAt.set(providerId, Date.now());
          try {
            const ensured = await this.ensureAdapter(providerId, {
              force: true,
            });
            if (ensured.ok) {
              message =
                `${message}\n\n` +
                "Mako updated Codex on this machine. Send your message again.";
            }
          } catch {
            // keep original tip
          }
        }
      }

      this.emit(sessionId, {
        type: "error",
        sessionId,
        message,
        at: nowIso(),
      });
      throw new Error(message);
    } finally {
      const still = this.sessions.get(sessionId);
      if (still) {
        still.busy = false;
        still.info.busy = false;
        still.info.updatedAt = nowIso();
      }
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

  /**
   * Apply `session/set_config_option` (model, mode, thought level, …).
   * Chat uses this so Desktop can switch Sonnet → Fable without Terminal `/model`.
   */
  async setSessionConfig(
    sessionId: string,
    body: { configId?: string; value: string | boolean },
  ): Promise<AcpSessionInfo> {
    const session = this.sessions.get(sessionId);
    if (!session?.active) {
      throw new Error(
        `Unknown or expired ACP session: ${sessionId}. Send again to reconnect.`,
      );
    }
    const configId = body.configId?.trim() || "model";
    let value = body.value;
    if (
      (typeof value !== "string" || !value.trim()) &&
      typeof value !== "boolean"
    ) {
      throw new Error("Config value is required");
    }

    // Resolve opus/sonnet/fable → canonical ids from this session's model list.
    if (configId === "model" && typeof value === "string") {
      let available =
        session.info.availableModels?.length
          ? session.info.availableModels
          : this.providerModels.get(session.info.providerId)?.availableModels;
      if (!available?.length) {
        try {
          const warmed = await this.ensureProviderModels(
            session.info.providerId,
          );
          available = warmed.availableModels;
          if (warmed.availableModels.length) {
            session.info.availableModels = warmed.availableModels;
          }
        } catch {
          // resolve with whatever we have
        }
      }
      let resolved = resolveModelConfigValue(value, available);
      // ChatGPT rejects Sol — remap before set_config so Chat never sees
      // "Invalid params" / subscription rejection when switching models.
      if (
        session.info.providerId === "codex" &&
        isChatGptRejectedCodexModel(resolved)
      ) {
        const fallback = pickChatGptCompatibleCodexModel(available, resolved);
        acpLog.info("Remapping ChatGPT-rejected Codex model", {
          sessionId,
          from: resolved,
          to: fallback,
        });
        resolved = fallback;
      }
      if (resolved !== value.trim()) {
        acpLog.info("Resolved ACP model alias", {
          sessionId,
          from: value.trim(),
          to: resolved,
        });
      }
      value = resolved;
    }

    const conn = this.connections.get(session.info.providerId);
    if (!isConnectionAlive(conn) || !conn) {
      this.invalidateProvider(
        session.info.providerId,
        "adapter not alive before set_config_option",
      );
      throw new Error(
        acpReconnectMessage(ACP_PROVIDERS[session.info.providerId].label),
      );
    }

    const acp = await loadAcpSdk();
    const params =
      typeof value === "boolean"
        ? {
            sessionId,
            configId,
            type: "boolean" as const,
            value,
          }
        : {
            sessionId,
            configId,
            value: value.trim(),
          };

    // ClientContext exposes typed helpers inconsistently across SDK builds —
    // use the JSON-RPC method name (same pattern as cancel/close).
    let response: { configOptions?: unknown };
    try {
      response = (await conn.agent.request(
        acp.methods.agent.session.setConfigOption,
        params,
      )) as { configOptions?: unknown };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const providerId = session.info.providerId;
      if (
        configId === "model" &&
        typeof value === "string" &&
        /not found|invalid value|unknown|invalid params/i.test(raw)
      ) {
        throw new Error(
          userFacingAcpError(
            `Could not switch to model "${value}". ` +
              `Use a model id from the Chat picker (not a stale alias), or ` +
              `Update the ACP adapter in Settings → Coding Agents. (${raw})`,
            { providerId },
          ),
        );
      }
      throw new Error(userFacingAcpError(raw, { providerId }));
    }
    this.applyConfigOptionsToSession(session, response?.configOptions);
    session.info.updatedAt = nowIso();
    acpLog.info("Updated ACP session config", {
      sessionId,
      configId,
      value,
      currentModel: session.info.currentModel,
    });
    return { ...session.info, busy: session.busy };
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

  async shutdown(): Promise<void> {
    const warms = [...this.modelWarmInFlight.values()];
    if (warms.length > 0) {
      await Promise.race([
        Promise.allSettled(warms),
        new Promise<void>(resolve => {
          setTimeout(resolve, 2000);
        }),
      ]);
    }
    await Promise.allSettled(
      [...this.sessions.keys()].map(id => this.closeSession(id)),
    );
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
  }
}

/** Process-wide singleton used by HTTP routes. */
export const acpSessionManager = new AcpSessionManager();
