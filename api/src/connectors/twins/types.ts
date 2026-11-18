/**
 * Built-in connector types whose in-process code was deleted from the API.
 *
 * Each one has a folder port in Mako's `connectors/<slug>/`, published to the
 * connector registry as `mako/<slug>`. A connection stored with one of these
 * bare types (`close`, `stripe`, …) keeps its type in Mongo and now runs that
 * folder in a box: its "registry twin". No data migration rewrites `type`.
 *
 * No imports with side effects here: the type checks are read on hot paths
 * and by modules that must not pull the sandbox runtime in.
 */
import { BUILTIN_TWIN_CATALOG } from "./builtin-catalog";

export type BuiltinTwinType = keyof typeof BUILTIN_TWIN_CATALOG;

export const BUILTIN_TWIN_TYPES = Object.keys(
  BUILTIN_TWIN_CATALOG,
) as BuiltinTwinType[];

/** The registry range a twin resolves in: the major the port shipped as. */
export const BUILTIN_TWIN_RANGE = "1";

export function isBuiltinTwinType(
  type: string | undefined | null,
): type is BuiltinTwinType {
  return (
    typeof type === "string" &&
    Object.prototype.hasOwnProperty.call(BUILTIN_TWIN_CATALOG, type)
  );
}

/** `close` -> `ws:close`: the type the twin's box run carries. */
export function twinWorkspaceType(type: BuiltinTwinType): string {
  return `ws:${type}`;
}
