/** A slice of the apps store (zustand slice pattern): sees the whole store
 * through `set`/`get`, contributes the members named in `K`. */
import type { StateCreator } from "zustand";
import type { AppsStore } from "./types";

export type AppsSlice<K extends keyof AppsStore> = StateCreator<
  AppsStore,
  [["zustand/persist", unknown], ["zustand/immer", never]],
  [],
  Pick<AppsStore, K>
>;
