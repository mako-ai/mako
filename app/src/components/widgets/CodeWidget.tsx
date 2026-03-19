import React, { useState, useEffect, useCallback } from "react";
import { Box, CircularProgress, Typography } from "@mui/material";
import { queryDuckDB } from "../../lib/duckdb";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

interface CodeWidgetProps {
  db: AsyncDuckDB;
  localSql: string;
  code: string;
  onError?: (error: string) => void;
}

const CodeWidget: React.FC<CodeWidgetProps> = ({
  db,
  localSql,
  code,
  onError,
}) => {
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await queryDuckDB(db, localSql);
      setData(result.rows);
    } catch (e: unknown) {
      onError?.(e instanceof Error ? e.message : "Query failed");
    } finally {
      setLoading(false);
    }
  }, [db, localSql, onError]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (loading || !iframeRef.current) return;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { margin: 0; padding: 8px; font-family: system-ui, sans-serif; }
          * { box-sizing: border-box; }
        </style>
      </head>
      <body>
        <div id="root"></div>
        <script type="module">
          const data = ${JSON.stringify(data)};
          try {
            ${code}
            if (typeof render === 'function') {
              const result = render(data);
              if (typeof result === 'string') {
                document.getElementById('root').innerHTML = result;
              }
            }
          } catch (e) {
            document.getElementById('root').innerHTML =
              '<pre style="color: red;">' + e.message + '</pre>';
            window.parent.postMessage({ type: 'code-widget-error', error: e.message }, '*');
          }
        </script>
      </body>
      </html>
    `;

    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    iframeRef.current.src = url;

    return () => URL.revokeObjectURL(url);
  }, [data, code, loading]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "code-widget-error") {
        setRenderError(e.data.error);
        onError?.(e.data.error);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onError]);

  if (loading) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
        }}
      >
        <CircularProgress size={24} />
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", width: "100%", position: "relative" }}>
      {renderError && (
        <Typography
          variant="caption"
          color="error"
          sx={{
            position: "absolute",
            bottom: 4,
            left: 4,
            zIndex: 1,
            backgroundColor: "background.paper",
            px: 0.5,
            borderRadius: 0.5,
          }}
        >
          {renderError}
        </Typography>
      )}
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts"
        style={{
          width: "100%",
          height: "100%",
          border: "none",
        }}
        title="Code Widget"
      />
    </Box>
  );
};

export default CodeWidget;
