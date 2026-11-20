// Types for harness.mjs, for the API test that imports it.

export const SLUG: string;
export const FOLDER: string;
export const REPO_ROOT: string;
export const SDK_DIR: string;
export const RUNNER: string;
export const CASSETTE_DIR: string;
export const CLOCK: string;
export const FIXTURE_NOW: string;
export const SINCE: string;
export const ENTITIES: string[];

export interface Scenario {
  name: string;
  maxIterations: number;
  since?: string;
  pageSize?: number;
  rateLimited?: boolean;
  quota?: boolean;
  config?: Record<string, unknown>;
}
export const SCENARIOS: Scenario[];
export const RATE_LIMIT_SCENARIO: Scenario;
export const RATE_LIMIT_ENTITIES: string[];
export const QUOTA_SCENARIO: Scenario;
export const QUOTA_START: number;

export interface ChunkState {
  position: Record<string, unknown>;
  hasMore: boolean;
}

export interface Run {
  rows: Array<Record<string, any>>;
  chunks: ChunkState[];
}

export interface FixtureServer {
  url: string;
  requests(apiKey: string): string[];
  close(): Promise<void>;
}

export interface ReplayServer extends FixtureServer {
  misses: string[];
}

export interface FolderRun {
  code: number | null;
  messages: Array<Record<string, any>>;
  stderr: string;
}

export function folderEnv(config?: Record<string, unknown>): NodeJS.ProcessEnv;
export function freezeClock(): () => void;
export function ensureFolderInstalled(): void;
export function canonicalJson(value: unknown): string;
export function requestKey(method: string, rawUrl: string): string;
export function loadCassettes(dir?: string): Map<string, unknown>;
export function startReplayServer(): Promise<ReplayServer>;
export function runFolderCommand(
  command: string,
  options?: {
    config?: Record<string, unknown>;
    catalog?: unknown;
    state?: unknown;
    batch?: unknown;
    maxIterations?: number;
    maxBytes?: number;
  },
): Promise<FolderRun>;
export function positionOf(state: unknown): Record<string, unknown>;
export function readFolder(
  options: {
    entity: string;
    config: Record<string, unknown>;
    since?: string;
    maxIterations?: number;
  },
  out?: Run,
): Promise<Run>;
export function masked<T>(row: T): T;
