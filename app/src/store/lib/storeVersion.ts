/**
 * Store Version Manager
 *
 * Manages localStorage versioning for all persisted stores.
 * When the schema version changes, all store data is cleared to ensure
 * a clean upgrade path without complex migration logic.
 */

const STORE_VERSION_KEY = "mako-store-version";
// Timestamp-based version: YYYYMMDDHHMM format
// Bump this when making breaking schema changes to clear user localStorage
const CURRENT_VERSION = 202601222125;

/**
 * All persisted store keys that should be cleared on version change.
 * Add new store keys here when creating new persisted stores.
 */
const PERSISTED_STORE_KEYS = [
  "explorer-store",
  "console-store",
  "chat-store",
  "ui-store",
  "settings-storage",
];

/**
 * Prefixes of workspace-scoped persisted stores (`<prefix>:<workspaceId>`).
 * Every matching key is cleared on version change.
 */
const PERSISTED_STORE_KEY_PREFIXES = ["console-store:"];

function removeKeysWithPrefixes(): void {
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && PERSISTED_STORE_KEY_PREFIXES.some(p => key.startsWith(p))) {
      toRemove.push(key);
    }
  }
  toRemove.forEach(key => localStorage.removeItem(key));
}

/**
 * Legacy keys to always remove (from old store architecture).
 * These are cleared regardless of version to clean up old data.
 */
const LEGACY_KEYS = ["app-store"];

/**
 * Initialize store versioning.
 * Call this BEFORE any stores are initialized (in main.tsx).
 *
 * If the stored version doesn't match CURRENT_VERSION:
 * 1. All persisted store data is cleared
 * 2. Legacy keys are removed
 * 3. New version is stored
 *
 * This ensures users get a clean slate when upgrading to a new schema version.
 */
export function initializeStoreVersion(): void {
  const stored = localStorage.getItem(STORE_VERSION_KEY);
  const storedVersion = stored ? parseInt(stored, 10) : 0;

  // Always clean up legacy keys
  LEGACY_KEYS.forEach(key => localStorage.removeItem(key));

  if (storedVersion !== CURRENT_VERSION) {
    // Store version changed - clearing stored data for clean upgrade

    // Clear all persisted stores (including workspace-scoped buckets)
    PERSISTED_STORE_KEYS.forEach(key => localStorage.removeItem(key));
    removeKeysWithPrefixes();

    // Set new version
    localStorage.setItem(STORE_VERSION_KEY, String(CURRENT_VERSION));
  }
}

/**
 * Get the current store version.
 * Useful for debugging.
 */
export function getStoreVersion(): number {
  return CURRENT_VERSION;
}

/**
 * Force clear all store data and reset version.
 * Useful for debugging or manual reset scenarios.
 */
export function clearAllStoreData(): void {
  PERSISTED_STORE_KEYS.forEach(key => localStorage.removeItem(key));
  removeKeysWithPrefixes();
  LEGACY_KEYS.forEach(key => localStorage.removeItem(key));
  localStorage.removeItem(STORE_VERSION_KEY);
}
