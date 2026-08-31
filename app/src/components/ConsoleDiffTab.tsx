/**
 * What one commit did to a console's file — opened from the console History
 * popover, the same way an app commit opens its file diffs. A commit is
 * immutable, so this reads once from the repo.
 */
import { useEffect, useState } from "react";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleHistoryStore } from "../store/consoleHistoryStore";
import type { AppCommitFileVersions } from "../store/appsStore";
import { GitFileDiffView } from "./GitFileDiffView";

export default function ConsoleDiffTab({
  consoleId,
  path,
  sha,
}: {
  consoleId: string;
  path: string;
  sha: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const fetchCommitFileVersions = useConsoleHistoryStore(
    s => s.fetchCommitFileVersions,
  );
  const [versions, setVersions] = useState<AppCommitFileVersions | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    void fetchCommitFileVersions(workspaceId, consoleId, sha, path).then(v => {
      if (cancelled) return;
      setVersions(v);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, consoleId, sha, path, fetchCommitFileVersions]);

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
