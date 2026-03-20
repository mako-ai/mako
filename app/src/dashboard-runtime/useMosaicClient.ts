import { useCallback, useEffect, useRef, useState } from "react";
import {
  createMosaicClient,
  type DashboardCrossFilterResolution,
  type MosaicInstance,
  type MosaicQueryResult,
  type MosaicSelectionInput,
} from "../lib/mosaic";

interface UseMosaicClientConfig {
  widgetId: string;
  dataSourceId?: string;
  localSql: string;
  mosaicInstance?: MosaicInstance | null;
  crossFilterEnabled?: boolean;
  crossFilterResolution?: DashboardCrossFilterResolution;
  onError?: (error: string) => void;
}

export function useMosaicClient({
  widgetId,
  dataSourceId,
  localSql,
  mosaicInstance,
  crossFilterEnabled = true,
  crossFilterResolution = "intersect",
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
      return;
    }

    selectionRef.current = crossFilterEnabled
      ? dataSourceId
        ? mosaicInstance.getSelection(dataSourceId, crossFilterResolution)
        : mosaicInstance.selection
      : null;
    setLoading(true);

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
          },
          onPending: () => {
            if (!cancelled) {
              setLoading(true);
            }
          },
          onError: error => {
            if (!cancelled) {
              setLoading(false);
              onError?.(error.message || "Mosaic query failed");
            }
          },
        });

        if (cancelled) {
          mosaicInstance.coordinator.disconnect?.(nextClient);
          return;
        }

        clientRef.current = nextClient;
      } catch (error) {
        if (!cancelled) {
          setLoading(false);
          onError?.(
            error instanceof Error ? error.message : "Failed to connect Mosaic",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      const currentClient = clientRef.current;
      clientRef.current = null;
      if (currentClient) {
        try {
          mosaicInstance.coordinator.disconnect?.(currentClient);
        } catch {
          // Best-effort cleanup when widgets unmount or switch engines.
        }
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
    widgetId,
  ]);

  useEffect(() => {
    if (!clientRef.current || !mosaicInstance || !hasSql) {
      return;
    }

    setLoading(true);
    void mosaicInstance.coordinator.requestQuery?.(clientRef.current);
  }, [hasSql, localSql, mosaicInstance]);

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
