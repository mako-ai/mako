// Types for harness.mjs, for the API tests that import it.

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
  /** Rows per page (`__page_size`): the offset lists and Search page by it. */
  pageSize?: number;
}
export const SCENARIOS: Scenario[];

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

export interface FolderOnly {
  rows: number;
  columns: string[];
  requests: number;
  /** The extras are there, as declared. */
  ok: boolean;
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
export function saveCassettes(
  byFile: Map<string, Map<string, unknown>>,
  dir?: string,
): void;
export function searchLimits(requests: string[]): number[];
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
    maxIterations?: number;
    maxBytes?: number;
  },
): Promise<{
  code: number | null;
  messages: ProtocolMessage[];
  stderr: string;
  lines: string[];
}>;
export function readFolder(options: {
  entity: string;
  config: unknown;
  since?: string;
  maxIterations?: number;
}): Promise<{ rows: Array<Record<string, any>>; chunks: ChunkState[] }>;
export function runFolderWebhook(input: {
  verify?: unknown[];
  events?: unknown[];
}): Promise<{ events: string[]; verify: any[]; outcomes: any[] }>;
export const FOLDER_ONLY: Record<
  string,
  {
    row?: (row: Record<string, unknown>) => boolean;
    columns?: string[];
    schemaFields?: string[];
    request?: (key: string) => boolean;
    check?: (extras: unknown) => boolean;
  }
>;
export function withoutFolderOnly(
  entity: string | undefined,
  run: Run,
): { run: Run; folderOnly?: FolderOnly };
