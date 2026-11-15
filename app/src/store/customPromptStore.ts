/**
 * The workspace custom prompt (PROMPT.md in the workspace repo) for the
 * settings page.
 */
import { create } from "zustand";

import { api, ApiError, unwrapBody } from "../api";

/** Shown until the workspace's prompt loads (and if it never does). */
export const DEFAULT_CUSTOM_PROMPT = `# Custom Prompt Configuration

This is your custom prompt that will be combined with the system prompt to provide additional context about your data and business relationships.

## Business Context
Add information about your business domain, terminology, and key concepts here.

## Data Relationships
Describe important relationships between your collections and how they connect.

## Common Queries
Document frequently requested queries or analysis patterns.

## Custom Instructions
Add any specific instructions for how the AI should interpret your data or respond to certain types of questions.

---

*This prompt is combined with the system prompt to provide context-aware responses. You can edit this through the Settings page.*`;

type Envelope = { success?: boolean; error?: string };

interface CustomPromptStore {
  content: string;
  isLoading: boolean;
  error: string | null;
  fetchCustomPrompt: (workspaceId: string) => Promise<void>;
  /** Resolves true when saved. */
  updateCustomPrompt: (
    workspaceId: string,
    content: string,
  ) => Promise<boolean>;
  /** Resolves true when the server restored the default (content reloaded). */
  resetCustomPrompt: (workspaceId: string) => Promise<boolean>;
  setError: (error: string | null) => void;
}

/** An HTTP failure gets the generic message; anything else is the network. */
function failureMessage(err: unknown, action: "fetching" | "updating") {
  const verb = action === "fetching" ? "fetch" : "update";
  return err instanceof ApiError
    ? `Failed to ${verb} custom prompt`
    : `Network error while ${action} custom prompt`;
}

export const useCustomPromptStore = create<CustomPromptStore>()((set, get) => ({
  content: DEFAULT_CUSTOM_PROMPT,
  isLoading: false,
  error: null,

  setError: error => set({ error }),

  fetchCustomPrompt: async workspaceId => {
    set({ isLoading: true, error: null });
    try {
      const data = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/custom-prompt", {
          params: { path: { workspaceId } },
        }),
      ) as Envelope & { content: string };
      if (data.success) set({ content: data.content });
      else set({ error: data.error || "Failed to fetch custom prompt" });
    } catch (err) {
      set({ error: failureMessage(err, "fetching") });
      console.error("Error fetching custom prompt:", err);
    } finally {
      set({ isLoading: false });
    }
  },

  updateCustomPrompt: async (workspaceId, content) => {
    set({ isLoading: true, error: null });
    try {
      const data = unwrapBody(
        await api.PUT("/api/workspaces/{workspaceId}/custom-prompt", {
          params: { path: { workspaceId } },
          body: { content },
        }),
      ) as Envelope;
      if (data.success) {
        set({ content });
        return true;
      }
      set({ error: data.error || "Failed to update custom prompt" });
      return false;
    } catch (err) {
      set({ error: failureMessage(err, "updating") });
      console.error("Error updating custom prompt:", err);
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  resetCustomPrompt: async workspaceId => {
    try {
      const data = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/custom-prompt/reset", {
          params: { path: { workspaceId } },
        }),
      ) as Envelope;
      if (!data.success) return false;
      await get().fetchCustomPrompt(workspaceId);
      return true;
    } catch (err) {
      console.error("Error resetting custom prompt:", err);
      return false;
    }
  },
}));
