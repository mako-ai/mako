// Types for harness.mjs, for the API test that imports it.

export const FOLDER: string;
export const REPO_ROOT: string;
export const SDK_DIR: string;
export const RUNNER: string;
export const CASSETTE_DIR: string;
export const SINCE: string;
export const CONNECTION_ID: string;
export const WORKSPACE_ID: string;
export const ENTITIES: Array<Record<string, unknown> & { name: string }>;

export interface Scenario {
  name: string;
  maxIterations: number;
  since?: string;
  pageSize?: number;
  headerStyle?: "api-key";
  settingsBatch?: number;
}
export const SCENARIOS: Scenario[];
export interface RestTestConfig {
  api_base_url: string;
  headers: string;
  entities: Array<Record<string, unknown>>;
}

export interface ChunkState {
  page: number;
  offset: number;
  cursor: unknown;
  totalProcessed: number;
  totalCount: unknown;
  hasMore: boolean;
}

export interface SourceTimestamps {
  byId: Map<string, string | null>;
  fellBackToNow: number;
}

export interface Run {
  rows: Array<Record<string, unknown>>;
  chunks: ChunkState[];
}

export interface ReadableConnector {
  fetchEntityChunk(options: any): Promise<any>;
  resolveSchema?(entity: string): Promise<unknown>;
  normalizeBackfillRecord?(
    entity: string,
    record: Record<string, unknown>,
  ): { sourceTs: Date } | null;
}

export interface FixtureServer {
  url: string;
  requests(token: string): string[];
  requestKeys(token: string): string[];
  close(): Promise<void>;
}
export interface ReplayServer extends FixtureServer {
  misses: string[];
}

export interface FolderCommandResult {
  code: number | null;
  messages: Array<Record<string, any>>;
  stderr: string;
}

export function ensureFolderInstalled(): void;
export function canonicalJson(value: unknown): string;
export function requestKey(
  method: string,
  rawUrl: string,
  body?: string,
): string;
export function testConfig(
  token: string,
  server: { url: string },
  scenario?: Partial<Scenario>,
): RestTestConfig;
export function tokenFor(
  side: string,
  scenario: { name: string },
  entity: string,
): string;
export function scenarioConfig(
  token: string,
  server: { url: string },
  scenario: Scenario,
): Record<string, unknown>;
export function loadCassettes(
  dir?: string,
): Map<string, { status: number; body: unknown }>;
export function startReplayServer(
  interactions?: Map<string, { status: number; body: unknown }>,
): Promise<ReplayServer>;
export function runFolderCommand(
  command: "spec" | "check" | "discover" | "read" | "webhook",
  options?: {
    config?: Record<string, unknown>;
    catalog?: unknown;
    state?: unknown;
    maxIterations?: number;
    maxBytes?: number;
    env?: Record<string, string>;
  },
): Promise<FolderCommandResult>;
export function streamPosition(source: unknown, hasMore: unknown): ChunkState;
export function readFolder(options: {
  entity: string;
  config: Record<string, unknown>;
  since?: string;
  maxIterations: number;
}): Promise<Run>;
export function readBoxed(
  connector: ReadableConnector,
  options: {
    entity: string;
    since?: string;
    maxIterations: number;
    pageSize?: number;
  },
): Promise<Run>;
export function sourceTimestamps(
  connector: ReadableConnector,
  entity: string,
  rows: Array<Record<string, unknown>>,
): SourceTimestamps;
