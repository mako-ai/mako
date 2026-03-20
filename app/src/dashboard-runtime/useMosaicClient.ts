import { useCallback, useEffect, useRef, useState } from "react";
import type { MosaicInstance } from "../lib/mosaic";

export interface UseMosaicClientOptions {
  widgetId: string;
  localSql: string;
  mosaicInstance: MosaicInstance | null | undefined;
  crossFilterEnabled?: boolean;
}

export interface UseMosaicClientResult {
  rows: Record<string, unknown>[];
  fields: Array<{ name: string; type: string }>;
  loading: boolean;
}

function arrowResultToRows(resultData: any): {
  rows: Record<string, unknown>[];
  fields: Array<{ name: string; type: string }>;
} {
  const rows: Record<string, unknown>[] = [];
  const fields: Array<{ name: string; type: string }> = [];
  if (!resultData || !resultData.numRows) return { rows, fields };

  const schema = resultData.schema?.fields || [];
  for (const f of schema) {
    fields.push({ name: f.name, type: String(f.type ?? "Utf8") });
  }
  for (let i = 0; i < resultData.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const f of schema) {
      const col = resultData.getChild(f.name);
      row[f.name] = col?.get(i);
    }
    rows.push(row);
  }
  return { rows, fields };
}

/**
 * Hook that connects a dashboard widget to a Mosaic coordinator as a client.
 * Handles mount/unmount lifecycle, SQL updates, and Arrow-to-row conversion.
 */
export function useMosaicClient(
  options: UseMosaicClientOptions,
): UseMosaicClientResult {
  const {
    widgetId,
    localSql,
    mosaicInstance,
    crossFilterEnabled = true,
  } = options;
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [fields, setFields] = useState<Array<{ name: string; type: string }>>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const clientRef = useRef<any>(null);
  const sqlRef = useRef(localSql);
  sqlRef.current = localSql;

  const onData = useCallback((resultData: any) => {
    const converted = arrowResultToRows(resultData);
    setRows(converted.rows);
    if (converted.fields.length > 0) {
      setFields(converted.fields);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!mosaicInstance || !crossFilterEnabled) {
      setLoading(false);
      return;
    }

    const { coordinator, selection } = mosaicInstance;

    const client = {
      _id: widgetId,
      filterBy: selection,

      query(filter?: any): { sql: string } {
        let sql = sqlRef.current;
        if (filter) {
          const clause =
            typeof filter === "string" ? filter : filter.toString?.() || "";
          if (clause) {
            if (sql.toLowerCase().includes("where")) {
              sql += ` AND (${clause})`;
            } else {
              sql += ` WHERE ${clause}`;
            }
          }
        }
        return { sql };
      },

      queryResult(resultData: any): void {
        if (!resultData) return;
        onData(resultData);
      },

      update(): void {
        coordinator.requestQuery?.(client);
      },
    };

    try {
      coordinator.connect?.(client);
      clientRef.current = client;
    } catch {
      setLoading(false);
    }

    return () => {
      try {
        coordinator.disconnect?.(clientRef.current);
      } catch {
        // silent cleanup
      }
      clientRef.current = null;
    };
  }, [mosaicInstance, crossFilterEnabled, widgetId, onData]);

  useEffect(() => {
    if (clientRef.current && mosaicInstance) {
      mosaicInstance.coordinator.requestQuery?.(clientRef.current);
    }
  }, [localSql, mosaicInstance]);

  return { rows, fields, loading };
}
