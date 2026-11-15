/**
 * Destination writing for flows. The implementation lives in
 * `./destination-writer/*`; this path stays the import every caller uses.
 *
 *   writer               DestinationWriter (engine-agnostic + SQL engine)
 *   mongo-target         the MongoDB engine
 *   db-sync              database-to-database chunks and the dry run
 *   query-introspection  row-count estimate, max tracking value, LIMIT 1 probe
 *   query-safety         read-only checks for source queries
 *   type-coercion        per-column coercions for rows and schema
 */
export type {
  DbSyncChunkResult,
  DbSyncChunkState,
  DestinationConfig,
  WriteOptions,
  WriteResult,
} from "./destination-writer/types";
export {
  DestinationWriter,
  createDestinationWriter,
} from "./destination-writer/writer";
export {
  estimateQueryRowCount,
  getMaxTrackingValue,
  validateQuery,
} from "./destination-writer/query-introspection";
export {
  checkQuerySafety,
  type QuerySafetyResult,
} from "./destination-writer/query-safety";
export {
  applyTypeCoercions,
  applyTypeCoercionsToSchema,
} from "./destination-writer/type-coercion";
export { dryRunDbSync, executeDbSyncChunk } from "./destination-writer/db-sync";
