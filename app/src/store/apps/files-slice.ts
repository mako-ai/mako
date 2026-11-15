/**
 * An app's files and its command terminal.
 */
import { api, unwrapBody, toErrorMessage as message } from "../../api";
import { fileKey } from "./runtime";
import type { AppFileEntry } from "./types";
import type { AppsSlice } from "./slice";

type Keys =
  | "fetchFiles"
  | "openFile"
  | "updateFileLocal"
  | "saveFile"
  | "runCommand"
  | "clearTerminal";

export const createAppsFilesSlice: AppsSlice<Keys> = (set, get) => ({
  fetchFiles: async (workspaceId, appId) => {
    try {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/apps/{id}/files", {
          params: {
            path: { workspaceId, id: appId },
          },
        }),
      ) as {
        files?: AppFileEntry[];
        truncated?: boolean;
        total?: number;
      };
      set(s => {
        s.filesByApp[appId] = body.files ?? [];
        if (body.truncated) {
          s.filesTruncatedByApp[appId] = {
            shown: body.files?.length ?? 0,
            total: body.total,
          };
        } else {
          delete s.filesTruncatedByApp[appId];
        }
      });
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to list files");
      });
    }
  },

  openFile: async (workspaceId, appId, path) => {
    set(s => {
      s.selectedFile[appId] = path;
    });
    const key = fileKey(appId, path);
    const cached = get().fileContents[key];
    if (cached?.dirty) return; // Never clobber unsaved local edits.
    try {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/apps/{id}/file", {
          params: { path: { workspaceId, id: appId }, query: { path } },
        }),
      ) as { file?: { contents: string; isBinary: boolean } };
      set(s => {
        s.fileContents[key] = {
          contents: body.file?.isBinary
            ? "(binary file)"
            : (body.file?.contents ?? ""),
          dirty: false,
        };
      });
    } catch (e) {
      set(s => {
        s.error = message(e, `Failed to read ${path}`);
      });
    }
  },

  updateFileLocal: (appId, path, contents) => {
    set(s => {
      s.fileContents[fileKey(appId, path)] = { contents, dirty: true };
    });
  },

  saveFile: async (workspaceId, appId, path) => {
    const entry = get().fileContents[fileKey(appId, path)];
    if (!entry?.dirty) return;
    try {
      unwrapBody(
        await api.PUT("/api/workspaces/{workspaceId}/apps/{id}/file", {
          params: { path: { workspaceId, id: appId } },
          body: { path, contents: entry.contents },
        }),
      );
      set(s => {
        const cur = s.fileContents[fileKey(appId, path)];
        // Only clear dirty if no further local edits raced the save.
        if (cur && cur.contents === entry.contents) cur.dirty = false;
      });
      void get().fetchStatus(workspaceId, appId);
      void get().fetchFiles(workspaceId, appId);
    } catch (e) {
      set(s => {
        s.error = message(e, `Failed to save ${path}`);
      });
    }
  },

  runCommand: async (workspaceId, appId, command) => {
    const entryId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    set(s => {
      s.execRunning[appId] = true;
      (s.terminalByApp[appId] ??= []).push({
        id: entryId,
        command,
        stdout: "",
        stderr: "",
        exitCode: null,
        running: true,
        at: Date.now(),
      });
    });
    try {
      const body = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/apps/{id}/exec", {
          params: { path: { workspaceId, id: appId } },
          body: { command },
        }),
      ) as {
        result?: {
          exitCode: number;
          stdout: string;
          stderr: string;
          timedOut: boolean;
          durationMs: number;
        };
      };
      set(s => {
        const entry = (s.terminalByApp[appId] ?? []).find(
          t => t.id === entryId,
        );
        if (entry && body.result) {
          entry.stdout = body.result.stdout;
          entry.stderr = body.result.stderr;
          entry.exitCode = body.result.exitCode;
          entry.timedOut = body.result.timedOut;
          entry.durationMs = body.result.durationMs;
          entry.running = false;
        }
        s.execRunning[appId] = false;
      });
      // A shell command can change anything: refresh the read model.
      void get().fetchFiles(workspaceId, appId);
      void get().fetchStatus(workspaceId, appId);
      const selected = get().selectedFile[appId];
      if (selected) {
        const key = fileKey(appId, selected);
        const cur = get().fileContents[key];
        if (cur && !cur.dirty) {
          void get().openFile(workspaceId, appId, selected);
        }
      }
    } catch (e) {
      set(s => {
        const entry = (s.terminalByApp[appId] ?? []).find(
          t => t.id === entryId,
        );
        if (entry) {
          entry.stderr = message(e, "Command failed");
          entry.exitCode = -1;
          entry.running = false;
        }
        s.execRunning[appId] = false;
      });
    }
  },

  clearTerminal: appId => {
    set(s => {
      s.terminalByApp[appId] = [];
    });
  },
});
