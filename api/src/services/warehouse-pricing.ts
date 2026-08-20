/**
 * Warehouse cost estimation from bytes scanned.
 *
 * Only per-query-metered engines get a dollar figure; provisioned engines
 * (Postgres, MySQL, MongoDB, …) have no per-query price and return null.
 * Rates are list-price constants — good enough for a guilt meter, clearly
 * labeled "estimated" in the UI. Region/edition discounts are ignored.
 */

const BYTES_PER_TIB = 1024 ** 4;

/** BigQuery on-demand analysis, USD per TiB scanned (US multi-region list). */
const BIGQUERY_USD_PER_TIB = 6.25;

export function estimateWarehouseCostUsd(
  databaseType: string,
  bytesScanned: number,
): number | null {
  if (!Number.isFinite(bytesScanned) || bytesScanned <= 0) {
    return databaseType === "bigquery" ? 0 : null;
  }
  switch (databaseType) {
    case "bigquery":
      return (bytesScanned / BYTES_PER_TIB) * BIGQUERY_USD_PER_TIB;
    default:
      return null;
  }
}
