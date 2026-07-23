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
  createSession: () => Promise<AcpSessionInfo | null>;
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
          // Soft: EventSource reconnects; only keep last message.
          set(s => {
            if (!s.error) s.error = error.message;
          });
        },
      );
      eventUnsubscribers.set(sessionId, unsub);
    },

    createSession: async () => {
      const { selectedProviderId, cwdDraft } = get();
      set(s => {
        s.error = null;
      });
      try {
        const session = await acpClient.createSession({
          providerId: selectedProviderId,
          cwd: cwdDraft || undefined,
        });
        set(s => {
          s.sessions = [
            session,
            ...s.sessions.filter(x => x.id !== session.id),
          ];
          s.activeSessionId = session.id;
          s.messagesBySession[session.id] ??= [];
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
        const messages = (s.messagesBySession[sessionId] ??= []);
        messages.push({
          id: messageId(),
          role: "user",
          text: text.trim(),
          at: new Date().toISOString(),
        });
      });
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
