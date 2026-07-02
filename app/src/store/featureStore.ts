/**
 * Server feature flags store.
 *
 * Fetches `/api/features` once and exposes non-sensitive server flags to gate
 * UI variants (e.g. the unified Sync flow builder). Defaults to all-off until
 * the fetch resolves so the UI renders the stable legacy variant first.
 */
import { create } from "zustand";
import { api, unwrapBody } from "../api";

export interface ServerFeatures {
  unifiedSyncFlows: boolean;
}

const DEFAULT_FEATURES: ServerFeatures = {
  unifiedSyncFlows: false,
};

interface FeatureState {
  features: ServerFeatures;
  loaded: boolean;
  init: () => Promise<void>;
}

let inflight: Promise<void> | null = null;

export const useFeatureStore = create<FeatureState>()((set, get) => ({
  features: DEFAULT_FEATURES,
  loaded: false,

  init: async () => {
    if (get().loaded) return;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const data = unwrapBody(await api.GET("/api/features")) as
          | ServerFeatures
          | undefined;
        set({
          features: { ...DEFAULT_FEATURES, ...(data ?? {}) },
          loaded: true,
        });
      } catch {
        // Flags are progressive enhancement — fall back to legacy UI.
        set({ features: DEFAULT_FEATURES, loaded: true });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
}));

export const selectUnifiedSyncFlows = (state: FeatureState) =>
  state.features.unifiedSyncFlows;
