import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Box,
  Alert,
  Button,
  IconButton,
  Tooltip,
  CircularProgress,
} from "@mui/material";
import { RotateCw as RefreshIcon } from "lucide-react";
import { useConsoleStore } from "../store/consoleStore";
import { useSchemaStore } from "../store/schemaStore";
import { useWorkspace } from "../contexts/workspace-context";
import ResultsTable from "./ResultsTable";
import TableStructureView from "./TableStructureView";
import EntityBreadcrumbs from "./EntityBreadcrumbs";

const PAGE_SIZE = 100;

/** Connection types that support the table Structure (DDL) view. */
const STRUCTURE_SUPPORTED_TYPES = new Set(["postgresql", "cloudsql-postgres"]);

/** Quote a Postgres identifier. */
function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

interface TableDataResult {
  results: Array<Record<string, unknown>>;
  executedAt: string;
  resultCount: number;
  executionTime?: number;
  fields?: Array<{ name?: string; originalName?: string } | string>;
  pageInfo?: {
    pageSize: number;
    hasMore: boolean;
    nextCursor: string | null;
    returnedRows: number;
    capApplied: boolean;
  } | null;
  currentPage?: number;
}

interface TableDataViewProps {
  tabId: string;
}

/**
 * Full-screen, paginated browser for a table's rows. Opened from the database
 * explorer by clicking a table name; fetches the first 100 rows immediately
 * and pages with Previous / Next.
 */
function TableDataView({ tabId }: TableDataViewProps) {
  const tab = useConsoleStore(s => s.tabs[tabId]);
  const executeQuery = useConsoleStore(s => s.executeQuery);
  const { currentWorkspace } = useWorkspace();

  const [result, setResult] = useState<TableDataResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cursor stack: cursorHistory[i] is the cursor used to fetch page i+1.
  const cursorHistoryRef = useRef<Array<string | null>>([null]);
  const abortRef = useRef<AbortController | null>(null);

  const schema = (tab?.metadata?.schema as string) || "public";
  const table = tab?.metadata?.table as string | undefined;
  const connectionId = tab?.connectionId;
  const databaseName = tab?.databaseName;
  const databaseId = tab?.databaseId;

  const connections = useSchemaStore(s => s.connections);
  const connection = useMemo(() => {
    const list = currentWorkspace ? connections[currentWorkspace.id] || [] : [];
    return list.find(c => c.id === connectionId);
  }, [connections, currentWorkspace, connectionId]);

  const fetchPage = useCallback(
    async (cursor: string | null, page: number) => {
      if (!currentWorkspace || !connectionId || !table) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);
      const startTime = Date.now();
      const query = `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)}`;

      const res = await executeQuery(currentWorkspace.id, connectionId, query, {
        databaseId,
        databaseName,
        pageSize: PAGE_SIZE,
        cursor,
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;
      setLoading(false);

      if (!res.success) {
        if (res.error !== "Query cancelled") {
          setError(res.error || "Failed to load table data");
        }
        return;
      }

      const rows = ("rows" in res ? res.rows : []) || [];
      const fields = "fields" in res ? res.fields : undefined;
      const pageInfo = ("pageInfo" in res ? res.pageInfo : null) || null;
      setResult({
        results: rows as Array<Record<string, unknown>>,
        executedAt: new Date().toISOString(),
        resultCount: Array.isArray(rows) ? rows.length : 0,
        executionTime: Date.now() - startTime,
        fields,
        pageInfo,
        currentPage: page,
      });
    },
    [
      currentWorkspace,
      connectionId,
      table,
      schema,
      databaseId,
      databaseName,
      executeQuery,
    ],
  );

  // Initial load (and reload when the target table changes)
  useEffect(() => {
    cursorHistoryRef.current = [null];
    fetchPage(null, 1);
    return () => abortRef.current?.abort();
  }, [fetchPage]);

  const handleNextPage = useCallback(() => {
    const nextCursor = result?.pageInfo?.nextCursor;
    if (!nextCursor) return;
    cursorHistoryRef.current = [...cursorHistoryRef.current, nextCursor];
    fetchPage(nextCursor, (result?.currentPage ?? 1) + 1);
  }, [result, fetchPage]);

  const handlePreviousPage = useCallback(() => {
    const page = result?.currentPage ?? 1;
    if (page <= 1) return;
    const history = cursorHistoryRef.current.slice(0, -1);
    cursorHistoryRef.current = history.length > 0 ? history : [null];
    const prevCursor =
      cursorHistoryRef.current[cursorHistoryRef.current.length - 1] ?? null;
    fetchPage(prevCursor, page - 1);
  }, [result, fetchPage]);

  const handleRefresh = useCallback(() => {
    const cursor =
      cursorHistoryRef.current[cursorHistoryRef.current.length - 1] ?? null;
    fetchPage(cursor, result?.currentPage ?? 1);
  }, [fetchPage, result]);

  if (!tab || !table || !connectionId) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error">Table information is missing.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <EntityBreadcrumbs
        tabId={tabId}
        trailing={
          <Tooltip title="Refresh">
            <span>
              <IconButton
                size="small"
                onClick={handleRefresh}
                disabled={loading}
              >
                <RefreshIcon size={16} strokeWidth={1.75} />
              </IconButton>
            </span>
          </Tooltip>
        }
      />

      {error ? (
        <Box sx={{ p: 2 }}>
          <Alert
            severity="error"
            action={
              <Button
                color="inherit"
                size="small"
                onClick={() => fetchPage(null, 1)}
              >
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        </Box>
      ) : !result && loading ? (
        <Box
          sx={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CircularProgress size={28} />
        </Box>
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, opacity: loading ? 0.6 : 1 }}>
          <ResultsTable
            results={result}
            onNextPage={handleNextPage}
            onPreviousPage={handlePreviousPage}
            structureView={
              STRUCTURE_SUPPORTED_TYPES.has(connection?.type || "") ? (
                <TableStructureView
                  connectionId={connectionId}
                  schema={schema}
                  table={table}
                  databaseName={databaseName}
                />
              ) : undefined
            }
          />
        </Box>
      )}
    </Box>
  );
}

export default React.memo(TableDataView);
