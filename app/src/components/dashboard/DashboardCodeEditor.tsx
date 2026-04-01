import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Typography } from "@mui/material";
import Editor from "@monaco-editor/react";
import { useDashboardStore } from "../../store/dashboardStore";
import {
  serializeDashboardDefinition,
  type Dashboard,
} from "../../dashboard-runtime/types";

const { applyDefinition: applyDefinitionAction } = useDashboardStore.getState();

function formatZodErrors(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .slice(0, 5)
    .map(issue => `${issue.path.join(".")}: ${issue.message}`)
    .join(" | ");
}

interface DashboardCodeEditorProps {
  dashboard: Dashboard;
  dashboardId?: string;
  effectiveMode: "light" | "dark";
  onCodeError?: (hasError: boolean) => void;
}

const DashboardCodeEditor: React.FC<DashboardCodeEditorProps> = ({
  dashboard,
  dashboardId,
  effectiveMode,
  onCodeError,
}) => {
  const [codeValue, setCodeValue] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const isEditorFocusedRef = useRef(false);
  const dashboardRef = useRef(dashboard);
  dashboardRef.current = dashboard;

  useEffect(() => {
    onCodeError?.(codeError !== null);
  }, [codeError, onCodeError]);

  useEffect(() => {
    if (!dashboard || isEditorFocusedRef.current) return;
    const serialized = JSON.stringify(
      serializeDashboardDefinition(dashboard),
      null,
      2,
    );
    setCodeValue(serialized);
    setCodeError(null);
  }, [dashboard]);

  const handleBlur = useCallback(() => {
    isEditorFocusedRef.current = false;
    const current = dashboardRef.current;
    if (current) {
      const serialized = JSON.stringify(
        serializeDashboardDefinition(current),
        null,
        2,
      );
      setCodeValue(serialized);
      setCodeError(null);
    }
  }, []);

  const handleFocus = useCallback(() => {
    isEditorFocusedRef.current = true;
  }, []);

  const handleCodeChange = useCallback(
    (val: string | undefined) => {
      const newVal = val || "";
      setCodeValue(newVal);

      if (!dashboardId) return;

      try {
        const parsed = JSON.parse(newVal);
        const zodError = applyDefinitionAction(dashboardId, parsed);
        if (zodError) {
          setCodeError(formatZodErrors(zodError));
        } else {
          setCodeError(null);
        }
      } catch (e: any) {
        setCodeError(e?.message || "Invalid JSON");
      }
    },
    [dashboardId],
  );

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Box
        sx={{
          px: 1.5,
          py: 0.5,
          display: "flex",
          alignItems: "center",
          gap: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
          backgroundColor: "background.paper",
        }}
      >
        <Typography variant="caption" color="text.secondary">
          Dashboard Definition (JSON)
        </Typography>
        <Box sx={{ flex: 1 }} />
        {codeError && (
          <Typography variant="caption" color="error">
            {codeError}
          </Typography>
        )}
      </Box>
      <Box sx={{ flex: 1 }}>
        <Editor
          height="100%"
          language="json"
          value={codeValue}
          onChange={handleCodeChange}
          theme={effectiveMode === "dark" ? "vs-dark" : "light"}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
            wordWrap: "on",
            formatOnPaste: true,
            tabSize: 2,
          }}
          onMount={editor => {
            editor.onDidFocusEditorWidget(handleFocus);
            editor.onDidBlurEditorWidget(handleBlur);
          }}
        />
      </Box>
    </Box>
  );
};

export default DashboardCodeEditor;
