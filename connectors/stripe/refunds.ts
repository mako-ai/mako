/** A complete Stripe refund can omit the reason once it is no longer pending. */
export function completeRefund<Row extends object>(row: Row) {
  return "pending_reason" in row && row.pending_reason !== undefined
    ? row
    : { ...row, pending_reason: null };
}
