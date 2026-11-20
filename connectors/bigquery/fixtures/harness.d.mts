// Types for harness.mjs, for the API test that imports it.

export const FOLDER: string;
export const REPO_ROOT: string;
export const SDK_DIR: string;
export const RUNNER: string;
export const CASSETTE_DIR: string;
export const SINCE: string;
export const CONNECTION_ID: string;
export const WORKSPACE_ID: string;
export const CONNECTION_QUERIES: Array<
  Record<string, unknown> & { name: string }
>;
export const PROJECT_ID: string;
export const JOB_LOCATION: string;
export const CHUNK_ATTEMPTS: number;
export const TEST_PRIVATE_KEY: string;

export interface Scenario {
  name: string;
  maxIterations: number;
  since?: string;
  pageSize?: number;
  location?: string;
  rateLimited?: boolean;
}
export const SCENARIOS: Scenario[];
export const RATE_LIMIT_SCENARIO: Scenario;

export interface BigQueryTestConfig {
  service_account_json: string;
  project_id: string;
  api_base_url: string;
  location?: string;
  queries: Array<Record<string, unknown>>;
}

export interface FixtureServer {
  url: string;
  requests(run: string): string[];
  requestKeys(run: string): string[];
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
export function serviceAccountJson(
  run: string,
  server: { url: string },
): string;
export function testConfig(
  run: string,
  server: { url: string },
  scenario?: Partial<Scenario>,
): BigQueryTestConfig;
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
