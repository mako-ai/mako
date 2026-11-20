// Types for golden.mjs, for the API test that imports it.
export const GOLDEN_DIR: string;
export const GOLDEN_SCENARIOS: string[];
export function goldenText(value: unknown): string;
export function withoutClock<T>(value: T): T;
export function buildGolden(): Promise<Record<string, string>>;
export function recordCassettes(dir?: string): Promise<void>;
