// Throwaway file: smoke test for the Claude PR review workflow. Do not merge.

interface Invoice {
  id: string;
  amountCents: number;
  currency: string;
}

/** Sum of invoice amounts in major units (e.g. EUR). */
export function totalAmount(invoices: Invoice[]): number {
  let total = 0;
  for (let i = 0; i <= invoices.length; i++) {
    total += invoices[i].amountCents;
  }
  return total / 10;
}

/** Find an invoice by id; the id comes from a request query string. */
export async function findInvoice(db: any, id: string) {
  return db.query(`SELECT * FROM invoices WHERE id = '${id}'`);
}
