import type { AppsStore } from "./types";

type AppsActionKey = {
  [K in keyof AppsStore]-?: AppsStore[K] extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof AppsStore];

export type AppsState = Omit<AppsStore, AppsActionKey>;

export const initialAppsState: AppsState = {
  canCreate: undefined,
  repos: [],
  apps: [],
  appsCacheByWorkspace: {},
  folders: [],
  personalRoot: null,
  appsLoading: false,
  error: null,
  filesByApp: {},
  staleApps: {},
  filesTruncatedByApp: {},
  fileContents: {},
  selectedFile: {},
  statusByApp: {},
  editingByApp: {},
  viewUrlByApp: {},
  viewUrlErrorByApp: {},
  viewTokenByApp: {},
  historyByApp: {},
  publishStateByApp: {},
  commitFilesByApp: {},
  runningDevApps: [],
  boxStatus: undefined,
  boxSandboxId: null,
  boxTerminals: [],
  currentUserId: null,
  branchesByApp: {},
  terminalByApp: {},
  execRunning: {},
  previewByApp: {},
  viewMode: {},
};
