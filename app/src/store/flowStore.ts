/**
 * Flow store. The actions live in slices under `./flow/` (list/lifecycle,
 * CDC, monitoring); this module composes them and owns persistence. The
 * persist key, the validated storage adapter and `partialize` are unchanged
 * — changing them would wipe users' cached flows.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { createFlowCdcSlice } from "./flow/cdc-slice";
import { initialFlowState } from "./flow/initial-state";
import { createFlowListSlice } from "./flow/list-slice";
import { createFlowMonitorSlice } from "./flow/monitor-slice";
import { flowStoreStateSchema, type FlowStore } from "./flow/types";
import { createValidatedStorage } from "./store-validation";

export type {
  CdcDiagnostics,
  CdcStatus,
  CdcSummary,
  Flow,
  FlowExecutionHistory,
  FlowQuery,
  FlowStore,
} from "./flow/types";

export const useFlowStore = create<FlowStore>()(
  persist(
    immer((...a) => ({
      ...initialFlowState,
      ...createFlowListSlice(...a),
      ...createFlowCdcSlice(...a),
      ...createFlowMonitorSlice(...a),
    })),
    {
      name: "flow-store-v2",
      storage: createValidatedStorage(
        flowStoreStateSchema,
        "flow-store-v2",
        initialFlowState,
      ),
      partialize: state => ({
        flows: state.flows,
        selectedFlowId: state.selectedFlowId,
        executionHistory: state.executionHistory,
      }),
    },
  ),
);
