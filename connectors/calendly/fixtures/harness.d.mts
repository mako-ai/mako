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
  /** Rows per page (`__page_size` / `batchSize`), Calendly's `count`. */
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
}

export interface ChunkState {
  position: Record<string, unknown>;
  hasMore: boolean;
}

export interface Run {
  rows: Array<Record<string, unknown>>;
  chunks: ChunkState[];
  requests?: string[];
}

export interface FixtureServer {
  url: string;
  requests(token: string): string[];
  close(): Promise<void>;
}

export interface ReplayServer extends FixtureServer {
  misses: string[];
}

export interface SourceTimestamps {
  inProcess(row: Record<string, unknown>, entity: string): unknown;
  folder(row: Record<string, unknown>, entity: string): unknown;
}

export interface Comparison {
  rows: [number, number];
  duplicates: [number, number];
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
  /** `sorted` for entities read in concurrent waves. */
  requestOrder: "exact" | "sorted";
  ok: boolean;
}

export interface ParityResult extends Comparison {
  entity: string;
  scenario: string;
  error?: string;
}

export function folderEnv(): NodeJS.ProcessEnv;
export function ensureFolderInstalled(): void;
export function canonicalJson(value: unknown): string;
export function requestKey(
  method: string,
  rawUrl: string,
  serverUrl: string,
): string;
export function loadCassettes(
  dir?: string,
): Map<string, { status: number; body: unknown }>;
export function saveCassettes(
  byFile: Map<string, Map<string, { status: number; body: unknown }>>,
  dir?: string,
): void;
export function startReplayServer(
  interactions?: Map<string, { status: number; body: unknown }>,
): Promise<ReplayServer>;
export function startRecordingServer(
  dataset: unknown,
): Promise<
  FixtureServer & { recorded: Map<string, { status: number; body: unknown }> }
>;

export interface FolderResult {
  code: number | null;
  messages: Array<Record<string, any>>;
  stderr: string;
  lines: string[];
}
export function runFolderCommand(
  command: string,
  options?: {
    config?: unknown;
    catalog?: unknown;
    state?: unknown;
    batch?: unknown;
    maxIterations?: number;
    maxBytes?: number;
  },
): Promise<FolderResult>;

export function inProcessPosition(state: unknown): Record<string, unknown>;
export function readFolder(options: {
  entity: string;
  config: Record<string, unknown>;
  since?: string;
  maxIterations: number;
}): Promise<Run>;
export function readBoxed(
  connector: any,
  options: Record<string, unknown>,
): Promise<Run>;
export function readInProcess(
  makeConnector: () => any,
  options: Record<string, unknown>,
): Promise<Run>;

export const rowChecksum: (row: unknown) => string;
export function hasSourceTime(row: Record<string, unknown>): boolean;
export function compareRuns(
  inProcess: Run,
  folder: Run,
  sourceTs?:
    | SourceTimestamps
    | Record<string, (row: Record<string, unknown>) => unknown>,
  entity?: string,
): Comparison;

export function runParity(options: {
  entities: string[];
  makeInProcess: (config: CalendlyTestConfig) => any;
  makeBoxed?: (config: { access_token: string; api_base_url: string }) => any;
  server: FixtureServer;
  sourceTs?: SourceTimestamps;
  scenarios?: Scenario[];
  concurrency?: number;
}): Promise<ParityResult[]>;

export function checkParity(options: {
  makeInProcess: (config: CalendlyTestConfig) => any;
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

export function compareEntitySchema(
  inProcess: any,
  folder: any,
  ignore?: Set<string>,
): {
  fields: [number, number];
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
): { ok: boolean; inProcess: unknown[]; folder: unknown[] };

export function runFolderWebhookMapping(input: {
  events: unknown[];
  selections: string[][];
}): Promise<{
  events: string[];
  eventsForEntities: string[][];
  outcomes: any[];
}>;
export function inProcessWebhookOutcomes(
  connector: any,
  events: unknown[],
): any[];
export function webhookParity(options: {
  connector: any;
  events: unknown[];
}): Promise<{
  eventsSame: boolean;
  eventCount: number;
  perEntity: Array<{ entities: string[]; same: boolean }>;
  outcomes: Array<{
    eventId: string;
    eventType: string;
    outcome: string;
    records: number;
    same: boolean;
  }>;
  ok: boolean;
}>;

export function inProcessFactory(deps: {
  CalendlyConnector: any;
}): (config: CalendlyTestConfig) => any;
