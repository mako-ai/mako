import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useContainerWidth } from "react-grid-layout";
import { useDashboardStore } from "../store/dashboardStore";
import { useDashboardRuntimeStore } from "../dashboard-runtime/store";
import {
  activateDashboardSession,
  getDashboardMosaicInstance,
} from "../dashboard-runtime/commands";
import { useWorkspace } from "../contexts/workspace-context";
import { computeDashboardStateHash } from "../utils/stateHash";
import type { MosaicInstance } from "../lib/mosaic";
import type {
  Dashboard,
  DashboardSessionRuntimeState,
} from "../dashboard-runtime/types";

const {
  openDashboard: openDashboardAction,
  createDashboard: createDashboardAction,
} = useDashboardStore.getState();

interface UseDashboardSessionOptions {
  dashboardId?: string;
  isNew?: boolean;
  onCreated?: (dashboardId: string) => void;
}

interface UseDashboardSessionResult {
  dashboard: Dashboard | undefined;
  runtimeSession: DashboardSessionRuntimeState | null;
  mosaicInstance: MosaicInstance | null;
  allSourcesReady: boolean;
  isRuntimeInitializing: boolean;
  isDashboardLoaded: boolean;
  gridContainerRef: React.RefObject<HTMLDivElement | null>;
  gridWidth: number;
  workspaceId: string | undefined;
}

export function useDashboardSession({
  dashboardId,
  isNew,
  onCreated,
}: UseDashboardSessionOptions): UseDashboardSessionResult {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const { dashboard } = useDashboardStore(
    useShallow(state => ({
      dashboard: dashboardId ? state.openDashboards[dashboardId] : undefined,
    })),
  );

  const runtimeSession = useDashboardRuntimeStore(state =>
    dashboardId ? state.sessions[dashboardId] || null : null,
  );

  const [mosaicInstance, setMosaicInstance] = useState<MosaicInstance | null>(
    null,
  );

  const {
    width: gridWidth,
    containerRef: gridContainerRef,
    measureWidth,
  } = useContainerWidth({ measureBeforeMount: true });

  // Open or create dashboard on mount
  useEffect(() => {
    if (!workspaceId) return;

    if (isNew && !dashboardId) {
      (async () => {
        const created = await createDashboardAction(workspaceId, {
          title: "Untitled Dashboard",
          dataSources: [],
          widgets: [],
          relationships: [],
          globalFilters: [],
          crossFilter: {
            enabled: true,
            resolution: "intersect",
            engine: "mosaic",
          },
          materializationSchedule: {
            enabled: true,
            cron: "0 0 * * *",
            timezone: "UTC",
          },
          layout: { columns: 12, rowHeight: 80 },
          cache: {},
          access: "private",
        } as any);
        if (created) {
          useDashboardStore.setState(state => {
            state.openDashboards[created._id] = created;
            state.activeDashboardId = created._id;
            state.historyMap[created._id] = { stack: [], index: -1 };
            state.savedStateHashes[created._id] =
              computeDashboardStateHash(created);
          });
          onCreated?.(created._id);
        }
      })();
      return;
    }

    if (dashboardId) {
      openDashboardAction(workspaceId, dashboardId);
    }
  }, [workspaceId, dashboardId, isNew, onCreated]);

  // Activate runtime session once dashboard is loaded
  const isDashboardLoaded = !!dashboard;
  useEffect(() => {
    if (!isDashboardLoaded || !workspaceId || !dashboardId) return;
    void activateDashboardSession(workspaceId, dashboardId, "viewer");
  }, [isDashboardLoaded, workspaceId, dashboardId]);

  // Re-measure grid container width after the dashboard loads
  useEffect(() => {
    if (isDashboardLoaded) {
      measureWidth();
    }
  }, [isDashboardLoaded, measureWidth]);

  // Derived readiness flags
  const allSourcesReady = useMemo(() => {
    if (!dashboard) return false;
    if (dashboard.dataSources.length === 0) return true;
    return dashboard.dataSources.every(
      ds => runtimeSession?.dataSources[ds.id]?.status === "ready",
    );
  }, [dashboard, runtimeSession]);

  const isRuntimeInitializing = useMemo(() => {
    if (!dashboard) return false;
    return dashboard.dataSources.length > 0 && !runtimeSession;
  }, [dashboard, runtimeSession]);

  // Resolve mosaic instance when all data sources are ready
  useEffect(() => {
    if (!dashboard || !dashboardId || !allSourcesReady) {
      setMosaicInstance(null);
      return;
    }

    let cancelled = false;
    void getDashboardMosaicInstance(dashboardId)
      .then(instance => {
        if (!cancelled) setMosaicInstance(instance);
      })
      .catch(() => {
        if (!cancelled) setMosaicInstance(null);
      });

    return () => {
      cancelled = true;
    };
  }, [dashboard, dashboardId, allSourcesReady]);

  return {
    dashboard,
    runtimeSession,
    mosaicInstance,
    allSourcesReady,
    isRuntimeInitializing,
    isDashboardLoaded,
    gridContainerRef,
    gridWidth,
    workspaceId,
  };
}
