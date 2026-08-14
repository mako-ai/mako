import { useCallback, useState, useEffect } from "react";
import { useAppStore } from "../store/appStore";

interface UseEnvironmentMaterializationOptions {
  workspaceId: string;
  appId: string;
  bindingId: string;
  environment?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Hook for managing environment-specific parquet materialization.
 * Handles queuing builds, polling status, and updating local state.
 *
 * Usage:
 * ```
 * const { status, materializing, buildArtifact, canBuild } =
 *   useEnvironmentMaterialization({
 *     workspaceId, appId, bindingId,
 *     environment: previewEnvironment
 *   });
 *
 * if (!canBuild) return <button onClick={buildArtifact}>Build</button>;
 * ```
 */
export function useEnvironmentMaterialization({
  workspaceId,
  appId,
  bindingId,
  environment,
  timeoutMs,
  signal,
}: UseEnvironmentMaterializationOptions) {
  const [materializing, setMaterializing] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const store = useAppStore.getState();

  const app = store.openApps[appId];
  const binding = app?.dataBindings.find(b => b.id === bindingId);

  // Current artifact status for this environment (or prod if no environment specified)
  const artifactStatus = environment
    ? binding?.cache?.environments?.[environment]
    : { status: binding?.cache?.parquetBuildStatus };

  const status = artifactStatus?.status ?? "missing";

  // Whether we should show a "Build now?" prompt
  const canBuild = ["missing", "error"].includes(status);
  const shouldAutoPrompt = canBuild && !materializing;

  const buildArtifact = useCallback(
    async (force = false) => {
      if (!environment || materializing) return;

      setMaterializing(true);
      setBuildError(null);

      try {
        const result = await store.materializeBinding(
          workspaceId,
          appId,
          bindingId,
          {
            force,
            environment,
            timeoutMs,
            signal,
            refreshPreview: false, // Don't refresh until user explicitly switches envs
          },
        );

        if (!result.success) {
          setBuildError(result.error || "Build failed");
        }
      } catch (error) {
        setBuildError(error instanceof Error ? error.message : "Build failed");
      } finally {
        setMaterializing(false);
      }
    },
    [workspaceId, appId, bindingId, environment, timeoutMs, signal, materializing],
  );

  // Auto-prompt for dev/staging artifacts on first load
  useEffect(() => {
    if (shouldAutoPrompt && environment) {
      // Only auto-build if the binding is configured for parquet materialization
      if (binding?.materialization === "parquet") {
        // Don't auto-build automatically; let the UI prompt the user
        // This would be called explicitly via the UI component
      }
    }
  }, [shouldAutoPrompt, environment, binding?.materialization]);

  return {
    status,
    materializing,
    buildError,
    canBuild,
    shouldAutoPrompt,
    buildArtifact,
  };
}
