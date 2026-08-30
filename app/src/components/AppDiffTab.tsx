/**
 * A git diff of one file, opened from the Source Control view — VS Code's
 * "Open Changes". Working Tree mode diffs index → working copy (what you
 * would stage); Index mode diffs HEAD → index (what you would commit).
 * Re-reads when the box reports the file's state changed.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Typography,
  useTheme,
} from "@mui/material";
import { DiffEditor } from "@monaco-editor/react";
import { SquareArrowOutUpRight as OpenIcon } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppsStore, type AppFileVersions } from "../store/appsStore";
import { focusAppsFileTab } from "../apps-runtime/shell";
import { languageForPath } from "../app-runtime/monaco-jsx";

export default function AppDiffTab({
  appId,
  path,
  mode,
}: {
  appId: string;
  path: string;
  mode: "working" | "index";
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const fetchFileVersions = useAppsStore(s => s.fetchFileVersions);
  const apps = useAppsStore(s => s.apps);
  // The row for this path in the pushed status: any change to it (staged,
  // discarded, edited in a shell) is the cue to re-read the versions.
  const stamp = useAppsStore(s => {
    const change = s.statusByApp[appId]?.repoChanges.find(c => c.path === path);
    return change
      ? `${change.status}:${change.staged}:${change.unstaged}`
      : "clean";
  });
  const monacoTheme = useTheme().palette.mode === "dark" ? "vs-dark" : "vs";

  const [versions, setVersions] = useState<AppFileVersions | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    void fetchFileVersions(workspaceId, appId, path).then(v => {
      if (cancelled) return;
      setVersions(v);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, appId, path, mode, stamp, fetchFileVersions]);

  const original =
    mode === "index" ? versions?.head : (versions?.index ?? versions?.head);
  const modified = mode === "index" ? versions?.index : versions?.working;

  // "Open File": only when the path lives inside an app this window knows,
  // since file tabs are addressed app-relatively.
  const owner = useMemo(() => {
    for (const app of apps) {
      if (app.slug && path.startsWith(`apps/${app.slug}/`)) {
        return { app, rel: path.slice(`apps/${app.slug}/`.length) };
      }
    }
    return null;
  }, [apps, path]);

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
          label={mode === "index" ? "HEAD → Index" : "Index → Working Tree"}
          sx={{ height: 18, fontSize: "0.65rem" }}
        />
        <Box sx={{ flex: 1 }} />
        {owner && (
          <Button
            size="small"
            startIcon={<OpenIcon size={14} />}
            onClick={() =>
              focusAppsFileTab(owner.app.id, owner.rel, owner.app.slug)
            }
          >
            Open file
          </Button>
        )}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {loading && !versions ? (
          <Box sx={{ p: 3, display: "flex", justifyContent: "center" }}>
            <CircularProgress size={20} />
          </Box>
        ) : versions?.binary ? (
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
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              renderOverviewRuler: false,
            }}
          />
        )}
      </Box>
    </Box>
  );
}
