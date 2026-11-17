// Types for harness.mjs, for the API tests that import it.

export const FOLDER: string;
export const REPO_ROOT: string;
export const SDK_DIR: string;
export const RUNNER: string;
export const CASSETTE_DIR: string;
export const CLOCK: string;
export const FIXTURE_NOW: string;
export const SINCE: string;
export const SCA_TEST_KEYS: { publicKey: string; privateKey: string };

export interface Scenario {
  name: string;
  maxIterations: number;
  since?: string;
  pageSize?: number;
  rateLimited?: boolean;
}
export const SCENARIOS: Scenario[];
export const RATE_LIMIT_SCENARIO: Scenario;
export const RATE_LIMIT_ENTITIES: string[];

export interface WiseTestConfig {
  api_key: string;
  api_base_url: string;
  sca_private_key?: string;
  [key: string]: unknown;
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
  inProcess(entity: string, row: Record<string, unknown>): unknown;
  folder(entity: string, row: Record<string, unknown>): unknown;
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
  ok: boolean;
}

export interface ParityResult extends Comparison {
  entity: string;
  scenario: string;
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
  approval?: string,
): string;
export function loadCassettes(dir?: string): Map<string, unknown>;
export function emulate(
  dataset: unknown,
  rawUrl: string,
): { status: number; body: unknown; headers?: Record<string, string> };
export function startRecordingServer(
  dataset: unknown,
): Promise<FixtureServer & { recorded: Map<string, unknown> }>;
export function startReplayServer(
  interactions?: Map<string, unknown>,
): Promise<ReplayServer>;
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
): Promise<{
  code: number | null;
  messages: ProtocolMessage[];
  stderr: string;
}>;
export function inProcessPosition(state: unknown): Record<string, unknown>;
export function hasSourceTime(row: Record<string, unknown>): boolean;
export function compareRuns(
  inProcess: Run,
  folder: Run,
  sourceTs?: SourceTimestamps,
  entity?: string,
): Comparison;
export function testConfig(
  token: string,
  server: { url: string },
  extra?: Record<string, unknown>,
): WiseTestConfig;
export function readInProcess(
  makeConnector: () => any,
  options: {
    entity: string;
    since?: string;
    maxIterations: number;
    pageSize?: number;
  },
): Promise<Run>;
export function runParity(options: {
  entities: string[];
  makeInProcess: (config: WiseTestConfig) => any;
  makeBoxed?: (config: WiseTestConfig) => any;
  server: FixtureServer;
  sourceTs?: SourceTimestamps;
  scenarios?: Scenario[];
  concurrency?: number;
}): Promise<ParityResult[]>;
export function checkParity(options: {
  makeInProcess: (config: WiseTestConfig) => any;
  server: FixtureServer;
}): Promise<
  Array<{
    variant: string;
    inProcess: boolean;
    folder: boolean;
    inProcessMessage?: unknown;
    folderMessage?: string;
    requestsEqual: boolean;
    requests: number;
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
export const FORM_DIFFS: Record<string, { type: [string, string] }>;
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
  publicKeys: string[];
  inProcessVerify: (delivery: {
    payload: string;
    headers: Record<string, string>;
    secret?: string;
  }) => unknown;
}): Promise<{
  eventsSame: boolean;
  eventCount: number;
  forEntities: Array<{ entities: string[]; same: boolean }>;
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
export function inProcessWebhookOutcomes(
  connector: any,
  events: Array<{ eventId: string; eventType: string; rawPayload: unknown }>,
): any[];
export function inProcessFactory(classes: {
  WiseConnector: any;
}): (config: WiseTestConfig) => any;
