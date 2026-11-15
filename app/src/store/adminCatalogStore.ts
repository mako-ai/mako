/**
 * Superadmin model catalog (Settings → Admin). Request-only actions: the page
 * keeps its own optimistic copy of the catalog.
 */
import { create } from "zustand";

import { api, unwrapBody } from "../api";
import { unspecced } from "../api/unspecced";

export interface AdminCuratedModel {
  id: string;
  provider: string;
  name: string;
  description: string;
  contextWindow: number | null;
  blendedCostPerM: number | null;
  /** Unix seconds the model was released (gateway `released`). */
  releasedAt: number | null;
  /** Knowledge cutoff date string (gateway `knowledge`). */
  knowledgeCutoff: string | null;
  /** Accepts image input (gateway modalities). */
  imageInput: boolean | null;
  visible: boolean;
  tier: "free" | "pro";
}

export interface AdminCatalogResponse {
  models: AdminCuratedModel[];
  defaultChatModelId: string | null;
  defaultFreeChatModelId: string | null;
  utilityModelId: string | null;
  gatewayFetchedAt: string | null;
  curationUpdatedAt: string | null;
  lastRefreshError: string | null;
}

export interface CatalogRefreshResult {
  success: boolean;
  refreshed?: { models: number; pricedModels: number; droppedEntries?: number };
  error?: string;
}

export interface CatalogDefaults {
  defaultChatModelId: string | null;
  defaultFreeChatModelId: string | null;
  utilityModelId: string | null;
}

interface AdminCatalogStore {
  getCatalog: () => Promise<AdminCatalogResponse>;
  refresh: () => Promise<CatalogRefreshResult>;
  /** Drops the cached gateway rows before refetching. */
  hardRefresh: () => Promise<CatalogRefreshResult>;
  updateModel: (
    modelId: string,
    patch: Pick<AdminCuratedModel, "visible" | "tier">,
  ) => Promise<void>;
  updateDefaults: (defaults: CatalogDefaults) => Promise<void>;
}

export const useAdminCatalogStore = create<AdminCatalogStore>()(() => ({
  getCatalog: async () =>
    unwrapBody(await api.GET("/api/admin/catalog")) as AdminCatalogResponse,

  refresh: async () =>
    unwrapBody(
      await api.POST("/api/admin/catalog/refresh"),
    ) as CatalogRefreshResult,

  hardRefresh: () =>
    unspecced.post<CatalogRefreshResult>("/api/admin/catalog/hard-refresh"),

  updateModel: async (modelId, patch) => {
    unwrapBody(
      await api.PUT("/api/admin/catalog/models/{modelId}", {
        params: { path: { modelId } },
        body: patch,
      }),
    );
  },

  updateDefaults: async defaults => {
    unwrapBody(
      await api.PUT("/api/admin/catalog/defaults", { body: { ...defaults } }),
    );
  },
}));
