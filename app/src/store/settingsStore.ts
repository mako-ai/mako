/**
 * Settings Store
 * Manages application settings including AI model selection
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, unwrapBody } from "../api";
import type {
  AIModel,
  ModelListResponse,
  GatewayModelInfo,
  GatewayModelsResponse,
  DisabledModelsResponse,
} from "../lib/api-types";

let modelsInFlight: Promise<void> | null = null;
let modelsRetryCount = 0;
const MAX_MODELS_RETRIES = 3;
const MODELS_RETRY_DELAYS = [2_000, 5_000, 10_000];
let modelsRetryTimer: ReturnType<typeof setTimeout> | null = null;
let gatewayModelsInFlight: Promise<void> | null = null;

interface SettingsState {
  // AI Model selection
  selectedModelId: string;
  setSelectedModelId: (modelId: string) => void;

  // Available models (workspace-filtered, used by chat)
  models: AIModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  fetchModels: () => Promise<void>;

  // Gateway model catalog (all models from Vercel gateway)
  gatewayModels: GatewayModelInfo[];
  gatewayModelsLoading: boolean;
  gatewayModelsError: string | null;
  fetchGatewayModels: () => Promise<void>;

  // Workspace-level model blocklist. Empty means "every curated model is
  // available" — new models the super admin makes visible auto-appear.
  disabledModelIds: string[];
  disabledModelsLoading: boolean;
  disabledModelsError: string | null;
  fetchDisabledModels: (workspaceId: string) => Promise<void>;
  saveDisabledModels: (
    workspaceId: string,
    disabledIds: string[],
  ) => Promise<boolean>;

  // General settings
  theme: "light" | "dark" | "system";
  setTheme: (theme: "light" | "dark" | "system") => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      // Default model — empty string means "use the first available model"
      selectedModelId: "",
      setSelectedModelId: modelId => set({ selectedModelId: modelId }),

      // Models list
      models: [],
      modelsLoading: false,
      modelsError: null,
      fetchModels: async () => {
        if (modelsInFlight) return modelsInFlight;

        const doFetch = async () => {
          set({ modelsLoading: true, modelsError: null });
          try {
            const response = unwrapBody(await api.GET("/api/agent/models")) as
              | ModelListResponse
              | { models: AIModel[]; recommendedModelId?: string | null };

            const models =
              "success" in response
                ? response.models || []
                : response.models || [];

            const recommended = response.recommendedModelId ?? null;

            set({ models });

            if (models.length > 0) {
              modelsRetryCount = 0;
              const current = get().selectedModelId;
              // Local ACP models (Claude Code / Codex on this machine) are
              // client-only and never appear in the gateway catalog — keep them.
              const { isLocalAcpModelId } = await import(
                "../lib/local-acp-models"
              );
              const isAvailable =
                models.some(model => model.id === current) ||
                isLocalAcpModelId(current);
              if (!isAvailable) {
                // Prefer the platform default surfaced by the server over
                // the alphabetically-first model. This keeps free-plan users
                // on a free model and paid users on the curated paid default
                // when their previous selection gets hidden.
                const fallback =
                  recommended && models.some(m => m.id === recommended)
                    ? recommended
                    : models[0].id;
                set({ selectedModelId: fallback });
              }
            } else if (modelsRetryCount < MAX_MODELS_RETRIES) {
              const delay = MODELS_RETRY_DELAYS[modelsRetryCount] ?? 10_000;
              modelsRetryCount++;
              if (modelsRetryTimer) clearTimeout(modelsRetryTimer);
              modelsRetryTimer = setTimeout(() => {
                modelsRetryTimer = null;
                modelsInFlight = null;
                get().fetchModels();
              }, delay);
            }
          } catch (error) {
            if (modelsRetryCount < MAX_MODELS_RETRIES) {
              const delay = MODELS_RETRY_DELAYS[modelsRetryCount] ?? 10_000;
              modelsRetryCount++;
              if (modelsRetryTimer) clearTimeout(modelsRetryTimer);
              modelsRetryTimer = setTimeout(() => {
                modelsRetryTimer = null;
                modelsInFlight = null;
                get().fetchModels();
              }, delay);
            } else {
              set({ modelsError: "Failed to load models" });
            }
          } finally {
            set({ modelsLoading: false });
            modelsInFlight = null;
          }
        };

        modelsInFlight = doFetch();
        return modelsInFlight;
      },

      // Gateway model catalog
      gatewayModels: [],
      gatewayModelsLoading: false,
      gatewayModelsError: null,
      fetchGatewayModels: async () => {
        if (gatewayModelsInFlight) return gatewayModelsInFlight;

        const doFetch = async () => {
          set({ gatewayModelsLoading: true, gatewayModelsError: null });
          try {
            const response = unwrapBody(
              await api.GET("/api/agent/gateway-models"),
            ) as GatewayModelsResponse;
            set({ gatewayModels: response.models || [] });
          } catch (error) {
            set({ gatewayModelsError: "Failed to load gateway models" });
          } finally {
            set({ gatewayModelsLoading: false });
            gatewayModelsInFlight = null;
          }
        };

        gatewayModelsInFlight = doFetch();
        return gatewayModelsInFlight;
      },

      // Workspace model blocklist
      disabledModelIds: [],
      disabledModelsLoading: false,
      disabledModelsError: null,
      fetchDisabledModels: async (workspaceId: string) => {
        set({ disabledModelsLoading: true, disabledModelsError: null });
        try {
          const response = unwrapBody(
            await api.GET("/api/workspaces/{id}/settings/models", {
              params: { path: { id: workspaceId } },
            }),
          ) as DisabledModelsResponse;
          set({ disabledModelIds: response.disabledModelIds || [] });
        } catch (error) {
          set({ disabledModelsError: "Failed to load disabled models" });
        } finally {
          set({ disabledModelsLoading: false });
        }
      },
      saveDisabledModels: async (
        workspaceId: string,
        disabledIds: string[],
      ): Promise<boolean> => {
        try {
          unwrapBody(
            await api.PUT("/api/workspaces/{id}/settings/models", {
              params: { path: { id: workspaceId } },
              body: { disabledModelIds: disabledIds },
            }),
          );
          set({ disabledModelIds: [...disabledIds] });
          return true;
        } catch (error) {
          return false;
        }
      },

      // Theme defaults to system
      theme: "system",
      setTheme: theme => set({ theme: theme }),
    }),
    {
      name: "settings-storage",
      version: 1,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>;
        if (version === 0 && state.selectedModelId) {
          const id = state.selectedModelId as string;
          if (!id.includes("/")) {
            let provider = "anthropic";
            if (/^(gpt|o[0-9])/.test(id)) {
              provider = "openai";
            } else if (id.startsWith("gemini")) {
              provider = "google";
            }
            state.selectedModelId = `${provider}/${id}`;
          }
        }
        return state as unknown as SettingsState;
      },
      partialize: state => ({
        selectedModelId: state.selectedModelId,
        theme: state.theme,
      }),
    },
  ),
);
