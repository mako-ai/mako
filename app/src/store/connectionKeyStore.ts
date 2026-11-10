/**
 * The key-link page (`/connection-key/:workspaceId/:token`): an agent created
 * a source connection without its key, and the user pastes the key here so
 * it never travels through the chat. The page asks for the fields the link
 * names, and the key is checked against the service before it is kept.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api } from "../api/client";

export interface ConnectionKeyField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  description?: string;
  placeholder?: string;
}

export interface ConnectionKeyRequest {
  connectionId: string;
  name: string;
  connector: string;
  fields: ConnectionKeyField[];
  expiresAt: string;
}

export interface ConnectionKeyState {
  status: "loading" | "ready" | "error" | "saved";
  request?: ConnectionKeyRequest;
  /** Why the link cannot be used (expired, already used, …). */
  error?: string;
  saving?: boolean;
  /** Why the last submission was refused; the form stays usable. */
  submitError?: string;
  /** The service's answer to the credential check, once saved. */
  checkMessage?: string;
}

interface ConnectionKeyStoreState {
  byToken: Record<string, ConnectionKeyState | undefined>;
  load: (workspaceId: string, token: string) => Promise<void>;
  submit: (
    workspaceId: string,
    token: string,
    values: Record<string, string>,
  ) => Promise<void>;
}

function errorOf(body: unknown, fallback: string): string {
  const message = (body as { error?: unknown } | undefined)?.error;
  return typeof message === "string" && message ? message : fallback;
}

export const useConnectionKeyStore = create<ConnectionKeyStoreState>()(
  immer(set => ({
    byToken: {},

    load: async (workspaceId, token) => {
      set(s => {
        s.byToken[token] = { status: "loading" };
      });
      try {
        const { data, error, response } = await api.GET(
          "/api/workspaces/{workspaceId}/connections/sources/key-requests/{token}",
          { params: { path: { workspaceId, token } } },
        );
        if (!response.ok) {
          set(s => {
            s.byToken[token] = {
              status: "error",
              error: errorOf(error, "This key link cannot be opened."),
            };
          });
          return;
        }
        const request = (data as { data?: ConnectionKeyRequest } | undefined)
          ?.data;
        set(s => {
          s.byToken[token] = request
            ? { status: "ready", request }
            : { status: "error", error: "This key link cannot be opened." };
        });
      } catch {
        set(s => {
          s.byToken[token] = {
            status: "error",
            error: "This key link cannot be opened.",
          };
        });
      }
    },

    submit: async (workspaceId, token, values) => {
      set(s => {
        const entry = s.byToken[token];
        if (entry) {
          entry.saving = true;
          entry.submitError = undefined;
        }
      });
      try {
        const { data, error, response } = await api.POST(
          "/api/workspaces/{workspaceId}/connections/sources/key-requests/{token}",
          {
            params: { path: { workspaceId, token } },
            body: { config: values },
          },
        );
        set(s => {
          const entry = s.byToken[token];
          if (!entry) return;
          entry.saving = false;
          if (response.ok) {
            entry.status = "saved";
            entry.checkMessage = (
              data as { data?: { check?: { message?: string } } } | undefined
            )?.data?.check?.message;
            return;
          }
          const message = errorOf(error, "The key could not be saved.");
          // An invalid or expired link cannot be retried; a refused key can.
          if (response.status === 404 || response.status === 410) {
            entry.status = "error";
            entry.error = message;
          } else {
            entry.submitError = message;
          }
        });
      } catch {
        set(s => {
          const entry = s.byToken[token];
          if (!entry) return;
          entry.saving = false;
          entry.submitError = "The key could not be saved.";
        });
      }
    },
  })),
);
