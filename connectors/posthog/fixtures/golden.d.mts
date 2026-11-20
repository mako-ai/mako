// Types for golden.mjs.
export const GOLDEN_DIR: string;
export const GOLDEN_SCENARIOS: Array<{
  name: string;
  suffix: string;
  maxIterations: number;
  since?: string;
}>;
export function goldenFile(
  entity: string,
  scenario: { suffix: string },
): string;
export function goldenText(value: unknown): string;
export function buildGolden(): Promise<Record<string, string>>;
export function record(): Promise<void>;
