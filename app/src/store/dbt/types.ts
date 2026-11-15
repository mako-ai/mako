/**
 * dbt store types: projects, files, jobs, runs and the store surface.
 */
import type { LoadError } from "../../api/result";

export interface DbtEnvironment {
  name: string;
  connectionId: string;
  targetSchema: string;
  threads: number;
  vars?: Record<string, unknown>;
  /**
   * Personal (per-developer) environment: set to the owning user's id when
   * auto-provisioned as that user's private dev target (schema `dbt_<user>`).
   * Selectors hide other users' personal environments.
   */
  ownerUserId?: string;
}

/**
 * Environments the given user may target: shared environments plus their own
 * personal environment (other users' personal targets are hidden).
 */
export function visibleDbtEnvironments(
  environments: DbtEnvironment[] | undefined,
  userId: string | undefined,
): DbtEnvironment[] {
  return (environments ?? []).filter(
    env => !env.ownerUserId || env.ownerUserId === userId,
  );
}

export interface DbtProjectItem {
  _id: string;
  name: string;
  dbtVersion: string;
  environments: DbtEnvironment[];
  defaultEnvironment: string;
  /**
   * Explicit production (defer target) environment. Unset → convention:
   * the env named "prod" when one exists, else the project default.
   */
  prodEnvironment?: string;
  /**
   * The CALLER's saved development environment for this project (per-user
   * setting, persisted by the env pickers). Unset → auto: their personal
   * environment when provisioned, else the project default. Single player:
   * the shared dev default IS the personal target; teams: each user's own.
   */
  myDevEnvironment?: string;
  updatedAt?: string;
  /** Artifact-store key of last prod manifest (Slim CI defer state). */
  lastProdManifestKey?: string;
}

export interface DbtFileEntry {
  content: string;
  /** True while local edits have not been persisted yet. */
  dirty: boolean;
  loaded: boolean;
}

export interface DbtJobItem {
  _id: string;
  projectId: string;
  /** Filename identity in dbt/jobs/<slug>.yml. */
  slug?: string;
  name: string;
  environment: string;
  commands: string[];
  schedule?: { cron: string; timezone: string } | null;
  /**
   * Set when `dbt/jobs/<slug>.yml` at main does not parse or apply. The
   * rest of the item is the last valid version (or an empty stub for a
   * git-only file), so treat the job as read-only until the file is fixed.
   */
  definitionInvalid?: { reason: string; at: string; path: string };
  scheduledRun?: {
    nextAt?: string;
    lastAt?: string;
    lastStatus?: "success" | "error";
    lastError?: string;
    lastDurationMs?: number;
    runCount?: number;
    consecutiveFailures?: number;
  };
  enabled: boolean;
  deferToProduction?: boolean;
}

export interface DbtRunLogLine {
  ts: string;
  level: string;
  line: string;
}

export interface DbtStepResult {
  uniqueId: string;
  name: string;
  resourceType: string;
  status: string;
  executionTimeMs: number;
  rowsAffected?: number;
  message?: string;
}

export interface DbtRunItem {
  _id: string;
  projectId: string;
  jobId?: string;
  environment: string;
  commands: string[];
  status: "queued" | "running" | "success" | "error" | "cancelled";
  trigger: "schedule" | "manual" | "agent" | "ci";
  triggeredBy: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  /** Set when the run was cancelled. */
  cancelledAt?: string;
  /** User id (or "agent") that cancelled the run. */
  cancelledBy?: string;
  stepResults?: DbtStepResult[];
  error?: string;
  createdAt: string;
  /**
   * Git branch the run's source tree came from (repo-bound projects).
   * Combined with `workingTreeUserId` it tells WHAT was built: a user's
   * working tree (checkout + uncommitted drafts) vs the committed branch.
   */
  sourceBranch?: string;
  /** Set when the run built this user's working tree (drafts included). */
  workingTreeUserId?: string;
  /** PR context for CI runs (trigger === "ci"). */
  ci?: {
    prNumber: number;
    headSha: string;
    headRef: string;
    baseRef: string;
    owner: string;
    repo: string;
  };
}

/** Which run artifacts were stored (keys present → downloadable). */
export interface DbtArtifactKeys {
  manifest?: string;
  runResults?: string;
  catalog?: string;
  sources?: string;
}

export type DbtArtifactKind = keyof DbtArtifactKeys;

export interface DbtRunDetails extends DbtRunItem {
  logs: DbtRunLogLine[];
  logCursor: number;
  artifactKeys?: DbtArtifactKeys;
}

export interface DbtCompileResult {
  ok: boolean;
  exitCode: number;
  compiledSql?: string;
  logs: DbtRunLogLine[];
}

export interface DbtCommandRunResult {
  ok: boolean;
  exitCode: number;
  subcommand: string;
  stepResults: DbtStepResult[];
  logs: DbtRunLogLine[];
}

/** Rows a Preview fetches by default — mirrors DBT_PREVIEW_DEFAULT_LIMIT. */
export const DBT_PREVIEW_DEFAULT_LIMIT = 500;

/**
 * Result of `dbt show --output json`. `ok: false` means dbt produced no rows
 * payload (compile error) — `logs` carries the reason. `ok: true` with an
 * empty `rows` is a model that legitimately returned nothing.
 */
export interface DbtPreviewResult {
  ok: boolean;
  exitCode: number;
  /** The `--limit` dbt ran with, so the UI can say when rows were capped. */
  limit: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  node?: string;
  logs: DbtRunLogLine[];
}

export interface DbtLineageNode {
  id: string;
  name: string;
  resourceType: string;
  filePath?: string;
  lastStatus?: string;
  description?: string;
  materialized?: string;
  tags?: string[];
  columns?: Array<{ name: string; type?: string; description?: string }>;
  url?: string;
  owner?: string;
}

export interface DbtLineage {
  nodes: DbtLineageNode[];
  edges: Array<{ source: string; target: string }>;
  generatedAt: string | null;
}

export interface DbtState {
  projects: DbtProjectItem[];
  projectsLoaded: boolean;
  /** Currently selected project (drives the dbt Studio-style explorer). */
  activeProjectId: string | null;
  /** projectId → sorted file paths (tree source of truth). */
  filePathsByProject: Record<string, string[]>;
  /** projectId → path → file entry. */
  filesByProject: Record<string, Record<string, DbtFileEntry>>;
  /** projectId → jobs. */
  jobsByProject: Record<string, DbtJobItem[]>;
  /** projectId → recent runs (newest first), unfiltered (project-wide view). */
  runsByProject: Record<string, DbtRunItem[]>;
  /** jobId → recent runs for that job (newest first). Kept separate from
   * `runsByProject` so the job view and the project-wide Runs view never
   * clobber each other's list when both are mounted. */
  runsByJob: Record<string, DbtRunItem[]>;
  /** runId → details incl. accumulated logs. */
  runDetails: Record<string, DbtRunDetails>;
  /** Project settings drawer (mounted at app root). */
  settingsProjectId: string | null;
  /** New project drawer (mounted at app root). */
  createProjectOpen: boolean;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  /**
   * Structured load failures (status + message) for the fetches that tab
   * views gate on: `projects`, `jobs:<projectId>`, `file:<projectId>:<path>`.
   * Lets views render "not found" / "no access" instead of loading forever.
   */
  loadErrors: Record<string, LoadError>;
}

export interface DbtActions {
  fetchProjects: (workspaceId: string) => Promise<void>;
  setActiveProject: (projectId: string | null) => void;
  createProject: (
    workspaceId: string,
    payload: {
      name: string;
      environments: DbtEnvironment[];
      defaultEnvironment: string;
      dbtVersion?: string;
    },
  ) => Promise<DbtProjectItem | null>;
  updateProject: (
    workspaceId: string,
    projectId: string,
    patch: {
      name?: string;
      environments?: DbtEnvironment[];
      defaultEnvironment?: string;
      /** Production/defer env override; "" clears back to the convention. */
      prodEnvironment?: string;
      dbtVersion?: string;
    },
  ) => Promise<DbtProjectItem | null>;
  deleteProject: (workspaceId: string, projectId: string) => Promise<boolean>;
  /**
   * Idempotently provision the caller's personal (per-developer) environment
   * on a project (schema `dbt_<user>`, same connection as prod). Returns the
   * environment or null on failure.
   */
  ensurePersonalEnvironment: (
    workspaceId: string,
    projectId: string,
  ) => Promise<DbtEnvironment | null>;
  /**
   * Persist the caller's per-user dev environment for a project ("" clears
   * back to Auto). Updates `myDevEnvironment` on the cached project.
   */
  setMyEnvironment: (
    workspaceId: string,
    projectId: string,
    environment: string,
  ) => Promise<boolean>;

  fetchFiles: (workspaceId: string, projectId: string) => Promise<void>;
  readFile: (
    workspaceId: string,
    projectId: string,
    path: string,
  ) => Promise<string | null>;
  writeFile: (projectId: string, path: string, content: string) => void;
  persistFile: (
    workspaceId: string,
    projectId: string,
    path: string,
  ) => Promise<boolean>;
  createFile: (
    workspaceId: string,
    projectId: string,
    path: string,
    content?: string,
  ) => Promise<boolean>;
  deleteFile: (
    workspaceId: string,
    projectId: string,
    path: string,
  ) => Promise<boolean>;
  renameFile: (
    workspaceId: string,
    projectId: string,
    from: string,
    to: string,
  ) => Promise<boolean>;
  /**
   * Apply a server-originated file change (agent server tools poke the realtime
   * channel). Pulls fresh content for an open file, or drops a deleted file.
   * Skips files with unsaved local edits to avoid clobbering the user's buffer.
   */
  applyRemoteFileUpdate: (
    workspaceId: string,
    projectId: string,
    path: string,
    deleted?: boolean,
  ) => Promise<void>;

  fetchJobs: (workspaceId: string, projectId: string) => Promise<void>;
  saveJob: (
    workspaceId: string,
    projectId: string,
    job: Partial<DbtJobItem> & { name: string },
    jobId?: string,
  ) => Promise<DbtJobItem | null>;
  deleteJob: (
    workspaceId: string,
    projectId: string,
    jobId: string,
  ) => Promise<boolean>;
  triggerJob: (
    workspaceId: string,
    projectId: string,
    jobId: string,
  ) => Promise<string | null>;
  retryRun: (
    workspaceId: string,
    projectId: string,
    runId: string,
    jobId?: string,
  ) => Promise<string | null>;

  fetchRuns: (
    workspaceId: string,
    projectId: string,
    jobId?: string,
  ) => Promise<void>;
  fetchRunDetails: (
    workspaceId: string,
    projectId: string,
    runId: string,
  ) => Promise<DbtRunDetails | null>;
  cancelRun: (
    workspaceId: string,
    projectId: string,
    runId: string,
  ) => Promise<boolean>;
  /** Fetch a run artifact and trigger a browser download. */
  downloadRunArtifact: (
    workspaceId: string,
    projectId: string,
    runId: string,
    kind: DbtArtifactKind,
  ) => Promise<boolean>;

  compileModel: (
    workspaceId: string,
    projectId: string,
    select: string | undefined,
    environment?: string,
    defer?: boolean,
  ) => Promise<DbtCompileResult | null>;
  runCommand: (
    workspaceId: string,
    projectId: string,
    command: string,
    environment?: string,
    defer?: boolean,
  ) => Promise<DbtCommandRunResult | null>;
  /** Bounded read-only row preview (`dbt show`) for the editor Results grid. */
  previewModel: (
    workspaceId: string,
    projectId: string,
    select: string,
    environment?: string,
    defer?: boolean,
    limit?: number,
  ) => Promise<DbtPreviewResult | null>;
  fetchLineage: (
    workspaceId: string,
    projectId: string,
  ) => Promise<DbtLineage | null>;

  openProjectSettings: (projectId: string) => void;
  closeProjectSettings: () => void;
  openCreateProject: () => void;
  closeCreateProject: () => void;

  reset: () => void;
}

export type DbtStore = DbtState & DbtActions;

export const initialDbtState: DbtState = {
  projects: [],
  projectsLoaded: false,
  activeProjectId: null,
  filePathsByProject: {},
  filesByProject: {},
  jobsByProject: {},
  runsByProject: {},
  runsByJob: {},
  runDetails: {},
  settingsProjectId: null,
  createProjectOpen: false,
  loading: {},
  error: {},
  loadErrors: {},
};

/**
 * Encode a dbt file path for use in a URL while preserving the "/" separators.
 * `encodeURI` leaves `#`, `?`, `&`, `+` unescaped, which would corrupt the
 * request for paths containing those characters — so encode each segment.
 */
export function encodeDbtPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
