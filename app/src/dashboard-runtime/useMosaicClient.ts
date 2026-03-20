import { useEffect, useRef, useState } from "react";
import { createMosaicClient, type MosaicInstance } from "../lib/mosaic";

export interface UseMosaicClientOptions {
  widgetId: string;
  localSql: string;
  dataSourceId?: string;
  mosaicInstance: MosaicInstance | null | undefined;
  crossFilterEnabled?: boolean;
  crossFilterResolution?: "intersect" | "union";
}

export interface UseMosaicClientResult {
  rows: Record<string, unknown>[];
  fields: Array<{ name: string; type: string }>;
  loading: boolean;
  pending: boolean;
  error: string | null;
}

/**
 * Hook that connects a dashboard widget to a Mosaic coordinator as a client.
 * Handles mount/unmount lifecycle, SQL updates, and Arrow-to-row conversion.
 * Uses per-data-source keyed selections when `dataSourceId` is provided.
 */
export function useMosaicClient(
  options: UseMosaicClientOptions,
): UseMosaicClientResult {
  const {
    widgetId,
    localSql,
    dataSourceId,
    mosaicInstance,
    crossFilterEnabled = true,
    crossFilterResolution = "intersect",
  } = options;
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [fields, setFields] = useState<Array<{ name: string; type: string }>>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<any>(null);
  const sqlRef = useRef(localSql);
  sqlRef.current = localSql;

  useEffect(() => {
    if (!mosaicInstance || !crossFilterEnabled) {
      setLoading(false);
      return;
    }

    const { coordinator } = mosaicInstance;

    const selection = dataSourceId
      ? mosaicInstance.getSelection(dataSourceId, crossFilterResolution)
      : mosaicInstance.selection;

    const client = createMosaicClient({
      widgetId,
      tableName: "",
      sql: sqlRef.current,
      coordinator,
      selection,
      onData: result => {
        setRows(result.rows);
        if (result.fields.length > 0) {
          setFields(result.fields);
        }
        setLoading(false);
        setPending(false);
        setError(null);
      },
      onPending: () => {
        setPending(true);
      },
      onError: msg => {
        setError(msg);
        setLoading(false);
        setPending(false);
      },
    });

    clientRef.current = client;

    return () => {
      try {
        coordinator.disconnect?.(clientRef.current);
      } catch {
        // silent cleanup
      }
      clientRef.current = null;
    };
  }, [
    mosaicInstance,
    crossFilterEnabled,
    crossFilterResolution,
    dataSourceId,
    widgetId,
  ]);

  useEffect(() => {
    if (clientRef.current?.updateSql) {
      clientRef.current.updateSql(localSql);
    }
  }, [localSql]);

  return { rows, fields, loading, pending, error };
}
