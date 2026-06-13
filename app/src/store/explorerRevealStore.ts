/**
 * Explorer reveal store
 *
 * Tiny cross-component channel for "scroll the sidebar explorer to this row".
 * A producer (tab-switch effect, clickable breadcrumb) calls `requestReveal`;
 * the matching explorer reads the request and threads `revealNodeId` /
 * `revealNonce` into its `ResourceTree`, which expands ancestors and scrolls
 * the row into view. The monotonically-increasing `nonce` lets the same node
 * be revealed repeatedly (e.g. re-clicking a breadcrumb).
 *
 * Not persisted — it's ephemeral UI intent.
 */
import { create } from "zustand";
import type { RevealExplorer } from "../lib/explorer-reveal";

export interface ExplorerRevealRequest {
  explorer: RevealExplorer;
  nodeId: string;
  nonce: number;
}

interface ExplorerRevealStore {
  request: ExplorerRevealRequest | null;
  requestReveal: (explorer: RevealExplorer, nodeId: string) => void;
}

export const useExplorerRevealStore = create<ExplorerRevealStore>()(
  (set, get) => ({
    request: null,
    requestReveal: (explorer, nodeId) =>
      set({
        request: {
          explorer,
          nodeId,
          nonce: (get().request?.nonce ?? 0) + 1,
        },
      }),
  }),
);

/**
 * Selector factory: returns the current reveal request only when it targets
 * `explorer`, else `null`. Lets each explorer subscribe to just its own
 * requests without re-rendering on unrelated reveals.
 */
export const selectRevealFor =
  (explorer: RevealExplorer) =>
  (state: ExplorerRevealStore): ExplorerRevealRequest | null =>
    state.request && state.request.explorer === explorer ? state.request : null;
