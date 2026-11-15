/**
 * Console store types: tab state, the action surface, and the result
 * shapes actions return.
 */
import { type LoadError } from "../../api";
import { ConsoleVersionManager } from "../../utils/ConsoleVersionManager";
import type { ConsoleTab, TabKind } from "../lib/types";
import type {
  ConsoleContentResponse,
  ConsoleDeleteResponse,
  ConsoleRevisionSyncEntry,
  ConsoleSaveResponse,
  QueryCancelResponse,
  QueryExecuteResponse,
  ScheduledQueryRunsResponse,
  ScheduledQueryScheduleResponse,
} from "../../lib/api-types";

export type QueryExecuteResult =
  | QueryExecuteResponse
  | {
      success: false;
      error: string;
      code?: "PREVIEW_BLOCKED" | "FORBIDDEN";
    };

export interface ConsoleState {
  tabs: Record<string, ConsoleTab>;
  /** Order in which tabs are displayed in the tab bar. Source of truth for the UI. */
  tabOrder: string[];
  activeTabId: string | null;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
}

/** What `openTab` accepts — named so the open-or-focus primitive can share it. */
export type OpenTabInput = Omit<ConsoleTab, "id" | "isSaved"> & {
  id?: string;
  isSaved?: boolean;
};

/**
 * How an entity is recognised among open tabs: its kind, the metadata keys
 * that identify it (every listed key must be equal — `undefined` included),
 * and, for identity that does not live in metadata (a connection id, a
 * connector held in `content`), a predicate.
 */
export interface TabMatch {
  kind: TabKind;
  metadata?: Record<string, unknown>;
  where?: (tab: ConsoleTab) => boolean;
}

export function matchesTab(tab: ConsoleTab, match: TabMatch): boolean {
  if ((tab.kind ?? "console") !== match.kind) return false;
  if (match.metadata) {
    const meta = (tab.metadata ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(match.metadata)) {
      if (meta[key] !== value) return false;
    }
  }
  return match.where ? match.where(tab) : true;
}

/** The open tab showing this entity, if any. Pure — usable as a selector. */
export const findTab =
  (match: TabMatch) =>
  (state: { tabs: Record<string, ConsoleTab> }): ConsoleTab | undefined =>
    Object.values(state.tabs).find(tab => matchesTab(tab, match));

export interface ConsoleActions {
  // Tab management
  openTab: (
    tab: OpenTabInput,
    options?: {
      /**
       * When false, never close the "first pristine tab" to make room (VS
       * Code preview-tab behavior). Agent-driven opens use this so that a
       * console the agent just created isn't silently replaced by the next
       * one it opens.
       */
      replacePristine?: boolean;
      /**
       * Server-loaded agent drafts may have no EntityVersion baseline. In that
       * case an unknown savedStateHash is intentional: Save must stay enabled.
       */
      preserveMissingSavedStateHash?: boolean;
    },
  ) => string;
  /**
   * THE way to open an entity tab: focus the tab that already shows this
   * entity (by kind + metadata, plus an optional predicate), else open one
   * from `create` and focus it. Returns the tab id; null when nothing
   * matched and `create` declined (returned null) — "focus if present".
   *
   * `options.title` refreshes the title of an already-open tab (an entity
   * renamed elsewhere); `options.pin` pins the tab (durable documents that
   * must never be preview-replaced: notebooks, dbt consoles).
   *
   * Before this existed the same find-then-open was written out ~20 times
   * across the runtimes' shell.ts files, explorers, UrlSync and the command
   * palette — each with its own predicate shape, and three flow openers
   * with three different metadata sets.
   */
  focusOrOpenTab: (
    match: TabMatch,
    create?: () => OpenTabInput | null,
    options?: { replacePristine?: boolean; title?: string; pin?: boolean },
  ) => string | null;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  clearAllConsoles: () => void;
  /** Reorder the tab bar by moving `fromId` to the position of `toId`. */
  reorderTabs: (fromId: string, toId: string) => void;

  // Tab updates
  updateContent: (id: string, content: string) => void;
  updateTitle: (id: string, title: string) => void;
  updateDirty: (id: string, isDirty: boolean) => void;
  updateMetadata: (id: string, metadata?: Record<string, unknown>) => void;
  updateIcon: (id: string, icon: string) => void;
  updateConnection: (id: string, connectionId?: string) => void;
  updateDatabase: (
    id: string,
    databaseId?: string,
    databaseName?: string,
  ) => void;
  updateFilePath: (id: string, filePath: string) => void;
  updateAccess: (id: string, access?: "private" | "workspace") => void;
  updateSavedState: (
    id: string,
    isSaved: boolean,
    savedStateHash: string | undefined,
  ) => void;
  updateChartSpec: (
    id: string,
    chartSpec: Record<string, unknown> | null,
  ) => void;
  updateResultsViewMode: (id: string, mode: "table" | "json" | "chart") => void;
  /** Fast-forward the optimistic-concurrency base after conflict resolution. */
  updateVersion: (id: string, version: number) => void;
  /** Fast-forward the realtime sync base (draft revision). */
  updateDraftRevision: (id: string, draftRevision: number) => void;
  /** Set/clear the "updated remotely while you have unsaved edits" flag. */
  setRemoteUpdate: (id: string, info: ConsoleTab["remoteUpdate"]) => void;
  /**
   * User dismissed the remote-update banner: clear it AND unblock autosave.
   * The next autosave is revision-checked, so if the conflict still exists
   * it 409s and the banner honestly comes back — but edits never silently
   * stop persisting with no affordance shown.
   */
  dismissRemoteUpdate: (id: string) => void;
  /**
   * Apply a server-authoritative console payload (from revisions-sync) to a
   * CLEAN open tab: updates the store and pushes the content into the
   * mounted Monaco editor via the "console-remote-content" event. Dirty tabs
   * must go through setRemoteUpdate (affordance) instead — callers check.
   */
  applyRemoteConsoleEntry: (entry: ConsoleRevisionSyncEntry) => void;
  /**
   * Apply a revisions-sync entry whose content already matches this tab's
   * store content: fast-forward revision/version/metadata WITHOUT touching
   * the Monaco buffer. Used when the local buffer may be AHEAD of the store
   * by in-flight keystrokes — pushing the (identical-to-store) server copy
   * into the editor would erase them.
   */
  fastForwardRemoteConsoleEntry: (entry: ConsoleRevisionSyncEntry) => void;
  /**
   * Start (or update) a Monaco diff review for an agent (modify_console)
   * edit. The change is already persisted to the server draft; this surfaces
   * it for Accept/Reject review instead of applying it silently. The editor
   * keeps the pre-agent baseline until resolveAgentReview runs. Cumulative
   * agent edits update the diff's "modified" side while preserving the
   * original baseline. No-op when the proposed content already matches the
   * tab (nothing to review).
   */
  beginAgentReview: (entry: ConsoleRevisionSyncEntry) => void;
  /**
   * Resolve a pending agent diff review. "accept" adopts the agent's content
   * locally (the server already holds it); "reject" reverts the server draft
   * back to the pre-agent baseline with a revision-checked write. The editor
   * buffer is restored by the Console component; this syncs store + server.
   */
  resolveAgentReview: (
    workspaceId: string,
    consoleId: string,
    action: "accept" | "reject",
  ) => Promise<void>;
  /**
   * Resolve the remote-update affordance: refetch the server copy, apply it
   * (discarding local unsaved edits).
   */
  applyRemoteConsoleUpdate: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<void>;
  /**
   * Resolve the remote-update affordance the other way: deliberately
   * overwrite the server copy with this tab's content (revision-targeted at
   * the conflict the banner reported). Re-banners on a fresh conflict.
   */
  resolveRemoteUpdateKeepMine: (
    workspaceId: string,
    consoleId: string,
    content: string,
  ) => Promise<void>;
  /**
   * Open a console tab from its server copy (agent open/create intents,
   * in-band chat tool results). Idempotent: an already-open tab is just
   * activated. The new tab carries the server's draftRevision/isSaved so
   * the realtime layer starts from an accurate base, and it never replaces
   * a pristine tab (agent-opened consoles must not swallow each other).
   */
  openConsoleFromServer: (
    workspaceId: string,
    consoleId: string,
    options?: { focus?: boolean },
  ) => Promise<void>;
  /**
   * Fetch ONLY the latest server-side run artifact (lastRun) for a console.
   * Unlike fetchConsoleContent this never touches content/draftRevision/
   * isSaved/remoteUpdate — content replication is the realtime revision
   * sync's job; this exists so run results can render without desyncing the
   * editor from the revision base.
   */
  fetchConsoleRunArtifact: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<ConsoleContentResponse["lastRun"] | null>;

  // Versioning
  getVersionManager: (consoleId: string) => ConsoleVersionManager | null;

  // API operations
  loadConsole: (
    workspaceId: string,
    consoleId: string,
    options?: { openScheduledRuns?: boolean },
  ) => Promise<void>;
  /** Open a placeholder tab surfacing a failed console load (see impl). */
  openConsoleLoadErrorTab: (consoleId: string, loadError: LoadError) => void;
  reloadConsole: (workspaceId: string, consoleId: string) => Promise<void>;
  fetchConsoleContent: (
    workspaceId: string,
    consoleId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ConsoleContentResponse | null>;
  /** Lightweight console metadata for the Console Information dialog. */
  fetchConsoleDetails: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<{
    description?: string;
    ownerDisplayName?: string;
    owner_id?: string;
    access?: string;
    createdAt?: string;
    updatedAt?: string;
    executionCount?: number;
    lastExecutedAt?: string;
  } | null>;
  /** Recent query_executions rows for a console (90-day TTL). */
  fetchConsoleExecutions: (
    workspaceId: string,
    consoleId: string,
    options?: { limit?: number },
  ) => Promise<
    Array<{
      id: string;
      executedAt: string;
      source: string;
      status: string;
      executionTimeMs: number;
      rowCount: number | null;
      errorType: string | null;
      apiKeyId: string | null;
    }>
  >;
  saveConsole: (
    workspaceId: string,
    tabId: string,
    content: string,
    path: string,
    connectionId?: string,
    databaseName?: string,
    databaseId?: string,
    chartSpec?: Record<string, unknown>,
    resultsViewMode?: string,
    comment?: string,
    access?: "private" | "workspace",
  ) => Promise<ConsoleSaveResponse>;
  deleteConsole: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<ConsoleDeleteResponse>;
  /** Create a console record (first save / save-as-copy). Resolves with the
   * status for every response: a 409 carries the conflict to resolve. */
  createConsoleRecord: (
    workspaceId: string,
    payload: Record<string, unknown>,
  ) => Promise<{ status: number; body: ConsoleSaveResponse }>;
  /** Run the tab's query server-side and download the results file
   * (CSV/NDJSON). Throws with the server's message on failure. */
  exportQueryResults: (
    workspaceId: string,
    payload: Record<string, unknown>,
  ) => Promise<Blob>;
  executeQuery: (
    workspaceId: string,
    connectionId: string,
    query: string,
    options?: {
      databaseName?: string;
      databaseId?: string;
      executionId?: string;
      signal?: AbortSignal;
      pageSize?: number;
      cursor?: string | null;
      confirmUnsafe?: boolean;
      /** When set, links the run to a saved console for usage stats. */
      consoleId?: string;
    },
  ) => Promise<QueryExecuteResult>;
  cancelQuery: (
    workspaceId: string,
    executionId: string,
  ) => Promise<QueryCancelResponse>;
  autoSaveConsole: (
    workspaceId: string,
    consoleId: string,
    content: string,
    title?: string,
    connectionId?: string,
    databaseId?: string,
    databaseName?: string,
  ) => void;
  generateVersionComment: (
    workspaceId: string,
    consoleId: string,
    versionId: string,
    payload: {
      previousContent: string;
      newContent: string;
      language: string;
      source: "user" | "ai";
      aiPrompt?: string;
      title?: string;
    },
  ) => void;
  generateSaveComment: (
    workspaceId: string,
    consoleId: string,
    payload: {
      newContent: string;
      source: "user" | "ai";
    },
    signal?: AbortSignal,
  ) => Promise<{ comment: string | null; diff: string | null }>;
  setSchedule: (
    workspaceId: string,
    consoleId: string,
    input: { cron: string; timezone: string },
  ) => Promise<ScheduledQueryScheduleResponse>;
  removeSchedule: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  runScheduledNow: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<ScheduledQueryScheduleResponse>;
  listScheduledRuns: (
    workspaceId: string,
    consoleId: string,
    limit?: number,
  ) => Promise<ScheduledQueryRunsResponse>;
  /** Merge latest scheduledRun snapshot (e.g. after GET schedule/runs). */
  updateTabScheduledRun: (
    tabId: string,
    scheduledRun: ConsoleContentResponse["scheduledRun"] | undefined,
  ) => void;
}

export type ConsoleStore = ConsoleState & ConsoleActions;

export const initialConsoleState: ConsoleState = {
  tabs: {},
  tabOrder: [],
  activeTabId: null,
  loading: {},
  error: {},
};
