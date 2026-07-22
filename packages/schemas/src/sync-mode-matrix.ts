/**
 * Shared Airbyte-style sync-mode matrix for connector → CDC flows.
 * Used by the API (`validateSyncConfig`) and the SyncFlowForm so FE/BE
 * cannot drift — see docs/sync-modes-hardening-plan.md Phase 4.
 */

export type IncrementalMode =
  | "native"
  | "client-filter"
  | "created-anchor"
  | "none";

export interface IncrementalCapabilities {
  supported: boolean;
  mode: IncrementalMode;
  /** Optional connector-level anchor field (e.g. PostHog `$since`). */
  anchorField?: string;
  perEntity?: Record<string, { mode: IncrementalMode; anchorField?: string }>;
  warning?: string;
}

export type SyncWriteMode = "append_dedup" | "append" | "overwrite";
export type SyncMode = "full" | "incremental";

export interface SyncModeCombo {
  value: string;
  syncMode: SyncMode;
  writeMode: SyncWriteMode;
  label: string;
  help: string;
}

export const SYNC_MODE_COMBOS: SyncModeCombo[] = [
  {
    value: "incremental:append_dedup",
    syncMode: "incremental",
    writeMode: "append_dedup",
    label: "Incremental | Append + Deduped",
    help: "Fetch new or updated records and upsert by primary key — one deduplicated row per record.",
  },
  {
    value: "incremental:append",
    syncMode: "incremental",
    writeMode: "append",
    label: "Incremental | Append",
    help: "Fetch new or updated records and add them as new rows — keeps every version (history).",
  },
  {
    value: "full:append_dedup",
    syncMode: "full",
    writeMode: "append_dedup",
    label: "Full Refresh | Deduped",
    help: "Re-fetch everything each run and upsert by primary key (reconciles drift).",
  },
  {
    value: "full:append",
    syncMode: "full",
    writeMode: "append",
    label: "Full Refresh | Append",
    help: "Re-fetch everything each run and add all rows — accumulates a snapshot per run.",
  },
  {
    value: "full:overwrite",
    syncMode: "full",
    writeMode: "overwrite",
    label: "Full Refresh | Overwrite",
    help: "Re-fetch everything each run; the destination is cleared first and ends up an exact snapshot.",
  },
];

/** Effective incremental mode for one entity (perEntity override → fallback). */
export function effectiveIncrementalMode(
  capabilities: IncrementalCapabilities | undefined,
  entity: string | undefined,
): IncrementalMode {
  if (!capabilities) return "none";
  if (entity && capabilities.perEntity?.[entity]) {
    return capabilities.perEntity[entity].mode;
  }
  // Composite keys like `activities:Call` fall back to connector mode
  // (Close lists activity subtypes under the Search-API path).
  if (entity && entity.includes(":")) {
    const parent = entity.slice(0, entity.indexOf(":"));
    if (capabilities.perEntity?.[parent]) {
      return capabilities.perEntity[parent].mode;
    }
  }
  return capabilities.mode;
}

export function resolveEntityIncrementalModes(
  capabilities: IncrementalCapabilities | undefined,
  selectedEntities: string[],
): IncrementalMode[] {
  if (selectedEntities.length > 0) {
    return selectedEntities.map(entity =>
      effectiveIncrementalMode(capabilities, entity),
    );
  }
  const overrides = Object.keys(capabilities?.perEntity || {});
  if (overrides.length > 0) {
    return overrides.map(entity =>
      effectiveIncrementalMode(capabilities, entity),
    );
  }
  return [capabilities?.mode ?? "none"];
}

export function connectorSupportsIncremental(
  capabilities: IncrementalCapabilities | undefined,
  selectedEntities: string[],
): boolean {
  return resolveEntityIncrementalModes(capabilities, selectedEntities).some(
    mode => mode !== "none",
  );
}

export function needsReconcileSuggestion(
  syncMode: SyncMode,
  capabilities: IncrementalCapabilities | undefined,
  selectedEntities: string[],
): boolean {
  if (syncMode !== "incremental") return false;
  return resolveEntityIncrementalModes(capabilities, selectedEntities).some(
    mode => mode === "none" || mode === "created-anchor",
  );
}

export function supportedCdcWriteModesForDestination(
  destinationType: string | undefined,
): SyncWriteMode[] {
  if (!destinationType) return ["append_dedup"];
  if (destinationType === "clickhouse") return ["append_dedup"];
  // BigQuery / Postgres / Mongo support the full matrix under CDC.
  if (
    destinationType === "bigquery" ||
    destinationType === "postgresql" ||
    destinationType === "mongodb" ||
    destinationType === "mysql"
  ) {
    return ["append_dedup", "append", "overwrite"];
  }
  return ["append_dedup"];
}

export interface AllowedModesInput {
  incrementalCap?: IncrementalCapabilities;
  selectedEntities?: string[];
  destinationType?: string;
  webhookEnabled?: boolean;
  syncEngine?: string;
}

export interface AllowedModesResult {
  combos: SyncModeCombo[];
  connectorSupportsIncremental: boolean;
  warnings: string[];
  needsReconcileSuggestion: boolean;
}

/**
 * Pure combo filter used by SyncFlowForm. Does not know about orphaned
 * saved modes — the UI keeps those visible separately.
 */
export function allowedModes(input: AllowedModesInput): AllowedModesResult {
  const selectedEntities = input.selectedEntities ?? [];
  const supportsIncremental = connectorSupportsIncremental(
    input.incrementalCap,
    selectedEntities,
  );
  const writeModes = supportedCdcWriteModesForDestination(
    input.destinationType,
  );
  const webhookEnabled = Boolean(input.webhookEnabled);

  const combos = SYNC_MODE_COMBOS.filter(combo => {
    if (!writeModes.includes(combo.writeMode)) return false;
    if (combo.writeMode === "overwrite" && webhookEnabled) return false;
    if (combo.syncMode === "incremental" && !supportsIncremental) return false;
    return true;
  });

  const warnings: string[] = [];
  const modes = resolveEntityIncrementalModes(
    input.incrementalCap,
    selectedEntities,
  );
  if (modes.includes("created-anchor")) {
    warnings.push(
      input.incrementalCap?.warning ||
        "Incremental polls only fetch newly created records; updates to existing records require the webhook trigger or a periodic full reconcile.",
    );
  }
  if (modes.some(mode => mode === "none") && supportsIncremental) {
    warnings.push(
      "Some selected entities cannot pull changes-since-X and will full-repull on every incremental poll. Enable a periodic full reconcile (or webhooks) for those streams.",
    );
  }

  return {
    combos,
    connectorSupportsIncremental: supportsIncremental,
    warnings,
    needsReconcileSuggestion: needsReconcileSuggestion(
      "incremental",
      input.incrementalCap,
      selectedEntities,
    ),
  };
}

export interface ValidateSyncConfigInput {
  syncMode: string;
  writeMode?: unknown;
  syncEngine: string;
  destinationType?: string;
  webhookEnabled: boolean;
  selectedEntities?: string[];
  incremental?: IncrementalCapabilities;
  /**
   * When false, skip the hard-reject for incremental+none (used for
   * unrelated updates of existing flows that already had incremental saved).
   * Defaults to true.
   */
  enforceIncrementalCapability?: boolean;
}

export interface ValidateSyncConfigResult {
  error: string | null;
  warnings: string[];
}

/**
 * Server-side sync config validation. Combines write-mode rules with
 * incremental capability honesty checks.
 */
export function validateSyncConfig(
  input: ValidateSyncConfigInput,
): ValidateSyncConfigResult {
  const warnings: string[] = [];
  const syncMode = input.syncMode === "incremental" ? "incremental" : "full";
  const writeMode = input.writeMode;
  const selectedEntities = input.selectedEntities ?? [];
  const enforce =
    input.enforceIncrementalCapability !== undefined
      ? input.enforceIncrementalCapability
      : true;

  if (writeMode !== undefined && writeMode !== null) {
    if (
      writeMode !== "append_dedup" &&
      writeMode !== "append" &&
      writeMode !== "overwrite"
    ) {
      return {
        error: "writeMode must be 'append_dedup', 'append', or 'overwrite'",
        warnings,
      };
    }
    if (writeMode === "overwrite" && syncMode !== "full") {
      return {
        error: "writeMode 'overwrite' requires a Full Refresh (syncMode 'full')",
        warnings,
      };
    }
    if (writeMode === "overwrite" && input.webhookEnabled) {
      return {
        error: "writeMode 'overwrite' cannot be combined with a webhook trigger",
        warnings,
      };
    }
    if (input.syncEngine === "cdc" && writeMode !== "append_dedup") {
      const supported = supportedCdcWriteModesForDestination(
        input.destinationType,
      );
      if (!supported.includes(writeMode)) {
        return {
          error: `writeMode '${writeMode}' is not supported by '${input.destinationType}' destinations (supported: ${supported.join(", ") || "none"})`,
          warnings,
        };
      }
    }
    if (input.syncEngine !== "cdc" && writeMode !== "append_dedup") {
      return {
        error: `writeMode '${writeMode}' requires the CDC sync engine (syncEngine 'cdc'); the legacy engine only supports 'append_dedup'`,
        warnings,
      };
    }
  }

  if (syncMode === "incremental" && enforce) {
    const supports = connectorSupportsIncremental(
      input.incremental,
      selectedEntities,
    );
    if (!supports) {
      return {
        error:
          "syncMode 'incremental' is not supported for the selected entities — this connector would silently re-fetch everything on every poll. Use Full Refresh, enable webhooks, or add a periodic full reconcile.",
        warnings,
      };
    }

    const modes = resolveEntityIncrementalModes(
      input.incremental,
      selectedEntities,
    );
    if (modes.includes("created-anchor")) {
      warnings.push(
        input.incremental?.warning ||
          "Incremental polls only fetch newly created records; updates to existing records require the webhook trigger or a periodic full reconcile.",
      );
    }
    if (modes.some(mode => mode === "none")) {
      warnings.push(
        "Some selected entities cannot pull changes-since-X and will full-repull on every incremental poll. Enable a periodic full reconcile (or webhooks) for those streams.",
      );
    }
  }

  return { error: null, warnings };
}
