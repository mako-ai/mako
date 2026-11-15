/**
 * Console tab persistence: per-workspace localStorage buckets, throttled
 * writes, and the rehydrate migrations (keys and formats unchanged).
 */
import type { PersistStorage } from "zustand/middleware";
import { computeConsoleStateHash } from "../../utils/stateHash";
import type { ConsoleTab } from "../lib/types";
import { getCurrentWorkspaceId } from "../workspaceStore";
import { lastSavedContentHash } from "./runtime";

/**
 * Tabs are persisted per workspace: `console-store:<workspaceId>`. The active
 * workspace id is per browser tab (workspaceStore, seeded at boot from the
 * per-tab hint written before the post-switch reload), so each boot
 * rehydrates the bucket that belongs to the workspace being loaded — switching workspaces no longer leaks tabs from
 * another workspace, and switching back restores that workspace's tabs.
 */
const CONSOLE_STORE_BASE_KEY = "console-store";

function consoleStoreStorageKey(): string {
  const workspaceId = getCurrentWorkspaceId();
  return workspaceId
    ? `${CONSOLE_STORE_BASE_KEY}:${workspaceId}`
    : CONSOLE_STORE_BASE_KEY;
}

/**
 * One-time migration: users upgrading from the global bucket keep the tabs of
 * the workspace they are currently in; the legacy key is removed so it can't
 * leak into other workspaces later.
 */
function readConsoleStoreItem(): string | null {
  const key = consoleStoreStorageKey();
  const scoped = localStorage.getItem(key);
  if (scoped !== null) return scoped;
  if (key === CONSOLE_STORE_BASE_KEY) return null;
  const legacy = localStorage.getItem(CONSOLE_STORE_BASE_KEY);
  if (legacy !== null) {
    localStorage.setItem(key, legacy);
    localStorage.removeItem(CONSOLE_STORE_BASE_KEY);
  }
  return legacy;
}

/** Bucket this session's in-memory tab state was rehydrated from. */
let hydratedConsoleStoreKey: string | null = null;

/**
 * Resolve the bucket writes should target, or null to skip the write.
 *
 * When the active workspace changes mid-session (workspace switch, invite
 * accept) the in-memory tabs still belong to the previous workspace, so
 * persisting them under the new workspace's key would leak them across
 * workspaces. Writes are frozen until the post-switch reload rehydrates the
 * correct bucket. The one legitimate flip — booting with no workspace selected
 * and resolving to one — adopts the new key instead.
 */
function consoleStoreWriteKey(): string | null {
  const key = consoleStoreStorageKey();
  if (hydratedConsoleStoreKey === null || hydratedConsoleStoreKey === key) {
    return key;
  }
  if (hydratedConsoleStoreKey === CONSOLE_STORE_BASE_KEY) {
    hydratedConsoleStoreKey = key;
    return key;
  }
  return null;
}

/**
 * Persisted writes are coalesced: `persist` calls setItem on EVERY store set
 * (each keystroke flush, each status change), and each call serialized every
 * tab synchronously. Writes now land at most once per
 * CONSOLE_PERSIST_THROTTLE_MS, plus a flush when the page is hidden/unloaded
 * so the last edit is never lost.
 */
const CONSOLE_PERSIST_THROTTLE_MS = 500;
let pendingConsoleWrite: { key: string; value: unknown } | null = null;
let consoleWriteTimer: ReturnType<typeof setTimeout> | null = null;
let warnedConsoleQuota = false;

function writeConsoleStoreNow(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // QuotaExceededError (or storage disabled) must not throw out of the
    // store action that triggered the write; tabs stay in memory.
    if (!warnedConsoleQuota) {
      warnedConsoleQuota = true;
      console.warn("[consoleStore] could not persist tabs", error);
    }
  }
}

function flushConsoleStoreWrite(): void {
  if (consoleWriteTimer) {
    clearTimeout(consoleWriteTimer);
    consoleWriteTimer = null;
  }
  const pending = pendingConsoleWrite;
  pendingConsoleWrite = null;
  if (pending) writeConsoleStoreNow(pending.key, pending.value);
}

function scheduleConsoleStoreWrite(key: string, value: unknown): void {
  // A different bucket must not swallow the previous bucket's last write.
  if (pendingConsoleWrite && pendingConsoleWrite.key !== key) {
    flushConsoleStoreWrite();
  }
  pendingConsoleWrite = { key, value };
  if (!consoleWriteTimer) {
    consoleWriteTimer = setTimeout(
      flushConsoleStoreWrite,
      CONSOLE_PERSIST_THROTTLE_MS,
    );
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushConsoleStoreWrite);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushConsoleStoreWrite();
  });
}

/** Persisted tab shape: result sample rows are server artifacts (lastRun is
 * re-synced on load) and can be large, so they are not written to storage. */
export function tabForPersistence(tab: ConsoleTab): ConsoleTab {
  if (!tab.lastRun?.sampleRows) return tab;
  const { sampleRows: _sampleRows, ...lastRun } = tab.lastRun;
  return { ...tab, lastRun };
}

/** The persist storage adapter (the `name` argument is ignored: keys are
 * resolved per workspace at call time). */
export const consoleStorage: PersistStorage<unknown> = {
  // The `name` argument is ignored on purpose: reads and writes resolve
  // the per-workspace key at call time (see consoleStoreStorageKey).
  getItem: () => {
    hydratedConsoleStoreKey = consoleStoreStorageKey();
    const str = readConsoleStoreItem();
    if (str) {
      const data = JSON.parse(str);
      if (data.state?.tabs) {
        // Dashboards were removed; their open tabs cannot be reopened.
        for (const [id, tab] of Object.entries(data.state.tabs)) {
          if ((tab as { kind?: string }).kind === "dashboard") {
            delete data.state.tabs[id];
            if (data.state.activeTabId === id) {
              data.state.activeTabId = null;
            }
          }
        }
        // Rebuild or reconcile tabOrder with the current tabs map so
        // upgrading users don't end up with an empty tab strip.
        const tabIds = Object.keys(data.state.tabs);
        const persistedOrder: string[] = Array.isArray(data.state.tabOrder)
          ? data.state.tabOrder.filter((id: string) =>
              Object.prototype.hasOwnProperty.call(data.state.tabs, id),
            )
          : [];
        const missing = tabIds.filter(id => !persistedOrder.includes(id));
        data.state.tabOrder = [...persistedOrder, ...missing];

        Object.values(data.state.tabs).forEach((tab: any) => {
          if (tab.databaseId === undefined && tab.metadata?.queryOptions) {
            tab.databaseId =
              tab.metadata.queryOptions.databaseId ||
              tab.metadata.queryOptions.databaseName;
          }
          if (tab.databaseName === undefined && tab.metadata?.queryOptions) {
            tab.databaseName = tab.metadata.queryOptions.databaseLabel;
          }
          if (tab.isSaved === undefined) {
            tab.isSaved = !!tab.filePath;
          }
          // Console/notebook diff tabs became one kind shared with
          // flows and connectors; carry open ones across the rename.
          if (tab.kind === "console-diff" || tab.kind === "notebook-diff") {
            const entity = tab.kind === "console-diff" ? "console" : "notebook";
            const meta = tab.metadata ?? {};
            tab.kind = "history-diff";
            tab.metadata = {
              entity,
              id: meta.consoleId ?? meta.notebookId,
              path: meta.path,
              sha: meta.sha,
            };
          }
          delete tab.initialContent;
          delete tab.dbContentHash;
          delete tab.savedConnectionId;
          delete tab.savedDatabaseId;
          delete tab.savedDatabaseName;

          // Seed the autosave baseline with the persisted content.
          // The module-level hash map is empty on every page load;
          // without seeding, a net-zero edit (type + undo) in a
          // rehydrated draft fires an autosave of unchanged content,
          // which can only 409 against newer remote edits and locks
          // the tab into a phantom conflict. The first revision sync
          // re-seeds with the server copy if it moved while we were
          // away (applyRemoteConsoleEntry / fetchConsoleContent).
          if (
            (tab.kind === undefined || tab.kind === "console") &&
            typeof tab.content === "string" &&
            typeof tab.id === "string"
          ) {
            lastSavedContentHash.set(
              tab.id,
              computeConsoleStateHash(
                tab.content,
                tab.connectionId,
                tab.databaseId,
                tab.databaseName,
              ),
            );
          }
        });
      }
      return data;
    }

    return null;
  },
  setItem: (_name, value) => {
    const key = consoleStoreWriteKey();
    if (key) scheduleConsoleStoreWrite(key, value);
  },
  removeItem: () => {
    const key = consoleStoreWriteKey();
    if (!key) return;
    if (pendingConsoleWrite?.key === key) pendingConsoleWrite = null;
    try {
      localStorage.removeItem(key);
    } catch {
      // storage unavailable
    }
  },
};
