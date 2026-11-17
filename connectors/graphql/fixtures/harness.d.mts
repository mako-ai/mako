// Types for harness.mjs, for the API test that imports it.

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

export interface SourceTimestamps {
  byId: Map<string, string | null>;
  fellBackToNow: number;
}

export interface Run {
  rows: Array<Record<string, unknown>>;
  chunks: ChunkState[];
  requests?: string[];
  timestamps?: SourceTimestamps;
}

export interface ReadableConnector {
  fetchEntityChunk(options: any): Promise<any>;
  testConnection(): Promise<{ success: boolean; message?: string }>;
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

export interface Comparison {
  entity: string;
  scenario: string;
  rows: [number, number];
  keys: boolean;
  order: boolean;
  columns: boolean;
  columnCount: number;
  checksumMismatches: string[];
  chunks: [number, number];
  chunkStates: boolean;
  requests: [number, number];
  requestsEqual: boolean;
  timestampMismatches: string[];
  timestampsChecked: number;
  timestampsFellBackToNow?: [number, number];
  error?: string;
  ok: boolean;
}

export const CHECK_VARIANTS: Array<
  "valid" | "errors" | "revoked" | "bad-headers"
>;
export interface CheckOutcome {
  variant: string;
  requests: number;
  inProcess: boolean;
  folder: boolean;
  folderMessage?: string;
  requestsEqual: boolean;
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
export function liftSsrfGuard<T>(connector: T): T;
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
export function readInProcess(
  makeConnector: () => ReadableConnector,
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
export function rowChecksum(row: unknown): string;
export function compareRuns(
  inProcess: Run,
  folder: Run,
): Omit<Comparison, "entity" | "scenario">;
export function runParity(options: {
  entities: string[];
  makeInProcess: (config: any) => ReadableConnector;
  makeBoxed?: (config: any) => ReadableConnector;
  server: FixtureServer;
  scenarios?: Scenario[];
  concurrency?: number;
}): Promise<Comparison[]>;
export function checkParity(options: {
  makeInProcess: (config: Record<string, unknown>) => ReadableConnector;
  server: FixtureServer;
}): Promise<CheckOutcome[]>;
export function formatReport(results: Comparison[]): string;
export function compareForm(
  inProcessFields: Array<Record<string, any>> | undefined,
  folderFields: Array<Record<string, any>> | undefined,
): { ok: boolean; inProcess: unknown[]; folder: unknown[] };
