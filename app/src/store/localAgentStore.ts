import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { localAgentClient } from "../lib/local-agent-client";
import { isMakoDesktop } from "../lib/desktop";

/**
 * Set once this browser has seen the Local Agent answer. Background probes
 * (page load, explorer mount) only run inside Mako Desktop or once the agent
 * has been seen here, so users without it do not get a refused loopback
 * request (and a console error) on every load. Explicit checks — opening the
 * model menu, the Coding Agents settings, a local connection in the create
 * dialog — always probe, which is how the agent is first detected.
 */
const AGENT_SEEN_KEY = "mako.localAgent.seen";

function readAgentSeen(): boolean {
  try {
    return localStorage.getItem(AGENT_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeAgentSeen(): void {
  try {
    localStorage.setItem(AGENT_SEEN_KEY, "1");
  } catch {
    // Storage unavailable (private mode / quota): background probes simply
    // stay off until the next explicit check.
  }
}

export function shouldAutoProbeLocalAgent(): boolean {
  return isMakoDesktop() || readAgentSeen();
}

export type LocalAgentStatus = "unknown" | "online" | "offline";

interface LocalAgentState {
  status: LocalAgentStatus;
  version: string | null;
  checking: boolean;

  /** Probe the agent; safe to call repeatedly (dedupes in-flight checks). */
  checkAgent: () => Promise<LocalAgentStatus>;
  /** Probe only when the status is still unknown. */
  ensureChecked: () => Promise<LocalAgentStatus>;
  /**
   * Background variant of ensureChecked: never probes a browser that has not
   * seen the agent (see shouldAutoProbeLocalAgent); resolves "unknown" then.
   */
  autoCheck: () => Promise<LocalAgentStatus>;
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
        if (health) writeAgentSeen();
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

    autoCheck: async () => {
      const { status } = get();
      if (status !== "unknown") return status;
      if (!shouldAutoProbeLocalAgent()) return "unknown";
      return get().checkAgent();
    },
  })),
);
