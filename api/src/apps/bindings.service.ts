/**
 * Apps data bindings — bindings-as-files (apps.md decision log).
 *
 * Unlike v1's Mongo `dataBindings` array, a v2 binding is REPO CONTENT,
 * versioned and branchable with the app:
 *
 *   bindings/<name>.sql → front matter (-- connection:, -- schedule:, ...)
 *                         + the query; name = filename, discovery = glob
 *
 * The agent authors bindings with the ordinary file tools (app_write_file /
 * app_edit_file) — no bespoke binding CRUD. Materialization reuses v1's
 * parquet pipeline (buildQueryParquetFile + artifact store) with artifacts
 * keyed `apps/<projectId>/<name>.parquet`; the preview runtime serves
 * them at the app-relative path `__data/<name>.parquet`, which resolves
 * under the token prefix in BOTH static and dev previews, so app code just
 * fetches a relative URL and reads it with DuckDB-WASM (v1's useRows
 * pattern ports over with a one-line URL change).
 *
 * The implementation lives in `./bindings/`; this barrel keeps the import
 * path:
 *
 *   state.ts       derived runtime state per binding (runs, refresh claims)
 *   definition.ts  a binding file: front matter, identity, artifact keys, reads
 *   build.ts       building a binding's parquet and materializing it
 */
export {
  getBindingState,
  recordBindingRun,
  claimPublicBindingRefresh,
} from "./bindings/state";
export type { AppBindingRun, AppBindingStateDoc } from "./bindings/state";
export {
  bindingDefinitionHash,
  bindingArtifactKey,
  bindingArtifactKeyByName,
  isFileMissingError,
  readCommittedBinding,
  readMainBinding,
  BindingNotFoundError,
  normalizeBindingText,
  sameBindingDefinition,
  readBindingMaterialization,
  parseBindingFrontMatter,
  stripBindingFrontMatter,
  readBindings,
  readBindingsTolerant,
  bindingFromSource,
} from "./bindings/definition";
export type {
  AppBinding,
  BindingArtifactIdentity,
  BindingsReadResult,
} from "./bindings/definition";
export {
  resolveDraftBinding,
  buildBindingParquet,
  buildResolvedBindingParquet,
  BindingRowLimitError,
  materializeAppBinding,
  adoptBindingArtifact,
} from "./bindings/build";
export type { MaterializeOptions, MaterializeResult } from "./bindings/build";
