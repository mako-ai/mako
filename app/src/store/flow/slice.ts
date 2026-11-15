/** A slice of the flow store (zustand slice pattern): sees the whole store
 * through `set`/`get`, contributes the members in `T`. */
import type { StateCreator } from "zustand";
import { toErrorMessage, unwrapBody, type ApiResult } from "../../api";
import type { FlowStore } from "./types";

export type FlowSlice<T> = StateCreator<
  FlowStore,
  [["zustand/persist", unknown], ["zustand/immer", never]],
  [],
  T
>;

type FlowSet = Parameters<FlowSlice<unknown>>[0];

/**
 * The shape every flow command shares: POST, expect `{ success, error? }`,
 * record a failure under `error[workspaceId]`, resolve true on success.
 * `onSuccess` runs before resolving (e.g. refetch the list).
 */
export async function runFlowCommand(
  set: FlowSet,
  workspaceId: string,
  fallbackError: string,
  request: () => Promise<ApiResult>,
  onSuccess?: () => Promise<unknown>,
): Promise<boolean> {
  try {
    const response = unwrapBody(await request()) as {
      success: boolean;
      error?: string;
    };
    if (!response.success) {
      throw new Error(response.error || fallbackError);
    }
    await onSuccess?.();
    return true;
  } catch (error) {
    set(state => {
      state.error[workspaceId] = toErrorMessage(error);
    });
    return false;
  }
}
