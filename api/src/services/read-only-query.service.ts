import { checkPreviewQuerySafety } from "./query-pagination.service";

export const QUERY_WRITE_SCOPE_REQUIRED =
  "This API key only has query:read access. The query was rejected because " +
  "it is not a single read-only SELECT/WITH statement. Create a separate key " +
  "with query:write only when database writes are explicitly required.";

export const MONGO_QUERY_WRITE_SCOPE_REQUIRED =
  "Arbitrary MongoDB JavaScript queries require the query:write scope. " +
  "A query:read key can still list databases and collections and inspect " +
  "collection schemas with sample documents.";

export function sqlReadOnlyAccessError(query: string): string | null {
  const safety = checkPreviewQuerySafety(query);
  if (safety.safe) return null;
  return `${QUERY_WRITE_SCOPE_REQUIRED} ${safety.errors.join(" ")}`;
}
