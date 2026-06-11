import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { localAgentClient } from "../lib/local-agent-client";

export type LocalAgentStatus = "unknown" | "online" | "offline";

interface LocalAgentState {
  status: LocalAgentStatus;
  version: string | null;
  checking: boolean;

  /** Probe the agent; safe to call repeatedly (dedupes in-flight checks). */
  checkAgent: () => Promise<LocalAgentStatus>;
  /** Probe only when the status is still unknown. */
  ensureChecked: () => Promise<LocalAgentStatus>;
}

let inFlightCheck: Promise<LocalAgentStatus> | null = null;

export const useLocalAgentStore = create<LocalAgentState>()(
  immer((set, get) => ({
    status: "unknown",
    version: null,
    checking: false,

    checkAgent: async () => {
      if (inFlightCheck) return inFlightCheck;

      inFlightCheck = (async () => {
        set(s => {
          s.checking = true;
        });
        const health = await localAgentClient.ping();
        const status: LocalAgentStatus = health ? "online" : "offline";
        set(s => {
          s.status = status;
          s.version = health?.version ?? null;
          s.checking = false;
        });
        return status;
      })().finally(() => {
        inFlightCheck = null;
      });

      return inFlightCheck;
    },

    ensureChecked: async () => {
      const { status } = get();
      if (status !== "unknown") return status;
      return get().checkAgent();
    },
  })),
);
