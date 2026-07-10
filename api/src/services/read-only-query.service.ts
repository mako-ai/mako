import { checkPreviewQuerySafety } from "./query-pagination.service";

export const QUERY_WRITE_SCOPE_REQUIRED =
  "Mako MCP access is read-only: the query was rejected because it is not a " +
  "single read-only SELECT/WITH statement. Database writes are not supported " +
  "over MCP — run them with your own database tooling.";

export const MONGO_QUERY_WRITE_SCOPE_REQUIRED =
  "Arbitrary MongoDB JavaScript execution is not available over MCP (access " +
  "is read-only). You can still list databases and collections and inspect " +
  "collection schemas with sample documents.";

export function sqlReadOnlyAccessError(query: string): string | null {
  const safety = checkPreviewQuerySafety(query);
  if (safety.safe) return null;
  return `${QUERY_WRITE_SCOPE_REQUIRED} ${safety.errors.join(" ")}`;
}
