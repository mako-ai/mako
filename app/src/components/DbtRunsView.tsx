/**
 * DbtRunsView — project-wide run history with live logs.
 *
 * Unlike DbtJobView (scoped to one job), this lists every run for the project,
 * including ad-hoc runs triggered by the agent (`dbt_run_model`) and the editor
 * "Run model" button — runs that have no jobId and therefore never appear in
 * any job's history. Backed by `GET /runs` (no jobId filter). Self-polls the
 * list while any run is active so newly-triggered agent runs show up live.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import { RefreshCw as RefreshIcon } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useDbtStore } from "../store/dbtStore";
import DbtRunHistory from "./DbtRunHistory";
import EntityBreadcrumbs from "./EntityBreadcrumbs";

const LIST_POLL_INTERVAL_MS = 3_000;

export default function DbtRunsView({
  tabId,
  projectId,
  focusRunId,
}: {
  tabId: string;
  projectId: string;
  focusRunId?: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const runs = useDbtStore(s => s.runsByProject[projectId]);
  const jobs = useDbtStore(s => s.jobsByProject[projectId]);
  const fetchRuns = useDbtStore(s => s.fetchRuns);
  const fetchJobs = useDbtStore(s => s.fetchJobs);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    focusRunId ?? null,
  );

  // Follow tab-metadata focus changes (e.g. chat card re-opening this tab).
  useEffect(() => {
    if (focusRunId) setSelectedRunId(focusRunId);
  }, [focusRunId]);

  const projectRuns = useMemo(() => runs ?? [], [runs]);

  const jobNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const job of jobs ?? []) map[job._id] = job.name;
    return map;
  }, [jobs]);

  const hasActive = projectRuns.some(
    run => run.status === "running" || run.status === "queued",
  );

  // Initial load: jobs (for labels) + all runs.
  useEffect(() => {
    if (!workspaceId) return;
    if (!jobs) void fetchJobs(workspaceId, projectId);
    void fetchRuns(workspaceId, projectId);
  }, [workspaceId, projectId, jobs, fetchJobs, fetchRuns]);

  // Poll the run list while anything is active so agent-triggered runs appear
  // and statuses stay fresh without manual refresh.
  const hasActiveRef = useRef(hasActive);
  hasActiveRef.current = hasActive;
  useEffect(() => {
    if (!workspaceId || !hasActive) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      await fetchRuns(workspaceId, projectId);
      if (stopped || !hasActiveRef.current) return;
      timer = setTimeout(() => void poll(), LIST_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), LIST_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, projectId, hasActive, fetchRuns]);

  // Default selection: newest run.
  useEffect(() => {
    if (!selectedRunId && projectRuns.length > 0) {
      setSelectedRunId(projectRuns[0]._id);
    }
  }, [selectedRunId, projectRuns]);

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <EntityBreadcrumbs
        tabId={tabId}
        trailing={
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
            <Typography variant="caption" color="text.secondary">
              {projectRuns.length} recent · agent, manual &amp; scheduled
            </Typography>
            <Tooltip title="Refresh">
              <IconButton
                size="small"
                onClick={() => {
                  if (workspaceId) void fetchRuns(workspaceId, projectId);
                }}
              >
                <RefreshIcon size={16} />
              </IconButton>
            </Tooltip>
          </Box>
        }
      />
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <DbtRunHistory
          workspaceId={workspaceId}
          projectId={projectId}
          runs={projectRuns}
          selectedRunId={selectedRunId}
          onSelectRun={setSelectedRunId}
          showSource
          jobNameById={jobNameById}
          emptyHint="No runs yet. Build a model from chat or the editor, or run a job."
        />
      </Box>
    </Box>
  );
}
