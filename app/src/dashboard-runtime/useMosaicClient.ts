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

const EMPTY_ROWS: Record<string, unknown>[] = [];
const EMPTY_FIELDS: Array<{ name: string; type: string }> = [];

interface UseMosaicClientConfig {
  dashboardId: string;
  widgetId: string;
  dataSourceId?: string;
  localSql: string;
  initialRows?: Record<string, unknown>[];
  initialFields?: Array<{ name: string; type: string }>;
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
  initialRows = EMPTY_ROWS,
  initialFields = EMPTY_FIELDS,
  mosaicInstance,
  crossFilterEnabled = true,
  crossFilterResolution = "intersect",
  queryGeneration = 0,
  refreshGeneration = 0,
  onError,
}: UseMosaicClientConfig) {
  const [rows, setRows] = useState<Record<string, unknown>[]>(initialRows);
  const [fields, setFields] =
    useState<Array<{ name: string; type: string }>>(initialFields);
  const hasSql = Boolean(localSql.trim());
  const [loading, setLoading] = useState(hasSql && initialRows.length === 0);
  const clientRef = useRef<any>(null);
  const sourceRef = useRef({ widgetId });
  const sqlRef = useRef(localSql);
  const selectionRef = useRef<any>(null);
  const lastClauseRef = useRef<any>(null);
  const lastSelectionSignatureRef = useRef<string | null>(null);
  const dataGenerationRef = useRef(0);
  const selectionDataGenerationRef = useRef(0);
  const [currentSelection, setCurrentSelection] = useState<Omit<
    MosaicSelectionInput,
    "additive"
  > | null>(null);

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
    if (initialRows.length > 0 || initialFields.length > 0) {
      setRows(initialRows);
      setFields(initialFields);
      setLoading(false);
    }
  }, [initialFields, initialRows]);

  useEffect(() => {
    sourceRef.current = { widgetId };
  }, [widgetId]);

  useEffect(() => {
    let cancelled = false;

    clearSelection();
    selectionRef.current = null;

    if (!mosaicInstance || !hasSql) {
      if (initialRows.length === 0) {
        setRows([]);
        setFields(initialFields);
      }
      setLoading(false);
      if (initialRows.length === 0) {
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
      }
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
            dataGenerationRef.current++;
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
      mosaicInstance?.unregisterClause(widgetId);
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
    initialFields,
    initialRows,
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
        setCurrentSelection(null);
        if (clientRef.current && mosaicInstance) {
          void mosaicInstance.coordinator.requestQuery?.(clientRef.current);
        }
        return;
      }

      const signature = selection ? JSON.stringify(selection) : null;
      if (!selection || selection.values.length === 0) {
        clearSelection();
        setCurrentSelection(null);
        if (mosaicInstance) {
          mosaicInstance.unregisterClause(widgetId);
          if (clientRef.current) {
            void mosaicInstance.coordinator.requestQuery?.(clientRef.current);
          }
        }
        return;
      }

      if (dataGenerationRef.current !== selectionDataGenerationRef.current) {
        lastSelectionSignatureRef.current = null;
        selectionDataGenerationRef.current = dataGenerationRef.current;
      }

      if (
        signature &&
        signature === lastSelectionSignatureRef.current &&
        lastClauseRef.current
      ) {
        clearSelection();
        setCurrentSelection(null);
        if (mosaicInstance) {
          mosaicInstance.unregisterClause(widgetId);
          if (clientRef.current) {
            void mosaicInstance.coordinator.requestQuery?.(clientRef.current);
          }
        }
        return;
      }

      if (!selection.additive && mosaicInstance && selectionRef.current) {
        mosaicInstance.clearOtherClauses(widgetId, selectionRef.current);
      }

      const clause = mosaicInstance?.createSelectionClause(selection, {
        source: sourceRef.current,
        client: clientRef.current,
      });

      if (!clause) {
        clearSelection();
        setCurrentSelection(null);
        if (mosaicInstance) {
          mosaicInstance.unregisterClause(widgetId);
          if (clientRef.current) {
            void mosaicInstance.coordinator.requestQuery?.(clientRef.current);
          }
        }
        return;
      }

      selectionRef.current.activate?.(clause);
      selectionRef.current.update?.(clause);
      lastClauseRef.current = clause;
      lastSelectionSignatureRef.current = signature;
      setCurrentSelection({
        field: selection.field,
        values: selection.values,
        type: selection.type,
      });
      mosaicInstance?.registerClause(
        widgetId,
        clause,
        selectionRef.current,
        () => {
          lastClauseRef.current = null;
          lastSelectionSignatureRef.current = null;
          setCurrentSelection(null);
        },
      );
    },
    [clearSelection, crossFilterEnabled, mosaicInstance, widgetId],
  );

  return {
    rows,
    fields,
    loading,
    client: clientRef.current,
    updateSelection,
    currentSelection,
  };
}
