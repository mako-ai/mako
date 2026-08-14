import { useCallback, useState } from "react";
import { useAppStore } from "../store/appStore";

interface UseEnvironmentMaterializationOptions {
  workspaceId: string;
  appId: string;
  bindingId: string;
  /**
   * dbt environment to build for. Omit (or pass undefined) while the preview
   * is on the prod-like environment — there is nothing per-environment to
   * build then, and `buildArtifact` becomes a no-op.
   */
  environment?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Drives the per-environment parquet build for one binding: current status,
 * whether a build is worth offering, and the action to start one.
 *
 * ```tsx
 * const { status, materializing, canBuild, buildArtifact } =
 *   useEnvironmentMaterialization({ workspaceId, appId, bindingId, environment });
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

  // Subscribe so status changes during a build re-render the caller. The
  // poller writes `bindingBuildStatusByEnv`; a refetched app carries the
  // persisted artifact — prefer the former while a build is in flight.
  const polled = useAppStore(state =>
    environment
      ? state.bindingBuildStatusByEnv[appId]?.[bindingId]?.[environment]
      : undefined,
  );
  const artifact = useAppStore(state =>
    environment
      ? state.openApps[appId]?.dataBindings.find(b => b.id === bindingId)?.cache
          ?.environments?.[environment]
      : undefined,
  );

  const status = polled?.status ?? artifact?.status ?? "missing";
  const canBuild =
    !!environment && (status === "missing" || status === "error");

  const buildArtifact = useCallback(
    async (force = false) => {
      if (!environment || materializing) return;

      setMaterializing(true);
      setBuildError(null);
      try {
        const result = await useAppStore
          .getState()
          .materializeBinding(workspaceId, appId, bindingId, {
            force,
            environment,
            timeoutMs,
            signal,
            // The preview only swaps to this artifact when the editor is
            // actually pinned to this environment, so don't force a data
            // reload from here.
            refreshPreview: false,
          });
        if (!result.success) setBuildError(result.error || "Build failed");
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Build failed";
        setBuildError(message);
      } finally {
        setMaterializing(false);
      }
    },
    [
      workspaceId,
      appId,
      bindingId,
      environment,
      timeoutMs,
      signal,
      materializing,
    ],
  );

  return {
    status,
    materializing,
    buildError: buildError ?? polled?.error ?? artifact?.error ?? null,
    canBuild,
    buildArtifact,
  };
}
