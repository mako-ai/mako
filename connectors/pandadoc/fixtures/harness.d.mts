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
  requests?: string[];
  error?: string;
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
  inProcess(row: Record<string, any>, entity: string): unknown;
  folder(row: Record<string, any>, entity: string): unknown;
}

export interface Comparison {
  rows: [number, number];
  keys: boolean;
  order: boolean;
  columns: boolean;
  columnCount: number;
  checksumMismatches: string[];
  timestampMismatches: string[];
  chunks: [number, number];
  chunkStates: boolean;
  requests: [number, number];
  requestsEqual: boolean;
  ok: boolean;
}

export interface ParityResult extends Comparison {
  entity: string;
  scenario: string;
  endError?: string;
  error?: string;
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
export function startReplayServer(
  interactions?: Map<string, { status: number; body: unknown }>,
): Promise<ReplayServer>;
export function readFolder(options: {
  entity: string;
  config: Record<string, unknown>;
  since?: string;
  maxIterations: number;
}): Promise<Run>;
export function runFolderCommand(
  command: string,
  options?: {
    config?: Record<string, unknown>;
    catalog?: unknown;
    state?: unknown;
    batch?: unknown;
    maxIterations?: number;
    maxBytes?: number;
    timeoutMs?: number;
  },
): Promise<FolderRun>;
export function readInProcess(
  makeConnector: () => any,
  options: {
    entity: string;
    since?: string;
    maxIterations?: number;
    pageSize?: number;
  },
  out?: Run,
): Promise<Run>;
export function positionOf(state: unknown): Record<string, unknown>;
export function inProcessPosition(state: unknown): Record<string, unknown>;
export function masked<T>(row: T): T;
export function rowChecksum(row: unknown): string;
export function compareRuns(
  inProcess: Run,
  folder: Run,
  sourceTs?: SourceTimestamps,
  entity?: string,
): Comparison;
export function runParity(options: {
  entities?: string[];
  makeInProcess: (config: Record<string, any>) => any;
  makeBoxed?: (config: Record<string, any>) => any;
  server: FixtureServer;
  sourceTs?: SourceTimestamps;
  scenarios?: Scenario[];
  concurrency?: number;
}): Promise<ParityResult[]>;
export function checkParity(options: {
  makeInProcess: (config: Record<string, any>) => any;
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
  inProcess: unknown,
  folder: unknown,
  ignore?: Set<string>,
): {
  fields: [number, number];
  missing: string[];
  extra: string[];
  fieldDiffs: string[];
  keyColumns: boolean;
  policy: boolean;
  systemDiffs: string[];
  ok: boolean;
};
export function compareForm(
  inProcessFields: unknown[],
  folderFields: unknown[],
): { ok: boolean; inProcess: unknown[]; folder: unknown[] };
export function inProcessFactory(
  Connector: new (source: any) => any,
  type?: string,
): (config: Record<string, any>) => any;
export function downloadSigned(
  url: string,
  config: Record<string, unknown>,
): Promise<string>;
