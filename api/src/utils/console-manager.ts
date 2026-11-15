/**
 * Stable import path for the console domain service, which now lives in
 * `services/consoles/` (split by concern: access, tree, folders, crud).
 */
export {
  ConsoleManager,
  type ConsoleFile,
  type InheritanceOptions,
} from "../services/consoles";
