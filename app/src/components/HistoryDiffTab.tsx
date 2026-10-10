/**
 * What one commit did to one of an entity's files — opened from its History
 * popover, the same way an app commit opens its file diffs. A commit is
 * immutable, so this reads once from the repo.
 */
import { useEffect, useState } from "react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useEntityHistoryStore,
  type HistoryEntityKind,
} from "../store/entityHistoryStore";
import type { AppCommitFileVersions } from "../store/appsStore";
import { GitFileDiffView } from "./GitFileDiffView";

export default function HistoryDiffTab({
  entity,
  id,
  path,
  sha,
}: {
  entity: HistoryEntityKind;
  id: string;
  path: string;
  sha: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const fetchCommitFileVersions = useEntityHistoryStore(
    s => s.fetchCommitFileVersions,
  );
  const [versions, setVersions] = useState<AppCommitFileVersions | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    void fetchCommitFileVersions(entity, workspaceId, id, sha, path).then(v => {
      if (cancelled) return;
      setVersions(v);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [entity, workspaceId, id, sha, path, fetchCommitFileVersions]);

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
