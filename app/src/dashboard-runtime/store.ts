import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { reduceDashboardRuntimeEvent } from "./reducer";
import type { DashboardRuntimeEvent, DashboardRuntimeState } from "./types";

interface DashboardRuntimeStoreState extends DashboardRuntimeState {
  dispatch: (event: DashboardRuntimeEvent) => void;
  clearDashboard: (dashboardId: string) => void;
}

export const useDashboardRuntimeStore = create<DashboardRuntimeStoreState>()(
  immer(set => ({
    activeDashboardId: null,
    sessions: {},

    dispatch: event => {
      set(state => {
        reduceDashboardRuntimeEvent(state, event);
      });
    },

    clearDashboard: dashboardId => {
      set(state => {
        delete state.sessions[dashboardId];
        if (state.activeDashboardId === dashboardId) {
          state.activeDashboardId = null;
        }
      });
    },
  })),
);
