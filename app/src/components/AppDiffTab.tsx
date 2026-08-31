/**
 * A git diff of one file, opened from the Source Control view — VS Code's
 * "Open Changes". Working Tree mode diffs index → working copy (what you
 * would stage); Index mode diffs HEAD → index (what you would commit).
 * Re-reads when the box reports the file's state changed.
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@mui/material";
import { SquareArrowOutUpRight as OpenIcon } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAppsStore, type AppFileVersions } from "../store/appsStore";
import { focusAppsFileTab } from "../apps-runtime/shell";
import { GitFileDiffView } from "./GitFileDiffView";

export default function AppDiffTab({
  appId,
  path,
  mode,
  sha,
}: {
  appId: string;
  path: string;
  /** "commit": what `sha` did to this file (parent → sha), from the repo. */
  mode: "working" | "index" | "commit";
  sha?: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const fetchFileVersions = useAppsStore(s => s.fetchFileVersions);
  const fetchCommitFileVersions = useAppsStore(s => s.fetchCommitFileVersions);
  const apps = useAppsStore(s => s.apps);
  // The row for this path in the pushed status: any change to it (staged,
  // discarded, edited in a shell) is the cue to re-read the versions.
  const stamp = useAppsStore(s => {
    const change = s.statusByApp[appId]?.repoChanges.find(c => c.path === path);
    return change
      ? `${change.status}:${change.staged}:${change.unstaged}`
      : "clean";
  });

  const [versions, setVersions] = useState<AppFileVersions | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    const load =
      mode === "commit" && sha
        ? // A commit is immutable: fold its two sides into the same shape
          // the box versions use, so the rest of this view is unchanged.
          fetchCommitFileVersions(workspaceId, appId, sha, path).then(v =>
            v
              ? {
                  head: v.before,
                  index: v.after,
                  working: v.after,
                  binary: v.binary,
                }
              : null,
          )
        : fetchFileVersions(workspaceId, appId, path);
    void load.then(v => {
      if (cancelled) return;
      setVersions(v);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [
    workspaceId,
    appId,
    path,
    mode,
    sha,
    stamp,
    fetchFileVersions,
    fetchCommitFileVersions,
  ]);

  const original =
    mode === "working" ? (versions?.index ?? versions?.head) : versions?.head;
  const modified = mode === "working" ? versions?.working : versions?.index;

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
    <GitFileDiffView
      path={path}
      label={
        mode === "commit"
          ? `${(sha ?? "").slice(0, 7)}^ → ${(sha ?? "").slice(0, 7)}`
          : mode === "index"
            ? "HEAD → Index"
            : "Index → Working Tree"
      }
      original={original}
      modified={modified}
      binary={versions?.binary}
      loading={loading && !versions}
      action={
        owner ? (
          <Button
            size="small"
            startIcon={<OpenIcon size={14} />}
            onClick={() =>
              focusAppsFileTab(owner.app.id, owner.rel, owner.app.slug)
            }
          >
            Open file
          </Button>
        ) : undefined
      }
    />
  );
}
