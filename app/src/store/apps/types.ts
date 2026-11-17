/**
 * Apps store types: app/file/git/box payloads and the store surface.
 */
import { type LoadError } from "../../api";
import type { PublicShareInfo } from "../shareStore";

export interface AppMeta {
  id: string;
  /** The app's own folder name — the last segment of `path`, and its URL
   *  handle when the app sits at the top of the workspace tree. */
  slug?: string;
  /**
   * Repo-relative folder the app lives in: `apps/Sales/CH/report` or
   * `users/<handle>/apps/scratch`. The folders between the tree root and the app
   * are the explorer's tree. Identity is `id`, which the manifest carries, so
   * a move keeps everything.
   */
  path?: string;
  /** Which tree: the workspace's, or one person's (`users/<handle>/apps`). */
  scope?: "workspace" | "private";
  /**
   * Set on a copied folder whose mako.json still declares another app's id:
   * the server filed it under an id of its own and offers to stamp it.
   */
  duplicateOf?: string;
  /** A workspace admin vouched for this app (workspace tree only). */
  verified?: boolean;
  title: string;
  description?: string;
  updatedAt?: string;
  createdAt?: string;
  /** Commit sha currently deployed, if the app has ever been published. */
  publishedSha?: string;
  publishedAt?: string;
  /** Sharing scope: private = owner's "My Apps", workspace = everyone's. */
  access?: "private" | "workspace";
  /**
   * The user who owns the sharing state (API field name, as stored). A
   * private app whose owner is not the viewer was shared with them
   * personally — the sidebar's "Shared with me" section.
   */
  owner_id?: string;
  /** What workspace members may do with a workspace-access app. */
  workspaceRole?: "viewer" | "editor";
  /** Safe public-link metadata; password material never leaves the API. */
  publicShare?: PublicShareInfo;
  /** Whether live-link viewers can chat with the app (default off). */
  chatEnabled?: boolean;
}

export interface AppFileEntry {
  path: string;
  size: number;
}

/** One env var as the API returns it (no value when it is a secret). */
export interface AppEnvVar {
  key: string;
  secret: boolean;
  value?: string;
}

export interface AppChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** In the index (git add) — VS Code's "Staged Changes" group. */
  staged?: boolean;
  /** In the working tree, not (fully) staged — the "Changes" group. */
  unstaged?: boolean;
}

export interface AppFileVersions {
  head: string | null;
  index: string | null;
  working: string | null;
  binary: boolean;
}

/** Mirror of the API's BoxState — what the sandbox pushed about itself. */
export interface AppsBoxState {
  branch: string | null;
  head?: string | null;
  ahead?: number | null;
  changes: AppChange[] | null;
  devServers: Array<{
    slug: string;
    port: number;
    url?: string;
    reachable?: boolean;
    blockedBy?: PreviewBlock;
  }> | null;
  /** The E2B sandbox id backing this box; null when none is running. */
  sandboxId?: string | null;
  /** Coarse liveness — "offline" is published the instant a box is recycled. */
  status?: "online" | "offline";
  /** Open terminal session ids. */
  terminals?: string[] | null;
  updatedAt: number;
}

export interface AppStatus {
  branch: string;
  /** Commit the working copy is on. */
  baseSha: string;
  branchHead: string | null;
  /** Commits this branch has that the server does not. */
  ahead: number;
  /** Uncommitted changes inside this app's folder. */
  changes: AppChange[];
  /**
   * Uncommitted changes anywhere in the repo. One working copy serves every
   * app, so this — not `changes` — is what a branch switch has to get past and
   * what Discard throws away.
   */
  repoChanges: AppChange[];
  /**
   * No sandbox is running, so this is the last committed state rather than a
   * working copy. Not the same as "clean": there is nothing to be dirty.
   */
  offline: boolean;
}

export interface AppCommit {
  oid: string;
  author: string;
  timestamp: number;
  subject: string;
}

/** What is live for an app (GET /publish-state). */
export interface AppPublishState {
  publishedSha: string | null;
  publishedAt: string | null;
  /** The deployed commit; null when the server could not read it. */
  publishedCommit: Omit<AppCommit, "oid"> | null;
  branch: string;
  upToDate: boolean;
  /** App commits on the branch that are not live; null when unknown. */
  pendingCommits: number | null;
  lastDeployError: {
    sha: string;
    stage: "bindings" | "build" | "publish";
    message: string;
    at: string;
  } | null;
}

/** One file a commit touched, app-relative (from GET /git/commit). */
export interface AppCommitFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

/** A file before/after one commit (null = absent on that side). */
export interface AppCommitFileVersions {
  before: string | null;
  after: string | null;
  binary: boolean;
}

export interface AppTerminalEntry {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  durationMs?: number;
  running?: boolean;
  at: number;
}

export interface AppBranch {
  name: string;
  head: string;
  isDefault: boolean;
  aheadOfMain: number;
  lastCommit?: { subject: string; author: string; timestamp: number };
}

export interface AppPreview {
  url: string | null;
  building: boolean;
  /** A publish build is running — distinct from a dev server starting. */
  publishing?: boolean;
  error: string | null;
  buildOutput?: string;
  builtAt?: number;
  /** "dev" = live `vite dev` proxy (HMR, no rebuild step); "static" = one-shot build. */
  mode?: "static" | "dev";
  /** false = the preview host answers 403 (see box-state). */
  reachable?: boolean;
  /** Who refused it: the dev server ("host") or E2B's edge ("e2b-traffic-token"). */
  blockedBy?: PreviewBlock;
}

/** Who refused a dev preview's public host (api box-state PreviewBlock). */
export type PreviewBlock = "host" | "e2b-traffic-token";

export interface AppRepoBinding {
  /** GitHub App installation granting access (needed to re-save the binding). */
  installationId?: number;
  owner: string;
  repo: string;
  defaultBranch: string;
  subdirectory: string;
}

export interface AppGithubRepo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface AppGithubInstallation {
  installationId: number;
  accountLogin: string;
  accountType?: string;
}

export interface AppsStore {
  /**
   * Whether app creation works: a repo is connected OR the server has
   * Mako-hosted cloud storage configured (instant start, no GitHub setup).
   */
  canCreate: boolean | undefined;
  /** Connected workspace repos (0..N; the product default is one). */
  repos: AppRepoBinding[];
  apps: AppMeta[];
  /**
   * The last list per workspace, persisted (localStorage) so the sidebar
   * renders instantly on the next visit and refreshes in the background —
   * the same trick the database catalog uses. Only ever seeded INTO `apps`;
   * everything else reads `apps`.
   */
  appsCacheByWorkspace: Record<string, AppMeta[]>;
  /**
   * Folders of the two app trees the caller can see (`apps/Sales`,
   * `users/<handle>/apps/Scratch`), empty ones included — real directories in
   * the workspace repo, straight from the list endpoint.
   */
  folders: string[];
  /**
   * The caller's own tree, `users/<handle>/apps` — named by their handle in
   * this workspace, which only the server knows. Null until the list loads,
   * or for an actor with no personal tree.
   */
  personalRoot: string | null;
  appsLoading: boolean;
  error: string | null;

  filesByApp: Record<string, AppFileEntry[]>;
  /**
   * Apps whose cached per-app state is known to be out of date.
   *
   * A workspace-wide change marks every loaded app instead of refetching it.
   * The set is drained by {@link AppsStore.refreshAppIfStale}, which the
   * active tab calls on activation — so "stale" is never a resting state for
   * something on screen, only for something nobody is looking at.
   */
  staleApps: Record<string, true>;
  /**
   * Set when the server capped an app's listing — { shown, total }. A
   * 100k-file folder (a committed node_modules, a data dump) renders its
   * first files plus this notice instead of crashing the tree.
   */
  filesTruncatedByApp: Record<string, { shown: number; total?: number }>;
  fileContents: Record<string, { contents: string; dirty: boolean }>;
  selectedFile: Record<string, string | null>;
  statusByApp: Record<string, AppStatus | null>;
  /**
   * Which apps the user has opened for EDITING.
   *
   * Browsing an app costs nothing: its files come from git and no sandbox
   * starts. Editing needs a real machine — a checkout, a shell, somewhere for
   * npm to run — so it is entered deliberately rather than by opening a tab,
   * and a microVM only boots when someone actually means to work.
   */
  editingByApp: Record<string, boolean>;
  /**
   * Cookie-free URL for each app's PUBLISHED build, for the consumer view.
   *
   * It cannot just be the app's own `/live/` URL: that view runs in a
   * sandboxed, opaque-origin iframe, and ES modules are always fetched in CORS
   * mode without credentials — so a cookie-authorized URL 401s in there and
   * the app renders as a blank page.
   */
  viewUrlByApp: Record<string, string | undefined>;
  /**
   * Why the last view-token request failed. The view shows it (with Retry)
   * for a published app instead of the never-built screen, which a failed
   * request used to fall through to.
   */
  viewUrlErrorByApp: Record<string, LoadError | undefined>;
  /**
   * What each view URL was minted for: the published commit and when the
   * token expires. Lets an app that opens with a token already in hand (a
   * prefetch, a remounted tab) use it instead of asking again.
   */
  viewTokenByApp: Record<
    string,
    { sha: string; expiresAt: number } | undefined
  >;
  historyByApp: Record<string, AppCommit[]>;
  /** The published chip's context: commit, age, what main has that is not live. */
  publishStateByApp: Record<string, AppPublishState | undefined>;
  /** Files per commit, per app — the History panel's "View changes". */
  commitFilesByApp: Record<string, Record<string, AppCommitFile[]>>;
  /** Repo-wide graph (Source Control panel) — same repo, no app pathspec. */
  branchesByApp: Record<string, AppBranch[]>;
  terminalByApp: Record<string, AppTerminalEntry[]>;
  execRunning: Record<string, boolean>;
  previewByApp: Record<string, AppPreview>;
  viewMode: Record<string, "code" | "preview">;

  probeEnabled: (workspaceId: string) => Promise<void>;
  fetchGithubStatus: (workspaceId: string) => Promise<{
    installations: AppGithubInstallation[];
    appSlug: string | null;
  }>;
  fetchGithubRepos: (
    workspaceId: string,
    installationId: number,
  ) => Promise<AppGithubRepo[]>;
  getGitHubInstallUrl: (workspaceId: string) => Promise<string | null>;
  /**
   * User-authorization OAuth flow: binds installations that already exist on
   * GitHub (whose install page short-circuits and never fires our callback).
   */
  getGitHubSyncUrl: (workspaceId: string) => Promise<string | null>;
  /** Branch names of a repo (for the branch switcher). */
  fetchGithubBranches: (
    workspaceId: string,
    owner: string,
    repo: string,
    installationId?: number,
  ) => Promise<string[]>;
  connectRepo: (
    workspaceId: string,
    input: {
      owner: string;
      repo: string;
      defaultBranch?: string;
      subdirectory?: string;
      installationId?: number;
    },
  ) => Promise<{
    ok: boolean;
    error?: string;
    /** §13.17 connect-time reconciliation outcome. */
    adoption?: "imported" | "seeded" | "reconnected" | "fresh" | "deferred";
  }>;
  disconnectRepo: (
    workspaceId: string,
    owner: string,
    repo: string,
  ) => Promise<void>;
  disconnectGithubInstallation: (
    workspaceId: string,
    installationId: number,
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Load the app list. Calls while one is already on the wire share it —
   * on load the explorer, the URL sync, every restored app tab and the
   * editors each ask at once. `fresh`: the caller just changed something
   * and needs a list read AFTER that change, so it gets one trailing
   * request (shared by every such caller) instead of the one in flight.
   */
  fetchApps: (
    workspaceId: string,
    options?: { fresh?: boolean },
  ) => Promise<void>;
  /** Drag between rail sections: flip private <-> workspace. */
  setAppAccess: (
    workspaceId: string,
    appId: string,
    access: "private" | "workspace",
  ) => Promise<void>;
  createApp: (
    workspaceId: string,
    title: string,
    description?: string,
    /** Destination folder path (`apps`, `apps/Sales`, `users/<handle>/apps`). */
    folder?: string,
  ) => Promise<AppMeta | null>;
  deleteApp: (workspaceId: string, appId: string) => Promise<boolean>;
  /**
   * File an app in another folder (and/or rename its folder). One commit on
   * main; the app keeps its id so tabs, favourites and deployments follow.
   */
  moveApp: (
    workspaceId: string,
    appId: string,
    folder: string,
    name?: string,
  ) => Promise<boolean>;
  createAppFolder: (workspaceId: string, path: string) => Promise<boolean>;
  moveAppFolder: (
    workspaceId: string,
    path: string,
    to: string,
  ) => Promise<boolean>;
  deleteAppFolder: (workspaceId: string, path: string) => Promise<boolean>;
  /** Give a copied app (duplicateOf set) an id of its own. */
  stampAppId: (workspaceId: string, appId: string) => Promise<boolean>;
  /** Workspace admins: vouch for an app (or withdraw it). */
  setAppVerified: (
    workspaceId: string,
    appId: string,
    verified: boolean,
  ) => Promise<boolean>;
  /**
   * Move a personal app into the Workspace tree, writing a one-line
   * description into its manifest. One commit; the app keeps its id.
   */
  shareAppWithWorkspace: (
    workspaceId: string,
    appId: string,
    description: string,
  ) => Promise<boolean>;

  /**
   * List an app's files.
   *
   * There is no longer a "live" variant to ask for: the server reads the
   * sandbox's working copy whenever one is running, so a file created in the
   * terminal is simply there, and reads the last commit when it is not.
   */
  fetchFiles: (workspaceId: string, appId: string) => Promise<void>;
  openFile: (workspaceId: string, appId: string, path: string) => Promise<void>;
  updateFileLocal: (appId: string, path: string, contents: string) => void;
  saveFile: (workspaceId: string, appId: string, path: string) => Promise<void>;

  runCommand: (
    workspaceId: string,
    appId: string,
    command: string,
  ) => Promise<void>;
  clearTerminal: (appId: string) => void;

  fetchStatus: (workspaceId: string, appId: string) => Promise<void>;
  fetchHistory: (workspaceId: string, appId: string) => Promise<void>;
  fetchPublishState: (workspaceId: string, appId: string) => Promise<void>;
  fetchBranches: (workspaceId: string, appId: string) => Promise<void>;
  /**
   * Refetch an app's cached state, but only if a workspace change marked it
   * stale. Called when an app tab becomes active, which is what makes
   * "invalidate, don't refetch" safe: nothing on screen stays stale, and the
   * work happens for one app at a time instead of for every app at once.
   */
  refreshAppIfStale: (workspaceId: string, appId: string) => void;
  /** Mark every loaded app stale — a workspace-wide change touched them all. */
  markAllAppsStale: () => void;
  /**
   * Fetch (or refresh) the cookie-free URL for an app's published build.
   *
   * `ref` is the app's id, or — for a prefetch before the app list has
   * loaded — whatever the address bar names (a slug); the answer is filed
   * under the app id the server resolved. `reuseFresh` joins a request in
   * flight and keeps a token minted for the current publish with minutes to
   * spare. `speculative` records nothing on failure: a prefetch for an app
   * that turns out unpublished must not paint an error.
   */
  fetchViewUrl: (
    workspaceId: string,
    ref: string,
    options?: { reuseFresh?: boolean; speculative?: boolean },
  ) => Promise<void>;
  /** Enter or leave edit mode for an app (see `editingByApp`). */
  setEditing: (workspaceId: string, appId: string, editing: boolean) => void;
  /**
   * Switch which branch this app's worktree is on — a real `git checkout` in
   * the sandbox, so the shell and the UI agree afterwards. Resolves to an
   * error message when the server refuses (uncommitted work), rather than
   * throwing, so the menu can say why.
   */
  checkoutBranch: (
    workspaceId: string,
    appId: string,
    branch: string,
    options?: { create?: boolean },
  ) => Promise<string | null>;
  mergeBranch: (
    workspaceId: string,
    appId: string,
    branch: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  commit: (
    workspaceId: string,
    appId: string,
    message: string,
    options?: { stagedOnly?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Per-file git actions from the Source Control view (repo-relative paths). */
  gitPaths: (
    workspaceId: string,
    appId: string,
    action: "stage" | "unstage" | "discard",
    paths: string[],
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * What one commit changed — in this app (app-relative paths) or, with
   * scope "repo", across the repository (repo-relative). Cached per key.
   */
  fetchCommitFiles: (
    workspaceId: string,
    appId: string,
    sha: string,
    scope?: "app" | "repo",
  ) => Promise<AppCommitFile[] | null>;
  fetchCommitFileVersions: (
    workspaceId: string,
    appId: string,
    sha: string,
    path: string,
  ) => Promise<AppCommitFileVersions | null>;
  /**
   * Restore the app to `sha` as a NEW commit on the caller's branch. Throws
   * with the server's message so the caller can show it where it acted.
   */
  restoreVersion: (
    workspaceId: string,
    appId: string,
    sha: string,
  ) => Promise<void>;
  /** Repoint the live (published) app at a previously published sha. */
  rollbackTo: (
    workspaceId: string,
    appId: string,
    sha: string,
  ) => Promise<void>;
  fetchFileVersions: (
    workspaceId: string,
    appId: string,
    path: string,
  ) => Promise<AppFileVersions | null>;
  discard: (workspaceId: string, appId: string) => Promise<void>;

  // No branch parameter on any of these: chats no longer have their own
  // branch, so there is exactly one answer to "which branch" — the caller's —
  // and the server is the one that knows it.
  /**
   * Tail the dev-session boot log — the sandbox's real npm install + vite
   * output from `offset` on. What the boot screen shows.
   */
  /**
   * Ask the server whether the dev session is actually serving; when it is
   * not (stopped from its own terminal with Ctrl-C, crashed, sandbox
   * recycled), drop the client's preview state so the workbench flips to
   * the launch state instead of showing a stale iframe as "live".
   */
  checkDevStatus: (workspaceId: string, appId: string) => Promise<void>;
  /** A dev server for this app is serving at `url` (discovery or push). */
  markDevServing: (
    appId: string,
    url: string,
    reachable?: boolean,
    blockedBy?: PreviewBlock,
  ) => void;
  /** No dev server is serving this app any more. */
  markDevDown: (appId: string) => void;
  /**
   * Whose sandbox pushes to believe. Boxes are per (workspace, user); the
   * realtime channel is per workspace, so events name their user and the
   * store ignores other people's machines.
   */
  currentUserId: string | null;
  setCurrentUserId: (userId: string | null) => void;
  /** Apply a pushed box snapshot directly to dev-server and git state. */
  applyBoxState: (userId: string, state: AppsBoxState) => void;
  /** Slugs of apps whose dev server is live — the sidebar's green dots. */
  runningDevApps: string[];
  /** Current box liveness/identity from the pushed snapshot (reactive). */
  boxStatus?: "online" | "offline";
  boxSandboxId?: string | null;
  boxTerminals: string[];
  fetchRunningDevApps: (workspaceId: string) => Promise<void>;
  /** Deep sandbox stats (a live exec with a 1s CPU sample); null if no box. */
  fetchSandboxStats: (
    workspaceId: string,
    appId: string,
  ) => Promise<Record<string, unknown> | null>;
  /** Kill the sandbox; the next touch builds a fresh one. */
  recycleSandbox: (workspaceId: string, appId: string) => Promise<void>;
  /**
   * Stop dev mode: kill the dev server AND every terminal session in the
   * box, and clear the remembered shell tabs — re-entering dev starts from
   * exactly one fresh dev terminal.
   */
  stopDev: (workspaceId: string, appId: string) => Promise<void>;
  /**
   * The app's env vault (per-app environment variables). Secrets never echo
   * their value back — the API accepts and injects them, it does not
   * retrieve them — so `value` is absent whenever `secret` is true.
   */
  fetchAppEnv: (workspaceId: string, appId: string) => Promise<AppEnvVar[]>;
  setAppEnvVar: (
    workspaceId: string,
    appId: string,
    input: { key: string; value: string; secret: boolean },
  ) => Promise<AppEnvVar[]>;
  deleteAppEnvVar: (
    workspaceId: string,
    appId: string,
    key: string,
  ) => Promise<void>;
  /** Bindings state for an app (per-binding materialization status/history). */
  fetchAppBindings: (
    workspaceId: string,
    appId: string,
  ) => Promise<Array<Record<string, unknown> & { name: string }>>;
  /** Kick a materialization run for one binding; returns the run summary. */
  materializeAppBinding: (
    workspaceId: string,
    appId: string,
    name: string,
  ) => Promise<Record<string, unknown>>;
  /** Closing a terminal tab kills its remote session (pty + dtach + recording). */
  killTerminalSession: (
    workspaceId: string,
    appId: string,
    termId: string,
  ) => Promise<void>;
  /**
   * Report real use of the live preview (pointer into it, click into it), so
   * the sandbox is not paused for idleness under someone using it.
   * Best effort.
   */
  reportBoxActivity: (workspaceId: string, appId: string) => Promise<void>;
  fetchDevLog: (
    workspaceId: string,
    appId: string,
    offset: number,
  ) => Promise<{ size: number; chunk: string }>;
  /** Merge to main, build, deploy, and repoint (§13.3). */
  publishApp: (workspaceId: string, appId: string) => Promise<void>;
  buildPreview: (workspaceId: string, appId: string) => Promise<void>;
  // Prototype of apps.md §4.7's "dev preview" tier (local-provider only —
  // see api/src/apps/dev-server.service.ts). Starts (or reuses) a
  // persistent `vite dev` process and iframes it directly: HMR picks up
  // every subsequent file change with no rebuild step, unlike buildPreview.
  startDevPreview: (
    workspaceId: string,
    appId: string,
    opts?: { restart?: boolean },
  ) => Promise<void>;
  setViewMode: (appId: string, mode: "code" | "preview") => void;
  clearError: () => void;
}
