/**
 * What one commit did to a notebook's file — opened from the notebook History
 * popover, the same way an app commit opens its file diffs. A commit is
 * immutable, so this reads once from the repo.
 */
import { useEffect, useState } from "react";
import { useWorkspace } from "../contexts/workspace-context";
import { useNotebookHistoryStore } from "../store/notebookHistoryStore";
import type { AppCommitFileVersions } from "../store/appsStore";
import { GitFileDiffView } from "./GitFileDiffView";

export default function NotebookDiffTab({
  notebookId,
  path,
  sha,
}: {
  notebookId: string;
  path: string;
  sha: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const fetchCommitFileVersions = useNotebookHistoryStore(
    s => s.fetchCommitFileVersions,
  );
  const [versions, setVersions] = useState<AppCommitFileVersions | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    void fetchCommitFileVersions(workspaceId, notebookId, sha, path).then(v => {
      if (cancelled) return;
      setVersions(v);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, notebookId, sha, path, fetchCommitFileVersions]);

  return (
    <GitFileDiffView
      path={path}
      label={`${sha.slice(0, 7)}^ → ${sha.slice(0, 7)}`}
      original={versions?.before}
      modified={versions?.after}
      binary={versions?.binary}
      loading={loading && !versions}
    />
  );
}
