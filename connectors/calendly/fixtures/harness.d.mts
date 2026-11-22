// Types for harness.mjs, for the API tests that import it.

export const FOLDER: string;
export const REPO_ROOT: string;
export const SDK_DIR: string;
export const RUNNER: string;
export const CASSETTE_DIR: string;
export const CLOCK: string;
export const SINCE: string;

export interface Scenario {
  name: string;
  maxIterations: number;
  since?: string;
  /** Rows per page (`__page_size`), Calendly's `count`. */
  pageSize?: number;
  rateLimited?: boolean;
}
export const SCENARIOS: Scenario[];
export const RATE_LIMIT_SCENARIO: Scenario;
export const RATE_LIMIT_ENTITIES: string[];
export const CONCURRENT_ENTITIES: Set<string>;

export interface CalendlyTestConfig {
  access_token: string;
  api_base_url?: string;
  __page_size?: number;
}

export interface ChunkState {
  position: Record<string, unknown>;
  hasMore: boolean;
}

export interface Run {
  rows: Array<Record<string, unknown>>;
  chunks: ChunkState[];
}

export interface FixtureServer {
  url: string;
  requests(token: string): string[];
  close(): Promise<void>;
}

export interface ReplayServer extends FixtureServer {
  misses: string[];
}

export interface FolderResult {
  code: number | null;
  messages: Array<Record<string, any>>;
  stderr: string;
  lines: string[];
}

export function folderEnv(): NodeJS.ProcessEnv;
export function ensureFolderInstalled(): void;
export function canonicalJson(value: unknown): string;
export function requestKey(
  method: string,
  rawUrl: string,
  serverUrl: string,
): string;
export function loadCassettes(dir?: string): Map<string, unknown>;
export function saveCassettes(
  byFile: Map<string, Map<string, unknown>>,
  dir?: string,
): void;
export function startReplayServer(
  interactions?: Map<string, unknown>,
): Promise<ReplayServer>;
export function startRecordingServer(dataset: unknown): Promise<
  FixtureServer & {
    recorded: Map<string, unknown>;
  }
>;
export function runFolderCommand(
  command: string,
  options?: {
    config?: Record<string, unknown>;
    catalog?: unknown;
    state?: unknown;
    maxIterations?: number;
    maxBytes?: number;
    batch?: unknown;
  },
): Promise<FolderResult>;
export function readFolder(options: {
  entity: string;
  config: Record<string, unknown>;
  since?: string;
  maxIterations?: number;
}): Promise<Run>;
export function runFolderWebhookMapping(input: {
  events?: unknown[];
  selections?: string[][];
}): Promise<{
  events: string[];
  eventsForEntities: string[][];
  outcomes: Array<Record<string, any>>;
}>;
export function tokenFor(
  prefix: string,
  scenario: Scenario,
  entity: string,
): string;
export function scenarioConfig(
  token: string,
  server: { url: string },
  scenario: Scenario,
): CalendlyTestConfig;
