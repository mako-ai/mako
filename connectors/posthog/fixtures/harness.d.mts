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
  /** Rows per page; the default is 100. */
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

export interface Run {
  rows: Array<Record<string, unknown>>;
  chunks: ChunkState[];
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

export interface RecordingServer extends FixtureServer {
  recorded: Map<string, { status: number; body: unknown }>;
}

export const CHECK_VARIANTS: Array<"valid" | "nosurveys" | "revoked">;

export interface FolderCommandResult {
  code: number | null;
  messages: Array<Record<string, any>>;
  stderr: string;
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
export function streamPosition(
  entity: string,
  source: unknown,
  hasMore: boolean,
): ChunkState;
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
): Promise<RecordingServer>;
export function runFolderCommand(
  command: "spec" | "check" | "discover" | "read" | "webhook",
  options?: {
    config?: object;
    catalog?: unknown;
    state?: unknown;
    maxIterations?: number;
    maxBytes?: number;
  },
): Promise<FolderCommandResult>;
export function readFolder(options: {
  entity: string;
  config: object;
  since?: string;
  maxIterations: number;
}): Promise<Run>;
export function canonicalJson(value: unknown): string;
