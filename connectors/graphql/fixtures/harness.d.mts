// Types for harness.mjs, for the API tests that import it.

export const FOLDER: string;
export const REPO_ROOT: string;
export const SDK_DIR: string;
export const RUNNER: string;
export const CASSETTE_DIR: string;
export const SINCE: string;
export const CONNECTION_ID: string;
export const WORKSPACE_ID: string;
export const FLOW_QUERIES: Array<Record<string, unknown> & { name: string }>;

export interface Scenario {
  name: string;
  maxIterations: number;
  since?: string;
  pageSize?: number;
  headerStyle?: "hasura";
  rateLimited?: boolean;
}
export const SCENARIOS: Scenario[];
export const RATE_LIMIT_SCENARIO: Scenario;

export interface GraphqlTestConfig {
  endpoint: string;
  headers: string;
  queries: Array<Record<string, unknown>>;
}

export interface ChunkState {
  offset: number;
  cursor: unknown;
  totalProcessed: number;
  totalCount: unknown;
  hasMore: boolean;
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
): GraphqlTestConfig;
export function scenarioConfig(
  token: string,
  server: { url: string },
  scenario: Scenario,
): Record<string, unknown>;
export function tokenFor(
  side: string,
  scenario: Scenario,
  entity: string,
): string;
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
export function readFolder(options: {
  entity: string;
  config: Record<string, unknown>;
  since?: string;
  maxIterations?: number;
}): Promise<{ rows: Array<Record<string, unknown>>; chunks: ChunkState[] }>;
