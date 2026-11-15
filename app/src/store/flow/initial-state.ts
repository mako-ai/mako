import type { FlowStoreState } from "./types";

export const initialFlowState: FlowStoreState = {
  flows: {},
  loading: {},
  error: {},
  selectedFlowId: null,
  executionHistory: {},
};
