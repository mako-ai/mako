/**
 * One file's git diff, wherever it is shown — the apps Source Control diff
 * tab and the console history diff tab render this same view: the path, a
 * chip saying which two sides are compared, an optional action, and a Monaco
 * diff that opens on its first change (VS Code semantics).
 */
import { Box, Chip, CircularProgress, Typography } from "@mui/material";
import { DiffEditor } from "@monaco-editor/react";
import { EDITOR_OPTIONS, useMonacoTheme } from "../lib/monaco-presets";
import { languageForPath } from "../app-runtime/monaco-jsx";

export function GitFileDiffView({
  path,
  label,
  original,
  modified,
  binary,
  loading,
  action,
}: {
  path: string;
  /** e.g. `abc1234^ → abc1234`, `HEAD → Index`. */
  label: string;
  original: string | null | undefined;
  modified: string | null | undefined;
  binary?: boolean;
  loading?: boolean;
  action?: React.ReactNode;
}) {
  const monacoTheme = useMonacoTheme();
  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.5,
          py: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <Typography
          variant="body2"
          sx={{
            fontFamily: "monospace",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {path}
        </Typography>
        <Chip
          size="small"
          label={label}
          sx={{ height: 18, fontSize: "0.65rem" }}
        />
        <Box sx={{ flex: 1 }} />
        {action}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {loading ? (
          <Box sx={{ p: 3, display: "flex", justifyContent: "center" }}>
            <CircularProgress size={20} />
          </Box>
        ) : binary ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            Binary file — no text diff.
          </Typography>
        ) : (
          <DiffEditor
            height="100%"
            // VS Code opens a diff on its first change, not on line 1.
            onMount={editor => {
              const disposable = editor.onDidUpdateDiff(() => {
                const first = editor.getLineChanges()?.[0];
                if (first) {
                  editor
                    .getModifiedEditor()
                    .revealLineInCenter(first.modifiedStartLineNumber);
                }
                disposable.dispose();
              });
            }}
            language={languageForPath(path)}
            theme={monacoTheme}
            original={original ?? ""}
            modified={modified ?? ""}
            options={{ ...EDITOR_OPTIONS.diff, renderOverviewRuler: false }}
          />
        )}
      </Box>
    </Box>
  );
}
