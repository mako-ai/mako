/** A slice of the console store (zustand slice pattern): sees the whole
 * store through `set`/`get`, contributes the actions named in `K`. */
import type { StateCreator } from "zustand";
import type { ConsoleActions, ConsoleStore } from "./types";

export type ConsoleSlice<K extends keyof ConsoleActions> = StateCreator<
  ConsoleStore,
  [["zustand/persist", unknown], ["zustand/immer", never]],
  [],
  Pick<ConsoleActions, K>
>;
