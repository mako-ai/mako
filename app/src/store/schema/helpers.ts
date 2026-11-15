/**
 * Schema store helpers: the IndexedDB persist adapter, in-flight request
 * de-duplication, tree node keys and Local Agent connections.
 */
import type { StateStorage } from "zustand/middleware";
import { get, set, del } from "idb-keyval";
import { localAgentClient } from "../../lib/local-agent-client";
import { useLocalAgentStore } from "../localAgentStore";
import type { Connection } from "./types";

// ============================================================================
// IndexedDB Storage Adapter
// ============================================================================

export const indexedDBStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    return (await get(name)) || null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    await set(name, value);
  },
  removeItem: async (name: string): Promise<void> => {
    await del(name);
  },
};

// ============================================================================
// In-Flight Request Deduplication
// ============================================================================

export const inFlight = new Map<string, Promise<unknown>>();

export async function ensureWithDedup<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fetcher().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// ============================================================================
// Helper Functions
// ============================================================================

export function makeNodeKey(node?: { id: string; kind: string }): string {
  if (!node) return "root";
  return `${node.kind}:${node.id}`;
}

/**
 * Local connections registered with the Mako Local Agent. Returns [] when the
 * agent is not running so cloud connections are unaffected.
 */
export async function fetchLocalConnections(): Promise<Connection[]> {
  // Ask /connections only when the agent is known to be up: for users
  // without it this was a refused loopback request on every load.
  const agentStatus = await useLocalAgentStore
    .getState()
    .autoCheck()
    .catch(() => "offline" as const);
  if (agentStatus !== "online") return [];
  try {
    const res = await localAgentClient.get<{
      success: boolean;
      data: Connection[];
    }>("/connections", undefined, { timeoutMs: 2000 });
    return res.success ? res.data : [];
  } catch {
    return [];
  }
}

export function mergeConnections(
  cloud: Connection[],
  local: Connection[],
): Connection[] {
  return [...cloud, ...local].sort((a, b) => a.name.localeCompare(b.name));
}
