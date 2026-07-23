import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { acpClient } from "../lib/acp-client";
import type {
  AcpChatMessage,
  AcpPermissionPrompt,
  AcpProviderId,
  AcpSessionInfo,
  AcpStatus,
} from "../lib/acp-types";
import {
  getActiveWorkspaceId,
  mintMakoMcpAttach,
} from "../lib/mako-mcp-attach";

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
  }) => Promise<AcpSessionInfo | null>;
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
  sendPrompt: (text: string) => Promise<void>;
  cancelActive: () => Promise<void>;
  closeActive: () => Promise<void>;
  respondPermission: (
    outcome: "cancelled" | "selected",
    optionId?: string,
  ) => Promise<void>;
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
          s.sessions = sessions;
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
            } else if (event.type === "error") {
              s.error = event.message;
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
            "Select a workspace before starting Claude Code (local).",
          );
        }

        const creds = await mintMakoMcpAttach(workspaceId);
        const session = await acpClient.createSession({
          providerId: selectedProviderId,
          cwd: cwdDraft || undefined,
          attachMakoMcp: true,
          mcpUrl: creds.mcpUrl,
          mcpAuthorization: creds.mcpAuthorization,
          mcpServerName: creds.mcpServerName,
        });
        if (requireMakoMcp && !session.makoMcpAttached) {
          throw new Error(
            "Local session started without Mako data tools. Restart Local Agent from this branch and try again.",
          );
        }
        set(s => {
          s.sessions = [
            session,
            ...s.sessions.filter(x => x.id !== session.id),
          ];
          s.activeSessionId = session.id;
          s.messagesBySession[session.id] ??= [];
          s.error = null;
        });
        get().ensureEventSubscription(session.id);
        return session;
      } catch (error) {
        set(s => {
          s.error =
            error instanceof Error ? error.message : "Failed to create session";
        });
        return null;
      }
    },

    authenticate: async providerId => {
      const id = providerId || get().selectedProviderId;
      set(s => {
        s.error = null;
      });
      try {
        await acpClient.authenticate(id);
        await get().refreshStatus();
      } catch (error) {
        set(s => {
          s.error =
            error instanceof Error ? error.message : "Authentication failed";
        });
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
