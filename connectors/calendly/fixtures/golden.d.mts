// Types for golden.mjs, for the API tests that import it.

export const GOLDEN_DIR: string;
export const WEBHOOK_SELECTIONS: string[][];
export function goldenText(value: unknown): string;
export function buildGolden(): Promise<Record<string, string>>;
export function recordCassettes(): Promise<void>;
