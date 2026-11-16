// Types for harness.mjs, for the API test that imports it.

export const FOLDER: string;
export const REPO_ROOT: string;
export const SDK_DIR: string;
export const RUNNER: string;
export const CASSETTE_DIR: string;
export const SINCE: string;

export interface Scenario {
  name: string;
  maxIterations: number;
  since?: string;
  /** Rows per page; the default is 100 on both sides. */
  pageSize?: number;
}
export const SCENARIOS: Scenario[];

export interface StripeTestConfig {
  api_key: string;
  api_base_url: string;
  __page_size?: number;
}

export interface ChunkState {
  cursor?: string;
  hasMore: boolean;
}

export interface Run {
  rows: Array<Record<string, unknown>>;
  chunks: ChunkState[];
  requests?: string[];
}

export interface InProcessConnector {
  fetchEntityChunk(
    options: any,
  ): Promise<{ cursor?: string; hasMore: boolean }>;
  testConnection(): Promise<{ success: boolean; message?: string }>;
}

export interface FixtureServer {
  url: string;
  /** Each request with the `Stripe-Version` it carried, in order. */
  requests(apiKey: string): string[];
  /** The bare request keys, as the cassettes store them. */
  requestKeys(apiKey: string): string[];
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
  /** Set when either side threw; such a run never counts as a match. */
  error?: string;
  ok: boolean;
}

export interface CheckOutcome {
  variant: "valid" | "revoked";
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

export interface SchemaComparison {
  fields: [number, number];
  missing: string[];
  extra: string[];
  fieldDiffs: string[];
  keyColumns: boolean;
  policy: boolean;
  systemFields: number;
  ok: boolean;
}

export function ensureFolderInstalled(): void;
export function requestKey(method: string, rawUrl: string): string;
export function loadCassettes(
  dir?: string,
): Map<string, { status: number; body: unknown }>;
export function startReplayServer(
  interactions?: Map<string, { status: number; body: unknown }>,
): Promise<ReplayServer>;
export function runFolderCommand(
  command: "spec" | "check" | "discover" | "read",
  options?: {
    config?: Record<string, unknown>;
    catalog?: unknown;
    state?: unknown;
    maxIterations?: number;
  },
): Promise<FolderCommandResult>;
export function readFolder(options: {
  entity: string;
  config: StripeTestConfig;
  since?: string;
  maxIterations: number;
  pageSize?: number;
}): Promise<Run>;
export function readInProcess(
  connector: InProcessConnector,
  options: {
    entity: string;
    since?: string;
    maxIterations: number;
    pageSize?: number;
  },
): Promise<Run>;
export function canonicalJson(value: unknown): string;
export function rowChecksum(row: unknown): string;
export function compareRuns(
  inProcess: Run,
  folder: Run,
): Omit<Comparison, "entity" | "scenario">;
export function runParity(options: {
  entities: string[];
  makeInProcess: (config: StripeTestConfig) => InProcessConnector;
  server: FixtureServer;
  scenarios?: Scenario[];
  concurrency?: number;
}): Promise<Comparison[]>;
export function checkParity(options: {
  makeInProcess: (config: StripeTestConfig) => InProcessConnector;
  server: FixtureServer;
}): Promise<CheckOutcome[]>;
export function formatReport(results: Comparison[]): string;
export function compareEntitySchema(
  inProcess: any,
  folder: any,
  ignore?: Set<string>,
): SchemaComparison;
export function compareForm(
  inProcessFields: Array<Record<string, any>>,
  folderFields: Array<Record<string, any>>,
): { ok: boolean; inProcess: unknown[]; folder: unknown[] };
