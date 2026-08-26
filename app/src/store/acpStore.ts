import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { acpClient } from "../lib/acp-client";
import {
  acpSupportsAdapterEnsure,
  acpSupportsModelWarm,
} from "../lib/acp-capabilities";
import type {
  AcpChatMessage,
  AcpEnsureAdapterResult,
  AcpPermissionPrompt,
  AcpProviderId,
  AcpSessionInfo,
  AcpStatus,
  AcpWarmModelsResult,
} from "../lib/acp-types";
import {
  getActiveWorkspaceId,
  mintMakoMcpAttach,
} from "../lib/mako-mcp-attach";
import { fetchWorkspaceGuidanceForAcp } from "../lib/acp-system-append";
import { startDesktopAcpCliLogin } from "../lib/desktop";
import { apiClient } from "../lib/api-client";
import {
  sanitizeAcpUserError,
  shouldClearAcpAuthGuidance,
} from "../lib/acp-user-errors";

function providerLabel(id: AcpProviderId): string {
  if (id === "codex") return "Codex";
  if (id === "cursor") return "Cursor Agent";
  return "Claude Code";
}

function messageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function appendAssistantText(
  messages: AcpChatMessage[],
  text: string,
  at: string,
): void {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    last.text += text;
    last.at = at;
    return;
  }
  messages.push({
    id: messageId(),
    role: "assistant",
    text,
    at,
  });
}

function appendUserText(
  messages: AcpChatMessage[],
  text: string,
  at: string,
): void {
  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    last.text += text;
    last.at = at;
    return;
  }
  messages.push({
    id: messageId(),
    role: "user",
    text,
    at,
  });
}

interface AcpState {
  status: AcpStatus | null;
  statusError: string | null;
  loadingStatus: boolean;
  sessions: AcpSessionInfo[];
  activeSessionId: string | null;
  messagesBySession: Record<string, AcpChatMessage[]>;
  permissionsBySession: Record<string, AcpPermissionPrompt | null>;
  sending: boolean;
  error: string | null;
  selectedProviderId: AcpProviderId;
  cwdDraft: string;

  refreshStatus: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  setSelectedProvider: (id: AcpProviderId) => void;
  setCwdDraft: (cwd: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  createSession: (options?: {
    workspaceId?: string;
    /** When true (Chat path), fail if Mako MCP cannot be attached. */
    requireMakoMcp?: boolean;
    /** Preferred Claude/Codex model alias or id (e.g. `fable`). */
    model?: string;
  }) => Promise<AcpSessionInfo | null>;
  /** Switch model/mode on an existing ACP session via session/set_config_option. */
  setSessionModel: (
    sessionId: string,
    model: string,
  ) => Promise<AcpSessionInfo | null>;
  /** Drop a dead ACP session from local state (adapter crash / invalidate). */
  forgetSession: (sessionId: string) => void;
  /** Record an ACP permission prompt for Chat / Coding Agents HITL. */
  ingestPermissionRequest: (
    sessionId: string,
    request: {
      requestId: string;
      toolCall: unknown;
      options: unknown[];
    },
  ) => void;
  authenticate: (providerId?: AcpProviderId) => Promise<void>;
  /**
   * Install/update ACP adapter (+ Codex CLI) on this machine via Local Agent.
   * Prefer force when the adapter is missing or Codex metadata errors.
   */
  ensureAdapter: (
    providerId?: AcpProviderId,
    options?: { force?: boolean },
  ) => Promise<AcpEnsureAdapterResult | null>;
  /** Warm Claude/Codex model catalogs (throwaway session/new). */
  warmProviderModels: (
    providerId?: AcpProviderId,
  ) => Promise<AcpWarmModelsResult | null>;
  /** Last auth guidance (Terminal opened / copy-paste command). */
  authGuidance: string | null;
  sendPrompt: (text: string) => Promise<void>;
  cancelActive: () => Promise<void>;
  closeActive: () => Promise<void>;
  respondPermission: (
    outcome: "cancelled" | "selected",
    optionId?: string,
  ) => Promise<void>;
  applyPlanDecision: (input: {
    workspaceId: string;
    agentSessionId: string;
    decision: "approve" | "request_changes" | "cancel";
    planMarkdown?: string;
    grants?: Array<
      "artifact-write" | "warehouse-write" | "git-write" | "schedule-write"
    >;
  }) => Promise<void>;
  revokeSessionGrant: (sessionId: string) => Promise<void>;
  fetchTurnGuidance: (input: {
    workspaceId: string;
    userText: string;
    includeDbtRules: boolean;
    dbtProjectId?: string;
  }) => Promise<string>;
  /** Start SSE for the active session (idempotent per session). */
  ensureEventSubscription: (sessionId: string) => void;
}

const eventUnsubscribers = new Map<string, () => void>();

export const useAcpStore = create<AcpState>()(
  immer((set, get) => ({
    status: null,
    statusError: null,
    loadingStatus: false,
    sessions: [],
    activeSessionId: null,
    messagesBySession: {},
    permissionsBySession: {},
    sending: false,
    error: null,
    authGuidance: null,
    selectedProviderId: "claude",
    cwdDraft: "",

    refreshStatus: async () => {
      set(s => {
        s.loadingStatus = true;
        s.statusError = null;
      });
      try {
        const status = await acpClient.getStatus();
        set(s => {
          s.status = status;
          s.loadingStatus = false;
          if (!s.cwdDraft) {
            s.cwdDraft = status.defaultCwd;
          }
          // Drop stale "open Terminal" copy once CLI login is confirmed —
          // otherwise Switching Codex models keeps showing a blue Sign-in box.
          const provider = status.providers.find(
            p => p.id === s.selectedProviderId,
          );
          if (shouldClearAcpAuthGuidance(s.authGuidance, provider)) {
            s.authGuidance = null;
          }
        });
      } catch (error) {
        set(s => {
          s.status = null;
          s.loadingStatus = false;
          s.statusError =
            error instanceof Error
              ? error.message
              : "Local Agent is not reachable";
        });
      }
    },

    refreshSessions: async () => {
      try {
        const sessions = await acpClient.listSessions();
        set(s => {
          const existingById = new Map(
            s.sessions.map(session => [session.id, session]),
          );
          s.sessions = sessions.map(session => ({
            ...session,
            makoAgentSessionId:
              existingById.get(session.id)?.makoAgentSessionId ??
              session.makoAgentSessionId,
            makoWorkspaceId:
              existingById.get(session.id)?.makoWorkspaceId ??
              session.makoWorkspaceId,
          }));
        });
      } catch (error) {
        set(s => {
          s.error =
            error instanceof Error ? error.message : "Failed to list sessions";
        });
      }
    },

    setSelectedProvider: id => {
      set(s => {
        s.selectedProviderId = id;
        // Claude Terminal guidance must not stick when the user flips to Codex.
        s.authGuidance = null;
        const cleaned = sanitizeAcpUserError(s.error, { providerId: id });
        s.error = cleaned;
      });
    },

    setCwdDraft: cwd => {
      set(s => {
        s.cwdDraft = cwd;
      });
    },

    setActiveSession: sessionId => {
      set(s => {
        s.activeSessionId = sessionId;
        s.error = null;
      });
      if (sessionId) {
        get().ensureEventSubscription(sessionId);
      }
    },

    ensureEventSubscription: sessionId => {
      if (eventUnsubscribers.has(sessionId)) return;
      // SSE backlog replays the full bridge transcript — clear so we don't
      // double-append after reconnect / selecting an existing session.
      set(s => {
        s.messagesBySession[sessionId] = [];
      });
      const unsub = acpClient.subscribeEvents(
        sessionId,
        event => {
          set(s => {
            if (event.type === "session_update") {
              const update = event.update as {
                sessionUpdate?: string;
                content?: { type?: string; text?: string };
                title?: string;
                status?: string;
              };
              const messages = (s.messagesBySession[sessionId] ??= []);
              if (
                update.sessionUpdate === "user_message_chunk" &&
                update.content?.type === "text" &&
                update.content.text
              ) {
                appendUserText(messages, update.content.text, event.at);
              } else if (
                update.sessionUpdate === "agent_message_chunk" &&
                update.content?.type === "text" &&
                update.content.text
              ) {
                appendAssistantText(messages, update.content.text, event.at);
              } else if (update.sessionUpdate === "agent_thought_chunk") {
                // Ignore thought chunks in the main transcript for now.
              } else if (update.sessionUpdate === "tool_call") {
                messages.push({
                  id: messageId(),
                  role: "tool",
                  text: `🔧 ${update.title || "Tool"} (${update.status || "pending"})`,
                  at: event.at,
                });
              } else if (update.sessionUpdate === "tool_call_update") {
                messages.push({
                  id: messageId(),
                  role: "tool",
                  text: `🔧 update → ${update.status || "updated"}`,
                  at: event.at,
                });
              }
            } else if (event.type === "permission_request") {
              s.permissionsBySession[sessionId] = {
                requestId: event.requestId,
                toolCall: event.toolCall,
                options: (event.options || []).map(opt => {
                  const o = opt as {
                    optionId?: string;
                    name?: string;
                    kind?: string;
                  };
                  return {
                    optionId: String(o.optionId || ""),
                    name: String(o.name || o.optionId || "Option"),
                    kind: o.kind,
                  };
                }),
              };
            } else if (event.type === "session_invalidated") {
              const sessionProviderId =
                s.sessions.find(x => x.id === sessionId)?.providerId ||
                s.selectedProviderId;
              s.sessions = s.sessions.filter(x => x.id !== sessionId);
              if (s.activeSessionId === sessionId) s.activeSessionId = null;
              s.permissionsBySession[sessionId] = null;
              s.error = sanitizeAcpUserError(event.message, {
                providerId: sessionProviderId,
              });
              s.sending = false;
            } else if (event.type === "error") {
              const sessionProviderId =
                s.sessions.find(x => x.id === sessionId)?.providerId ||
                s.selectedProviderId;
              s.error = sanitizeAcpUserError(event.message, {
                providerId: sessionProviderId,
              });
            } else if (event.type === "turn_done") {
              s.sending = false;
              const existing = s.sessions.find(x => x.id === sessionId);
              if (existing) existing.busy = false;
            }
          });
        },
        error => {
          // Drop the dead subscription so the next ensure can reconnect and
          // replay history from the Local Agent event log.
          eventUnsubscribers.delete(sessionId);
          unsub();
          set(s => {
            if (!s.error) s.error = error.message;
          });
        },
      );
      eventUnsubscribers.set(sessionId, unsub);
    },

    forgetSession: sessionId => {
      const unsub = eventUnsubscribers.get(sessionId);
      if (unsub) {
        unsub();
        eventUnsubscribers.delete(sessionId);
      }
      set(s => {
        s.sessions = s.sessions.filter(x => x.id !== sessionId);
        if (s.activeSessionId === sessionId) s.activeSessionId = null;
        s.permissionsBySession[sessionId] = null;
        delete s.messagesBySession[sessionId];
      });
      // Tear down the Local Agent process session so Codex/Claude orphans
      // don't pile up after model switches / stale bindings.
      void acpClient.closeSession(sessionId).catch(() => undefined);
    },

    ingestPermissionRequest: (sessionId, request) => {
      set(s => {
        s.activeSessionId = sessionId;
        s.permissionsBySession[sessionId] = {
          requestId: request.requestId,
          toolCall: request.toolCall,
          options: (request.options || []).map(opt => {
            const o = opt as {
              optionId?: string;
              name?: string;
              kind?: string;
            };
            return {
              optionId: String(o.optionId || ""),
              name: String(o.name || o.optionId || "Option"),
              kind: o.kind,
            };
          }),
        };
      });
    },

    applyPlanDecision: async input => {
      await apiClient.request(
        `/workspaces/${encodeURIComponent(input.workspaceId)}/acp-plan-grant`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentSessionId: input.agentSessionId,
            decision: input.decision,
            planMarkdown: input.planMarkdown,
            grants: input.grants,
          }),
        },
      );
    },

    revokeSessionGrant: async sessionId => {
      const session = get().sessions.find(item => item.id === sessionId);
      if (!session?.makoAgentSessionId || !session.makoWorkspaceId) return;
      await get().applyPlanDecision({
        workspaceId: session.makoWorkspaceId,
        agentSessionId: session.makoAgentSessionId,
        decision: "cancel",
      });
    },

    fetchTurnGuidance: async input => {
      const response = await apiClient.request<{
        success: boolean;
        skillsBlock?: string;
        dbtRulesBlock?: string;
      }>(
        `/workspaces/${encodeURIComponent(input.workspaceId)}/custom-prompt/turn-guidance`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userText: input.userText,
            includeDbtRules: input.includeDbtRules,
            dbtProjectId: input.dbtProjectId,
          }),
        },
      );
      return [response.skillsBlock, response.dbtRulesBlock]
        .filter(
          (section): section is string =>
            typeof section === "string" && section.trim().length > 0,
        )
        .join("\n\n");
    },

    createSession: async options => {
      const { selectedProviderId, cwdDraft } = get();
      const requireMakoMcp = options?.requireMakoMcp !== false;
      set(s => {
        s.error = null;
      });
      try {
        const workspaceId =
          options?.workspaceId?.trim() || getActiveWorkspaceId();
        if (!workspaceId) {
          throw new Error(
            `Select a workspace before starting ${providerLabel(
              selectedProviderId,
            )} (local).`,
          );
        }

        const creds = await mintMakoMcpAttach(workspaceId);
        const systemPromptAppend =
          await fetchWorkspaceGuidanceForAcp(workspaceId);
        const session = await acpClient.createSession({
          providerId: selectedProviderId,
          cwd: cwdDraft || undefined,
          attachMakoMcp: true,
          mcpUrl: creds.mcpUrl,
          mcpAuthorization: creds.mcpAuthorization,
          mcpServerName: creds.mcpServerName,
          makoAgentSessionId: creds.agentSessionId,
          makoWorkspaceId: workspaceId,
          systemPromptAppend,
          model: options?.model?.trim() || undefined,
        });
        if (session.providerId !== selectedProviderId) {
          // Old Local Agents coerce unknown provider ids (cursor) to claude —
          // fail loudly instead of silently chatting with the wrong agent.
          void acpClient.closeSession(session.id).catch(() => undefined);
          throw new Error(
            `Local Agent does not support ${providerLabel(
              selectedProviderId,
            )} yet. Update Mako Desktop (or restart the Local Agent from this branch), then retry.`,
          );
        }
        if (requireMakoMcp && !session.makoMcpAttached) {
          throw new Error(
            "Local session started without Mako data tools. Restart Local Agent from this branch and try again.",
          );
        }
        const boundSession: AcpSessionInfo = {
          ...session,
          makoAgentSessionId:
            session.makoAgentSessionId ?? creds.agentSessionId,
          makoWorkspaceId: session.makoWorkspaceId ?? workspaceId,
        };
        set(s => {
          s.sessions = [
            boundSession,
            ...s.sessions.filter(x => x.id !== boundSession.id),
          ];
          s.activeSessionId = boundSession.id;
          s.messagesBySession[boundSession.id] ??= [];
          s.error = null;
        });
        // Refresh status so Chat's model picker picks up availableModels.
        void get().refreshStatus();
        get().ensureEventSubscription(boundSession.id);
        return boundSession;
      } catch (error) {
        let message =
          error instanceof Error ? error.message : "Failed to create session";
        if (
          get().selectedProviderId === "codex" &&
          /CODEX_API_KEY|OPENAI_API_KEY/i.test(message)
        ) {
          message =
            "Codex is not signed in. Click Sign in with ChatGPT " +
            "(runs `codex login`), finish auth in Terminal, then retry.";
        }
        set(s => {
          s.error =
            sanitizeAcpUserError(message, {
              providerId: selectedProviderId,
            }) || message;
        });
        return null;
      }
    },

    setSessionModel: async (sessionId, model) => {
      let value = model.trim();
      if (!sessionId || !value) return null;
      const providerId =
        get().sessions.find(s => s.id === sessionId)?.providerId ||
        get().selectedProviderId;
      // ChatGPT rejects Sol — prefer Terra in the live switch so we don't flash
      // Invalid params / subscription errors in the Enable banner.
      if (providerId === "codex" && /gpt-5\.6-sol/i.test(value)) {
        value = "gpt-5.6-terra";
      }
      set(s => {
        s.error = null;
      });
      try {
        const session = await acpClient.setSessionConfig(sessionId, {
          configId: "model",
          value,
        });
        set(s => {
          s.sessions = s.sessions.map(x => (x.id === session.id ? session : x));
          s.error = null;
        });
        void get().refreshStatus();
        return session;
      } catch (error) {
        let message =
          error instanceof Error
            ? error.message
            : "Failed to switch local model";
        // Picking Luna/Terra after Local Agent restart (or a closed session)
        // hits set_config on a dead id. Drop the stale session quietly — the
        // next Enable / Chat send creates a fresh one with the selected model.
        if (/expired ACP session|Unknown or expired/i.test(message)) {
          get().forgetSession(sessionId);
          set(s => {
            s.error = null;
          });
          void get().refreshSessions();
          return null;
        }
        if (/^not found$/i.test(message.trim())) {
          message =
            providerId === "codex"
              ? `Codex could not switch to "${value}". Fully quit/reopen Desktop 0.3.9+, Update adapter, then pick GPT-5.6 Terra/Luna again.`
              : providerId === "cursor"
                ? `Cursor Agent could not switch to "${value}". Update Cursor CLI (\`cursor-agent update\`), then pick Grok 4.6/4.5 again.`
                : `Claude could not switch to "${value}". Fully quit/reopen Desktop 0.3.9+, Update adapter, then pick Opus/Sonnet again.`;
        }
        set(s => {
          s.error = sanitizeAcpUserError(message, { providerId }) || message;
        });
        return null;
      }
    },

    authenticate: async providerId => {
      const id = providerId || get().selectedProviderId;
      set(s => {
        s.error = null;
        s.authGuidance = null;
      });
      // Codex: ask Local Agent first — it skips `codex login` when already
      // signed in. Starting a second login (Desktop IPC + agent) can wipe
      // ~/.codex/auth.json. Only open Terminal when login is actually needed.
      if (id === "codex") {
        try {
          const result = await acpClient.authenticate(id);
          set(s => {
            s.authGuidance =
              result.message ||
              (result.terminalCommand
                ? `Run in Terminal:\n${result.terminalCommand}`
                : null);
            s.error = null;
          });
          if (!result.launchedTerminal && result.terminalCommand) {
            // Agent wants login but could not open Terminal — Desktop IPC.
            try {
              const desktopLogin = await startDesktopAcpCliLogin("codex");
              if (desktopLogin?.opened) {
                set(s => {
                  s.authGuidance =
                    "Complete ChatGPT sign-in in the Terminal window (`codex login`), " +
                    "then pick Codex in Chat and Enable workspace tools.";
                });
              } else if (desktopLogin && !desktopLogin.opened) {
                set(s => {
                  s.authGuidance =
                    "Could not open Terminal automatically. Run this yourself, then retry Codex:\n\n" +
                    desktopLogin.commandLine;
                });
              }
            } catch {
              // Guidance already set from Local Agent.
            }
          }
          await get().refreshStatus();
          return;
        } catch (error) {
          const raw =
            error instanceof Error ? error.message : "Authentication failed";
          // Older Local Agents / offline agent — try Desktop Terminal, else guide.
          try {
            const desktopLogin = await startDesktopAcpCliLogin("codex");
            if (desktopLogin?.opened) {
              set(s => {
                s.error = null;
                s.authGuidance =
                  "Complete ChatGPT sign-in in the Terminal window (`codex login`), " +
                  "then pick Codex in Chat and Enable workspace tools.";
              });
              return;
            }
            if (desktopLogin && !desktopLogin.opened) {
              set(s => {
                s.error = null;
                s.authGuidance =
                  "Could not open Terminal automatically. Run this yourself, then retry Codex:\n\n" +
                  desktopLogin.commandLine;
              });
              return;
            }
          } catch {
            // fall through
          }
          if (/CODEX_API_KEY|OPENAI_API_KEY/i.test(raw)) {
            set(s => {
              s.error = null;
              s.authGuidance =
                "Codex needs ChatGPT login. Run this in Terminal, then retry Codex in Chat:\n\n" +
                "codex login";
            });
            return;
          }
          set(s => {
            s.error = raw;
          });
          return;
        }
      }
      try {
        const result = await acpClient.authenticate(id);
        set(s => {
          s.authGuidance =
            result.message ||
            (result.terminalCommand
              ? `Run in Terminal:\n${result.terminalCommand}`
              : null);
          s.error = null;
        });
        await get().refreshStatus();
      } catch (error) {
        const raw =
          error instanceof Error ? error.message : "Authentication failed";
        set(s => {
          s.error = raw;
        });
      }
    },

    ensureAdapter: async (providerId, options) => {
      const id = providerId || get().selectedProviderId;
      if (!acpSupportsAdapterEnsure(get().status)) {
        const installCmd =
          id === "codex"
            ? "npm i -g @openai/codex @agentclientprotocol/codex-acp"
            : id === "cursor"
              ? "curl https://cursor.com/install -fsS | bash"
              : "npm i -g @agentclientprotocol/claude-agent-acp";
        const message =
          "One-click Update needs PR Desktop 0.3.9 Local Agent " +
          "(mako.ai/download is still 0.3.1). Until then, run this in Terminal, " +
          "then click Retry / refresh status:\n\n" +
          installCmd;
        // Explicit Update/Install: show Terminal fallback instead of a dead button.
        if (options?.force) {
          set(s => {
            s.error = null;
            s.authGuidance = message;
          });
        }
        return {
          ok: false,
          providerId: id,
          skipped: true,
          updated: false,
          packages:
            id === "codex"
              ? ["@openai/codex", "@agentclientprotocol/codex-acp"]
              : id === "cursor"
                ? []
                : ["@agentclientprotocol/claude-agent-acp"],
          message,
          adapterCommand: null,
          adapterVia: null,
        };
      }
      set(s => {
        s.error = null;
        if (s.status) {
          s.status.ensureByProvider = {
            ...s.status.ensureByProvider,
            [id]: {
              state: "running",
              message: "Installing/updating local tools…",
              startedAt: new Date().toISOString(),
            },
          };
        }
      });
      try {
        const result = await acpClient.ensureAdapter(id, {
          force: options?.force,
        });
        await get().refreshStatus();
        if (!result.ok) {
          set(s => {
            s.error = result.message;
          });
        }
        return result;
      } catch (error) {
        set(s => {
          s.error =
            error instanceof Error
              ? error.message
              : "Failed to update local adapter";
        });
        void get().refreshStatus();
        return null;
      }
    },

    warmProviderModels: async providerId => {
      const id = providerId || get().selectedProviderId;
      // Background warm must never poison Chat/Settings with a hard error —
      // older Local Agents simply lack the route; chatting still works.
      if (!acpSupportsModelWarm(get().status)) {
        return null;
      }
      try {
        const result = await acpClient.warmProviderModels(id);
        await get().refreshStatus();
        return result;
      } catch {
        return null;
      }
    },

    sendPrompt: async text => {
      const sessionId = get().activeSessionId;
      if (!sessionId || !text.trim()) return;
      set(s => {
        s.sending = true;
        s.error = null;
      });
      // User text arrives via bridge `user_message_chunk` (live + SSE replay).
      get().ensureEventSubscription(sessionId);
      try {
        await acpClient.prompt(sessionId, text.trim());
        await get().refreshSessions();
      } catch (error) {
        set(s => {
          s.error = error instanceof Error ? error.message : "Prompt failed";
        });
      } finally {
        set(s => {
          s.sending = false;
        });
      }
    },

    cancelActive: async () => {
      const sessionId = get().activeSessionId;
      if (!sessionId) return;
      try {
        await acpClient.cancel(sessionId);
      } catch (error) {
        set(s => {
          s.error = error instanceof Error ? error.message : "Cancel failed";
        });
      }
    },

    closeActive: async () => {
      const sessionId = get().activeSessionId;
      if (!sessionId) return;
      const unsub = eventUnsubscribers.get(sessionId);
      unsub?.();
      eventUnsubscribers.delete(sessionId);
      try {
        await acpClient.closeSession(sessionId);
      } catch {
        // still drop locally
      }
      set(s => {
        s.sessions = s.sessions.filter(x => x.id !== sessionId);
        s.activeSessionId =
          s.sessions.find(x => x.id !== sessionId)?.id ?? null;
        delete s.messagesBySession[sessionId];
        delete s.permissionsBySession[sessionId];
      });
    },

    respondPermission: async (outcome, optionId) => {
      const sessionId = get().activeSessionId;
      const prompt = sessionId ? get().permissionsBySession[sessionId] : null;
      if (!sessionId || !prompt) return;
      try {
        await acpClient.respondPermission(sessionId, prompt.requestId, {
          outcome,
          optionId,
        });
        set(s => {
          s.permissionsBySession[sessionId] = null;
        });
      } catch (error) {
        set(s => {
          s.error =
            error instanceof Error
              ? error.message
              : "Failed to answer permission";
        });
      }
    },
  })),
);
