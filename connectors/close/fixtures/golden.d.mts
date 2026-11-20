// Types for golden.mjs.
export const GOLDEN_DIR: string;
export function goldenFile(entity: string): string;
export function goldenText(rows: unknown): string;
export function buildGolden(): Promise<Record<string, string>>;
