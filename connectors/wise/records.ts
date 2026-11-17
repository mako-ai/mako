/**
 * Wise record shaping: ids, dates, money values and statement rows. The
 * in-process `api/src/connectors/wise/records.ts`, unchanged.
 */

/** Coerce Wise numeric ids onto a string `id` key column. */
export function withStringId(
  record: Record<string, unknown>,
  preferredKeys: string[] = ["id"],
): Record<string, unknown> {
  if (record == null) return record;
  for (const key of preferredKeys) {
    const value = record[key];
    if (value != null && String(value).length > 0) {
      return { ...record, id: String(value) };
    }
  }
  return record;
}

export function parseWiseDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;

  const trimmed = value.trim();
  // Transfers use "YYYY-MM-DD HH:mm:ss" without a timezone — treat as UTC.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Timestamp fields in the order a record's source time is read from. */
const TIMESTAMP_FIELDS = [
  "occurred_at",
  "modificationTime",
  "updatedOn",
  "updatedAt",
  "updated_at",
  "createdOn",
  "createdAt",
  "created_at",
  "creationTime",
  "created",
  "sent_at",
  "date",
];

/** The first parseable timestamp of a Wise record, or null. */
export function wiseRecordTimestamp(
  payload?: Record<string, unknown>,
): Date | null {
  for (const field of TIMESTAMP_FIELDS) {
    const date = parseWiseDate(payload?.[field]);
    if (date) return date;
  }
  return null;
}

function moneyValue(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "object" && "value" in (value as object)) {
    const v = (value as { value?: unknown }).value;
    return typeof v === "number" ? v : v == null ? null : Number(v);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One balance-statement transaction as a flat record keyed per balance. */
export function toStatementRecord(
  transaction: Record<string, unknown>,
  balance: { id: string; currency: string },
  profileId: string,
): Record<string, unknown> {
  const details = (transaction.details ?? {}) as Record<string, unknown>;
  const reference = String(transaction.referenceNumber ?? "");
  const type = String(transaction.type ?? "");
  const date = String(transaction.date ?? "");
  return {
    // a reference can appear on several balances (a conversion debits one
    // and credits another) and twice on one (a card payment and its refund)
    id: `${balance.id}:${reference}:${type}:${date}`,
    profileId,
    balanceId: balance.id,
    currency: balance.currency,
    referenceNumber: reference || null,
    type: type || null,
    date: date || null,
    amount: moneyValue(transaction.amount),
    totalFees: moneyValue(transaction.totalFees),
    runningBalance: moneyValue(transaction.runningBalance),
    detailsType: typeof details.type === "string" ? details.type : null,
    description:
      typeof details.description === "string" ? details.description : null,
    details: transaction.details ?? null,
    exchangeDetails: transaction.exchangeDetails ?? null,
  };
}
