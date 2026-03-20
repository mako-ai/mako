import { useCallback, useEffect, useRef, useState } from "react";
import {
  createMosaicClient,
  type DashboardCrossFilterResolution,
  type MosaicInstance,
  type MosaicQueryResult,
  type MosaicSelectionInput,
} from "../lib/mosaic";
import { dashboardRuntimeEvents } from "./events";
import { classifyDuckDBError } from "./error-kinds";
import { useDashboardRuntimeStore } from "./store";

interface UseMosaicClientConfig {
  dashboardId: string;
  widgetId: string;
  dataSourceId?: string;
  localSql: string;
  mosaicInstance?: MosaicInstance | null;
  crossFilterEnabled?: boolean;
  crossFilterResolution?: DashboardCrossFilterResolution;
  queryGeneration?: number;
  refreshGeneration?: number;
  onError?: (error: string) => void;
}

function destroyMosaicClient(
  mosaicInstance: MosaicInstance,
  client: any,
): void {
  if (!client) return;

  try {
    if (typeof client.destroy === "function") {
      client.destroy();
      return;
    }
  } catch {
    // Fall through to coordinator disconnect as a best-effort fallback.
  }

  try {
    mosaicInstance.coordinator.disconnect?.(client);
  } catch {
    // Best-effort cleanup when widget teardown races with coordinator updates.
  }
}

export function useMosaicClient({
  dashboardId,
  widgetId,
  dataSourceId,
  localSql,
  mosaicInstance,
  crossFilterEnabled = true,
  crossFilterResolution = "intersect",
  queryGeneration = 0,
  refreshGeneration = 0,
  onError,
}: UseMosaicClientConfig) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [fields, setFields] = useState<Array<{ name: string; type: string }>>(
    [],
  );
  const hasSql = Boolean(localSql.trim());
  const [loading, setLoading] = useState(hasSql);
  const clientRef = useRef<any>(null);
  const sourceRef = useRef({ widgetId });
  const sqlRef = useRef(localSql);
  const selectionRef = useRef<any>(null);
  const lastClauseRef = useRef<any>(null);
  const lastSelectionSignatureRef = useRef<string | null>(null);

  const clearSelection = useCallback(() => {
    if (selectionRef.current && lastClauseRef.current) {
      selectionRef.current.reset?.([lastClauseRef.current]);
    }
    lastClauseRef.current = null;
    lastSelectionSignatureRef.current = null;
  }, []);

  useEffect(() => {
    sqlRef.current = localSql;
  }, [localSql]);

  useEffect(() => {
    sourceRef.current = { widgetId };
  }, [widgetId]);

  useEffect(() => {
    let cancelled = false;

    clearSelection();
    selectionRef.current = null;

    if (!mosaicInstance || !hasSql) {
      setRows([]);
      setFields([]);
      setLoading(false);
      useDashboardRuntimeStore
        .getState()
        .dispatch(
          dashboardRuntimeEvents.widgetQueryFailed(
            dashboardId,
            widgetId,
            "Mosaic runtime is not available",
            "crossfilter_invalid",
          ),
        );
      return;
    }

    selectionRef.current = crossFilterEnabled
      ? dataSourceId
        ? mosaicInstance.getSelection(dataSourceId, crossFilterResolution)
        : mosaicInstance.selection
      : null;
    setLoading(true);
    useDashboardRuntimeStore
      .getState()
      .dispatch(
        dashboardRuntimeEvents.widgetQueryStarted(dashboardId, widgetId),
      );

    void (async () => {
      try {
        const nextClient = await createMosaicClient({
          widgetId,
          coordinator: mosaicInstance.coordinator,
          selection: selectionRef.current,
          getSql: () => sqlRef.current,
          onData: (result: MosaicQueryResult) => {
            if (cancelled) {
              return;
            }
            setRows(result.rows);
            setFields(result.fields);
            setLoading(false);
            useDashboardRuntimeStore.getState().dispatch(
              dashboardRuntimeEvents.widgetQuerySucceeded(
                dashboardId,
                widgetId,
                result.rows.length,
                result.fields.map(field => field.name),
              ),
            );
          },
          onPending: () => {
            if (!cancelled) {
              setLoading(true);
            }
          },
          onError: error => {
            if (!cancelled) {
              setLoading(false);
              useDashboardRuntimeStore
                .getState()
                .dispatch(
                  dashboardRuntimeEvents.widgetQueryFailed(
                    dashboardId,
                    widgetId,
                    error.message || "Mosaic query failed",
                    classifyDuckDBError(error.message || "Mosaic query failed"),
                  ),
                );
              onError?.(error.message || "Mosaic query failed");
            }
          },
        });

        if (cancelled) {
          destroyMosaicClient(mosaicInstance, nextClient);
          return;
        }

        clientRef.current = nextClient;
      } catch (error) {
        if (!cancelled) {
          setLoading(false);
          const message =
            error instanceof Error ? error.message : "Failed to connect Mosaic";
          useDashboardRuntimeStore
            .getState()
            .dispatch(
              dashboardRuntimeEvents.widgetQueryFailed(
                dashboardId,
                widgetId,
                message,
                "crossfilter_invalid",
              ),
            );
          onError?.(message);
        }
      }
    })();

    return () => {
      cancelled = true;
      const currentClient = clientRef.current;
      clientRef.current = null;
      if (currentClient) {
        destroyMosaicClient(mosaicInstance, currentClient);
      }
      clearSelection();
    };
  }, [
    clearSelection,
    crossFilterEnabled,
    crossFilterResolution,
    dataSourceId,
    hasSql,
    mosaicInstance,
    onError,
    dashboardId,
    widgetId,
  ]);

  useEffect(() => {
    if (!clientRef.current || !mosaicInstance || !hasSql) {
      return;
    }

    setLoading(true);
    void mosaicInstance.coordinator.requestQuery?.(clientRef.current);
  }, [
    dashboardId,
    hasSql,
    localSql,
    mosaicInstance,
    queryGeneration,
    refreshGeneration,
    widgetId,
  ]);

  const updateSelection = useCallback(
    (selection: MosaicSelectionInput | null) => {
      if (!crossFilterEnabled || !selectionRef.current) {
        clearSelection();
        return;
      }

      const signature = selection ? JSON.stringify(selection) : null;
      if (!selection || selection.values.length === 0) {
        clearSelection();
        return;
      }

      if (
        signature &&
        signature === lastSelectionSignatureRef.current &&
        lastClauseRef.current
      ) {
        clearSelection();
        return;
      }

      const clause = mosaicInstance?.createSelectionClause(selection, {
        source: sourceRef.current,
        client: clientRef.current,
      });

      if (!clause) {
        clearSelection();
        return;
      }

      selectionRef.current.activate?.(clause);
      selectionRef.current.update?.(clause);
      lastClauseRef.current = clause;
      lastSelectionSignatureRef.current = signature;
    },
    [clearSelection, crossFilterEnabled, mosaicInstance],
  );

  return {
    rows,
    fields,
    loading,
    client: clientRef.current,
    updateSelection,
  };
}
