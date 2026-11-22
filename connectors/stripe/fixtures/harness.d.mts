// Types for harness.mjs, for the API tests that import it.

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
  /** Rows per page; the default is 100. */
  pageSize?: number;
}
export const SCENARIOS: Scenario[];

export interface StripeTestConfig {
  api_key: string;
  api_base_url: string;
  __page_size?: number;
  __rate_limit_delay_ms?: number;
}

export interface ChunkState {
  cursor?: string;
  hasMore: boolean;
}

/** What `readBoxed` drives: `SandboxedConnector` as the engine calls it. */
export interface BoxedConnector {
  fetchEntityChunk(
    options: any,
  ): Promise<{ cursor?: string; hasMore: boolean; metadata?: any }>;
  resolveSchema?(entity: string): Promise<unknown>;
  normalizeBackfillRecord?(
    entity: string,
    record: Record<string, unknown>,
  ): { sourceTs: Date } | null;
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

export interface FolderCommandResult {
  code: number | null;
  messages: Array<Record<string, any>>;
  stderr: string;
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
  command: "spec" | "check" | "discover" | "read" | "webhook",
  options?: {
    config?: Record<string, unknown>;
    catalog?: unknown;
    state?: unknown;
    batch?: unknown;
    maxIterations?: number;
    maxBytes?: number;
  },
): Promise<FolderCommandResult>;
export function readFolder(options: {
  entity: string;
  config: StripeTestConfig;
  since?: string;
  maxIterations: number;
  pageSize?: number;
}): Promise<Run>;
export function readBoxed(
  connector: BoxedConnector,
  options: {
    entity: string;
    since?: string;
    maxIterations: number;
    pageSize?: number;
  },
): Promise<Run>;
export function sourceTimestamps(
  connector: BoxedConnector,
  entity: string,
  rows: Array<Record<string, unknown>>,
): SourceTimestamps;
export function canonicalJson(value: unknown): string;
export function rowChecksum(row: unknown): string;
