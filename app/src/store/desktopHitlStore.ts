/**
 * Pending human-in-the-loop jobs from Local Agent mako-desktop MCP
 * (ask_clarifying_questions / submit_plan) while Claude's tool call waits.
 */
import { create } from "zustand";

export type DesktopHitlToolName = "ask_clarifying_questions" | "submit_plan";

export interface DesktopHitlPending {
  jobId: string;
  toolName: DesktopHitlToolName;
  input: Record<string, unknown>;
  createdAt: number;
}

interface DesktopHitlState {
  pending: DesktopHitlPending | null;
  setPending: (pending: DesktopHitlPending) => void;
  clearPending: (jobId?: string) => void;
}

export const useDesktopHitlStore = create<DesktopHitlState>(set => ({
  pending: null,
  setPending: pending => set({ pending }),
  clearPending: jobId =>
    set(state => {
      if (!state.pending) return state;
      if (jobId && state.pending.jobId !== jobId) return state;
      return { pending: null };
    }),
}));
