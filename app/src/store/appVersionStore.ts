import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";

/**
 * Detects when the running frontend bundle is stale (a newer version has been
 * deployed). This matters most for the desktop app, where the window can stay
 * open for days and nobody ever refreshes.
 *
 * The build ID is baked into the bundle at build time (git SHA in CI) and the
 * server reports the currently-deployed build ID at GET /api/version.
 */

// "dev" locally (no VITE_BUILD_ID) — version checks are skipped entirely.
export const CURRENT_BUILD_ID: string = import.meta.env.VITE_BUILD_ID || "dev";

interface AppVersionState {
  /** A newer build than the one currently loaded has been deployed */
  updateAvailable: boolean;
  /** Build ID reported by the server when the update was detected */
  latestBuildId: string | null;
  /** User dismissed the update notification (until next page load) */
  dismissed: boolean;

  checkForUpdate: () => Promise<void>;
  dismiss: () => void;
  reloadToUpdate: () => void;
}

export const useAppVersionStore = create<AppVersionState>()(
  immer((set, get) => ({
    updateAvailable: false,
    latestBuildId: null,
    dismissed: false,

    checkForUpdate: async () => {
      // Local dev builds have no meaningful build ID; nothing to compare.
      if (CURRENT_BUILD_ID === "dev") return;
      // Already detected — no need to keep polling.
      if (get().updateAvailable) return;

      try {
        const response = await apiClient.get<{ buildId?: string }>("/version");
        const serverBuildId = response?.buildId;
        if (
          serverBuildId &&
          serverBuildId !== "dev" &&
          serverBuildId !== CURRENT_BUILD_ID
        ) {
          set(state => {
            state.updateAvailable = true;
            state.latestBuildId = serverBuildId;
          });
        }
      } catch {
        // Network errors (offline, server restarting mid-deploy) are
        // expected; the next scheduled check will retry.
      }
    },

    dismiss: () => {
      set(state => {
        state.dismissed = true;
      });
    },

    reloadToUpdate: () => {
      window.location.reload();
    },
  })),
);
