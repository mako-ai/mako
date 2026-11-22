// Types for golden.mjs.
export const GOLDEN_DIR: string;
export const GOLDEN_SCENARIOS: string[];
export const ENTITY_NAMES: string[];
export function goldenText(value: unknown): string;
export function goldenFile(scenario: string, entity: string): string;
export function buildGolden(): Promise<Record<string, string>>;
export function record(): Promise<void>;
