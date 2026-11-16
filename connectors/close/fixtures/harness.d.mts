// Types for harness.mjs, for the API test that imports it.

export const FOLDER: string;
export const REPO_ROOT: string;
export const SDK_DIR: string;
export const RUNNER: string;
export const CASSETTE_DIR: string;
export const CLOCK: string;
export const FIXTURE_NOW: string;
export const SINCE: string;
export const SEARCH_PAGE_SIZE: number;
export const SELECTOR_CEILING: number;
export const CURSOR_ROW_LIMIT: Record<string, number>;

export interface Scenario {
  name: string;
  maxIterations: number;
  since?: string;
  /** Rows per page on the offset lists; the default is 100 on both sides. */
  pageSize?: number;
  rateLimited?: boolean;
}
export const SCENARIOS: Scenario[];
export const RATE_LIMIT_SCENARIO: Scenario;
export const RATE_LIMIT_ENTITIES: string[];

export interface CloseTestConfig {
  api_key: string;
  baseUrl?: string;
}

export interface ChunkState {
  position: Record<string, unknown>;
  hasMore: boolean;
  records?: number;
  recordBytes?: number;
}

export interface Run {
  rows: Array<Record<string, unknown>>;
  chunks: ChunkState[];
  requests?: string[];
}

export interface FixtureServer {
  url: string;
  requests(apiKey: string): string[];
  close(): Promise<void>;
}

export interface ReplayServer extends FixtureServer {
  misses: string[];
}

export interface SourceTimestamps {
  inProcess(row: Record<string, unknown>): unknown;
  folder(row: Record<string, unknown>): unknown;
}

export interface Comparison {
  rows: [number, number];
  keys: boolean;
  order: boolean;
  columns: boolean;
  columnCount: number;
  checksumMismatches: string[];
  timestampMismatches: string[];
  timestampFallbacks: number;
  chunks: [number, number];
  chunkStates: boolean;
  requests: [number, number];
  requestsEqual: boolean;
  ok: boolean;
}

export interface ParityResult extends Comparison {
  entity: string;
  scenario: string;
  stats: {
    chunks: number;
    rows: number;
    maxChunkRows: number;
    maxChunkBytes: number;
    bytesPerRow: number;
  };
  error?: string;
}

export interface ProtocolMessage {
  type: string;
  [key: string]: any;
}

export function folderEnv(): NodeJS.ProcessEnv;
export function freezeClock(): () => void;
export function ensureFolderInstalled(): void;
export function canonicalJson(value: unknown): string;
export function requestKey(
  method: string,
  rawUrl: string,
  body?: unknown,
): string;
export function requestHash(key: string): string;
export function loadCassettes(dir?: string): Map<string, unknown>;
export function startReplayServer(
  interactions?: Map<string, unknown>,
): Promise<ReplayServer>;
export function runFolderCommand(
  command: string,
  options?: {
    config?: unknown;
    catalog?: unknown;
    state?: unknown;
    maxIterations?: number;
    maxBytes?: number;
  },
): Promise<{
  code: number | null;
  messages: ProtocolMessage[];
  stderr: string;
}>;
export function inProcessPosition(state: unknown): Record<string, unknown>;
export function compareRuns(
  inProcess: Run,
  folder: Run,
  sourceTs?: SourceTimestamps,
): Comparison;
export function runParity(options: {
  entities: string[];
  makeInProcess: (config: CloseTestConfig) => any;
  makeBoxed?: (config: { api_key: string; __base_url: string }) => any;
  server: FixtureServer;
  sourceTs?: SourceTimestamps;
  scenarios?: Scenario[];
  concurrency?: number;
}): Promise<ParityResult[]>;
export function checkParity(options: {
  makeInProcess: (config: CloseTestConfig) => any;
  server: FixtureServer;
}): Promise<
  Array<{
    variant: string;
    inProcess: boolean;
    folder: boolean;
    folderMessage?: string;
    requestsEqual: boolean;
  }>
>;
export function formatReport(results: ParityResult[]): string;
export function formatScale(results: ParityResult[], scenario?: string): string;
export function compareEntitySchema(
  inProcess: any,
  folder: any,
  ignore?: Set<string>,
): {
  fields: [number, number];
  customFields: number;
  missing: string[];
  extra: string[];
  fieldDiffs: string[];
  keyColumns: boolean;
  policy: boolean;
  ok: boolean;
};
export function compareForm(
  inProcessFields: any[],
  folderFields: any[],
): { ok: boolean; inProcess: unknown; folder: unknown };
export function webhookParity(options: {
  connector: any;
  events: Array<{ eventId: string; eventType: string; rawPayload: unknown }>;
  deliveries: Array<{
    name: string;
    payload: string;
    headers: Record<string, string>;
    secret?: string;
  }>;
}): Promise<{
  eventsSame: boolean;
  eventCount: number;
  verify: Array<{
    name: string;
    inProcess: boolean;
    folder: boolean;
    same: boolean;
  }>;
  outcomes: Array<{
    eventId: string;
    eventType: string;
    outcome: string;
    records: number;
    same: boolean;
  }>;
  ok: boolean;
}>;
export function inProcessFactory(classes: {
  CloseConnector: any;
  createCloseClient: any;
}): (config: CloseTestConfig) => any;
