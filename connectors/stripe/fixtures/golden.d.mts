// Types for golden.mjs.
export const GOLDEN_DIR: string;
export const CHECKSUM_SCENARIOS: string[];
export function goldenFile(scenario: string, entity: string): string;
export function goldenText(value: unknown): string;
export function rowsSha256(rows: unknown): string;
/** { "<path under golden/>": file text }. */
export function buildGolden(): Promise<Record<string, string>>;
export function recordCassettes(): Promise<void>;
