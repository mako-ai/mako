/**
 * Sync-config validation for flow create/update: the selected entities, the
 * source connector's incremental capabilities, and the write-mode matrix.
 */
import {
  validateSyncConfig,
  type IncrementalCapabilities,
} from "@mako/schemas";
import { connectorRegistry } from "../connectors/registry";
import { supportedCdcWriteModes } from "../sync-cdc/adapters/registry";

export function selectedEntitiesFromFlowBody(body: {
  entityFilter?: unknown;
  entityLayouts?: unknown;
}): string[] {
  const fromFilter = Array.isArray(body.entityFilter)
    ? body.entityFilter.map(String).filter(Boolean)
    : [];
  if (fromFilter.length > 0) return fromFilter;

  if (Array.isArray(body.entityLayouts)) {
    return body.entityLayouts
      .filter(
        (layout: { enabled?: boolean; entity?: string }) =>
          layout?.enabled !== false && typeof layout?.entity === "string",
      )
      .map((layout: { entity: string }) => layout.entity);
  }
  return [];
}

export function resolveConnectorIncrementalCapabilities(
  sourceConnection:
    { type?: string; config?: Record<string, unknown> } | null | undefined,
): IncrementalCapabilities | undefined {
  if (!sourceConnection?.type) return undefined;
  try {
    const connector = connectorRegistry.getConnectorFor({
      id: "validation",
      name: sourceConnection.type,
      type: sourceConnection.type,
      config: sourceConnection.config || {},
    } as any);
    return connector?.getIncrementalCapabilities?.();
  } catch {
    const meta = connectorRegistry
      .getAllMetadata()
      .find(entry => entry.type === sourceConnection.type);
    return meta?.metadata?.incremental;
  }
}

/**
 * Write-mode + incremental-capability validation. Delegates to the shared
 * `@mako/schemas` matrix so SyncFlowForm and the API cannot drift.
 */
export function validateWriteMode(params: {
  writeMode?: unknown;
  syncMode: string;
  destinationType?: string;
  syncEngine: string;
  webhookEnabled: boolean;
  selectedEntities?: string[];
  incremental?: IncrementalCapabilities;
  enforceIncrementalCapability?: boolean;
}): { error: string | null; warnings: string[] } {
  // Prefer the destination-adapter registry's supported modes when available
  // (keeps ClickHouse / new adapters honest), then fall through to the
  // shared pure validator for the rest of the rules.
  if (
    params.writeMode !== undefined &&
    params.writeMode !== null &&
    params.syncEngine === "cdc" &&
    params.writeMode !== "append_dedup"
  ) {
    const supported = supportedCdcWriteModes(params.destinationType);
    if (!supported.includes(params.writeMode as any)) {
      return {
        error: `writeMode '${params.writeMode}' is not supported by '${params.destinationType}' destinations (supported: ${supported.join(", ") || "none"})`,
        warnings: [],
      };
    }
  }

  return validateSyncConfig({
    syncMode: params.syncMode,
    writeMode: params.writeMode,
    syncEngine: params.syncEngine,
    destinationType: params.destinationType,
    webhookEnabled: params.webhookEnabled,
    selectedEntities: params.selectedEntities,
    incremental: params.incremental,
    enforceIncrementalCapability: params.enforceIncrementalCapability,
  });
}
