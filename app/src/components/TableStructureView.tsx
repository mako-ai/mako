import React, { useCallback, useEffect, useState } from "react";
import { Box, Alert, Button, CircularProgress } from "@mui/material";
import Editor from "@monaco-editor/react";
import { EDITOR_OPTIONS, useMonacoTheme } from "../lib/monaco-presets";
import { useSchemaStore } from "../store/schemaStore";
import { useWorkspace } from "../contexts/workspace-context";

interface TableStructureViewProps {
  connectionId: string;
  schema: string;
  table: string;
  databaseName?: string;
}

/**
 * Read-only SQL view of a table's full definition (CREATE TABLE, comments,
 * indexes, triggers), TablePlus-style. Rendered as the "Structure" view mode
 * of the table data tab. Postgres-family connections only.
 */
function TableStructureView({
  connectionId,
  schema,
  table,
  databaseName,
}: TableStructureViewProps) {
  const fetchTableDefinition = useSchemaStore(s => s.fetchTableDefinition);
  const { currentWorkspace } = useWorkspace();
  const monacoTheme = useMonacoTheme();

  const [definition, setDefinition] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentWorkspace) return;
    setLoading(true);
    setError(null);
    const res = await fetchTableDefinition(currentWorkspace.id, connectionId, {
      schema,
      table,
      database: databaseName,
    });
    setLoading(false);
    if (res.definition) {
      setDefinition(res.definition);
    } else {
      setDefinition(null);
      setError(res.error || "Failed to fetch table definition");
    }
  }, [
    currentWorkspace,
    connectionId,
    schema,
    table,
    databaseName,
    fetchTableDefinition,
  ]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={load}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      </Box>
    );
  }

  if (loading || definition === null) {
    return (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <CircularProgress size={28} />
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", width: "100%", overflow: "hidden" }}>
      <Editor
        height="100%"
        defaultLanguage="sql"
        value={definition}
        theme={monacoTheme}
        options={{ ...EDITOR_OPTIONS.readOnly, fontSize: 14 }}
      />
    </Box>
  );
}

export default React.memo(TableStructureView);
