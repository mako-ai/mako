// Types for golden.mjs.
export const GOLDEN_DIR: string;
export const SINCE_ENTITIES: string[];
export function goldenFile(entity: string): string;
export function goldenText(rows: unknown): string;
/** { "<path under golden/>": file text }. */
export function buildGolden(): Promise<Record<string, string>>;
export function recordCassettes(): Promise<void>;
