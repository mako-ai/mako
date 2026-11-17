// Types for harness.mjs, for the API test that imports it.

export const FOLDER: string;
export const REPO_ROOT: string;
export const SDK_DIR: string;
export const RUNNER: string;
export const CASSETTE_DIR: string;
export const SINCE: string;

export const PROJECT_ID: string;
export const NO_SURVEYS_PROJECT_ID: string;

export interface Scenario {
  name: string;
  maxIterations: number;
  since?: string;
  /** Rows per page; the default is 100 on both sides. */
  pageSize?: number;
  /** `project_api_key` sends the key in `POSTHOG-API-TOKEN`. */
  authType?: string;
  projectId?: string;
}
export const SCENARIOS: Scenario[];

export interface PosthogTestConfig {
  api_key: string;
  api_base_url: string;
  project_id: string;
  auth_type?: string;
  queries?: Array<{ name: string; query: string }>;
  __page_size?: number;
  __rate_limit_delay_ms?: number;
}

/** The resume position after a chunk: `offset`, or the survey walk. */
export interface ChunkState {
  offset?: number | null;
  surveyOffset?: number | null;
  responseOffset?: number | null;
  currentSurveyId?: string | null;
  surveysDone?: boolean | null;
  hasMore: boolean;
}

export interface SourceTimestamps {
  byId: Map<string, string | null>;
  /** Rows whose timestamp came out within a minute of now. */
  fellBackToNow: number;
}

export interface Run {
  rows: Array<Record<string, unknown>>;
  chunks: ChunkState[];
  requests?: string[];
  timestamps?: SourceTimestamps;
}

export interface InProcessConnector {
  fetchEntityChunk(
    options: any,
  ): Promise<{ offset?: number; hasMore: boolean; metadata?: any }>;
  testConnection(): Promise<{ success: boolean; message?: string }>;
  resolveSchema?(entity: string): Promise<unknown>;
  normalizeBackfillRecord?(
    entity: string,
    record: Record<string, unknown>,
  ): { sourceTs: Date } | null;
}

export interface FixtureServer {
  url: string;
  /** Each request with the auth header style it used, in order. */
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
  /** Row ids whose source timestamp differs between the two sides. */
  timestampMismatches: string[];
  timestampsChecked: number;
  /** Rows per side whose timestamp fell back to now. */
  timestampsFellBackToNow?: [number, number];
  /** Set when either side threw; such a run never counts as a match. */
  error?: string;
  ok: boolean;
}

export const CHECK_VARIANTS: Array<"valid" | "nosurveys" | "revoked">;

export interface CheckOutcome {
  variant: "valid" | "nosurveys" | "revoked";
  /** Requests the in-process check sent. */
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

export interface SchemaComparison {
  fields: [number, number];
  missing: string[];
  extra: string[];
  fieldDiffs: string[];
  keyColumns: boolean;
  policy: boolean;
  systemFields: number;
  /** Ignored (system) columns whose definitions differ between the sides. */
  systemDiffs: string[];
  ok: boolean;
}

export function ensureFolderInstalled(): void;
export function requestKey(
  method: string,
  rawUrl: string,
  body?: string,
): string;
export function testConfig(
  apiKey: string,
  server: { url: string },
  scenario?: Partial<Scenario>,
): PosthogTestConfig;
export function chunkPosition(
  entity: string,
  state: unknown,
  hasMore: boolean,
): ChunkState;
export function streamPosition(
  entity: string,
  source: unknown,
  hasMore: boolean,
): ChunkState;
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
  },
): Promise<FolderCommandResult>;
export function readFolder(options: {
  entity: string;
  config: PosthogTestConfig;
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
export const readBoxed: typeof readInProcess;
export function sourceTimestamps(
  connector: InProcessConnector,
  entity: string,
  rows: Array<Record<string, unknown>>,
): SourceTimestamps;
export function canonicalJson(value: unknown): string;
export function rowChecksum(row: unknown): string;
export function compareRuns(
  inProcess: Run,
  folder: Run,
): Omit<Comparison, "entity" | "scenario">;
export function runParity(options: {
  entities: string[];
  makeInProcess: (config: PosthogTestConfig) => InProcessConnector;
  /** Run the folder through SandboxedConnector instead of the bare runner. */
  makeBoxed?: (config: PosthogTestConfig) => InProcessConnector;
  server: FixtureServer;
  scenarios?: Scenario[];
  concurrency?: number;
}): Promise<Comparison[]>;
export function checkParity(options: {
  makeInProcess: (config: PosthogTestConfig) => InProcessConnector;
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
