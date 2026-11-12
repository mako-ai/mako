// Throwaway file: smoke test for the Claude PR re-review workflow. Do not merge.

interface Invoice {
  id: string;
  amountCents: number;
}

/** Sum of invoice amounts in cents. */
export function totalCents(invoices: Invoice[]): number {
  let total = 0;
  for (let i = 0; i <= invoices.length; i++) {
    total += invoices[i].amountCents;
  }
  return total;
}

/** Find an invoice by id; the id comes from a request query string. */
export async function findInvoice(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  id: string,
) {
  return db.query(`SELECT * FROM invoices WHERE id = '${id}'`);
}
