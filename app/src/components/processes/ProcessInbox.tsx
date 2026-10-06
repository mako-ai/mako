/**
 * The approval inbox: every pending approval and task across all processes
 * in the workspace, plus recently decided ones for context.
 */
import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useWorkspace } from "../../contexts/workspace-context";
import { useProcessStore, type HumanRequest } from "../../store/processStore";
import { focusProcessRunTab } from "../../process-runtime/shell";
import VSScrollArea from "../VSScrollArea";
import { HumanRequestCard } from "./common";

const EMPTY: HumanRequest[] = [];

export default function ProcessInbox() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const requests = useProcessStore(s =>
    workspaceId ? (s.inbox[workspaceId] ?? EMPTY) : EMPTY,
  );
  const fetchInbox = useProcessStore(s => s.fetchInbox);
  const respond = useProcessStore(s => s.respond);
  const error = useProcessStore(s => s.error);
  const clearError = useProcessStore(s => s.clearError);
  const [filter, setFilter] = useState<"pending" | "all">("pending");

  useEffect(() => {
    if (!workspaceId) return;
    void fetchInbox(workspaceId);
    const timer = setInterval(() => void fetchInbox(workspaceId), 10_000);
    return () => clearInterval(timer);
  }, [workspaceId, fetchInbox]);

  const visible =
    filter === "pending"
      ? requests.filter(r => r.status === "pending")
      : requests;

  return (
    <VSScrollArea>
      <Box sx={{ p: 3, maxWidth: 900 }}>
        <Stack direction="row" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h5" sx={{ fontWeight: 600, flex: 1 }}>
            Inbox
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={filter}
            onChange={(_, v) => v && setFilter(v)}
          >
            <ToggleButton value="pending">Pending</ToggleButton>
            <ToggleButton value="all">All</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
        {error && (
          <Alert severity="error" onClose={clearError} sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {visible.length === 0 && (
          <Typography color="text.secondary">
            {filter === "pending"
              ? "Nothing is waiting for a person right now."
              : "No approvals or tasks yet."}
          </Typography>
        )}
        <Stack spacing={2}>
          {visible.map(request => (
            <HumanRequestCard
              key={request.id}
              request={request}
              onOpenRun={() =>
                focusProcessRunTab(
                  request.processId,
                  request.runId,
                  `${request.processName} #${request.runNumber}`,
                )
              }
              onRespond={response =>
                workspaceId
                  ? respond(workspaceId, request.id, response)
                  : Promise.resolve(false)
              }
            />
          ))}
        </Stack>
      </Box>
    </VSScrollArea>
  );
}
