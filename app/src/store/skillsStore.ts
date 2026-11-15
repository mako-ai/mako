/**
 * Workspace skills (the agent's `skills/*.md` files) for the settings panel.
 *
 * Request-only actions: the panel keeps its own optimistic list, so these
 * return results / throw `ApiError` rather than holding state.
 */
import { create } from "zustand";

import { api, ApiError, unwrapBody } from "../api";

export interface SkillSummary {
  id: string;
  name: string;
  path: string;
  loadWhen: string;
  bodyPreview: string;
  entities: string[];
  suppressed: boolean;
  pinned: boolean;
  definitionInvalid: { reason: string; path: string } | null;
  /** Problems that do not hide the skill (a cut description, a refused file). */
  warnings?: string[];
  /** Reads by the agent or an MCP client in the last 30 days. */
  loads30d?: number;
  lastLoadedAt?: string | null;
}

export interface SkillDetail extends SkillSummary {
  body: string;
}

export interface SkillUpdate {
  loadWhen: string;
  body: string;
  entities: string[];
  pinned: boolean;
}

interface SkillsStore {
  listSkills: (workspaceId: string) => Promise<SkillSummary[]>;
  getSkill: (workspaceId: string, id: string) => Promise<SkillDetail>;
  updateSkill: (
    workspaceId: string,
    id: string,
    update: SkillUpdate,
  ) => Promise<void>;
  deleteSkill: (workspaceId: string, id: string) => Promise<void>;
  setSuppressed: (
    workspaceId: string,
    id: string,
    suppressed: boolean,
  ) => Promise<void>;
  setPinned: (
    workspaceId: string,
    id: string,
    pinned: boolean,
  ) => Promise<void>;
}

type Envelope = { success?: boolean; error?: string };

/** The routes answer `{ success: false, error }` on some 2xx failures. */
function ensureSuccess<T extends Envelope>(body: T, fallback: string): T {
  if (!body.success) throw new Error(body.error || fallback);
  return body;
}

export const useSkillsStore = create<SkillsStore>()(() => ({
  listSkills: async workspaceId => {
    try {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/skills", {
          params: { path: { workspaceId } },
        }),
      ) as Envelope & { skills: SkillSummary[] };
      return ensureSuccess(body, "Failed to load skills").skills;
    } catch (err) {
      // Writes 412 without GitHub; GET/list is an empty explorer (disconnect
      // or never linked). A sticky error left the panel populated after
      // unlink.
      if (err instanceof ApiError && err.status === 412) return [];
      throw err;
    }
  },

  getSkill: async (workspaceId, id) => {
    const body = unwrapBody(
      await api.GET("/api/workspaces/{workspaceId}/skills/{id}", {
        params: { path: { workspaceId, id } },
      }),
    ) as Envelope & { skill: SkillDetail };
    return ensureSuccess(body, "Failed to load skill").skill;
  },

  updateSkill: async (workspaceId, id, update) => {
    const body = unwrapBody(
      await api.PUT("/api/workspaces/{workspaceId}/skills/{id}", {
        params: { path: { workspaceId, id } },
        body: update,
      }),
    ) as Envelope;
    ensureSuccess(body, "Failed to save skill");
  },

  deleteSkill: async (workspaceId, id) => {
    unwrapBody(
      await api.DELETE("/api/workspaces/{workspaceId}/skills/{id}", {
        params: { path: { workspaceId, id } },
      }),
    );
  },

  setSuppressed: async (workspaceId, id, suppressed) => {
    unwrapBody(
      await api.POST("/api/workspaces/{workspaceId}/skills/{id}/suppress", {
        params: { path: { workspaceId, id } },
        body: { suppressed },
      }),
    );
  },

  setPinned: async (workspaceId, id, pinned) => {
    unwrapBody(
      await api.POST("/api/workspaces/{workspaceId}/skills/{id}/pin", {
        params: { path: { workspaceId, id } },
        body: { pinned },
      }),
    );
  },
}));
