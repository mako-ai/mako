// Types for dataset.mjs.
export const SIGNED_ORIGIN: string;
export const DOCUMENT_LIST_FIELDS: string[];
export function buildDataset(): Record<string, any>;
export function emulate(
  dataset: unknown,
  method: string,
  rawUrl: string,
): { status: number; body: any };
