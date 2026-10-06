/**
 * One run: the business timeline (one row per primitive call), each row
 * expandable into input/output, logs, tool calls, artifacts and — for agent
 * steps — the agent's own trace. A second view shows the raw journal as a
 * chronological event log. Polls while the run is live.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Collapse,
  Dialog,
  DialogContent,
  DialogTitle,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { ChevronDown, ChevronRight, FileText, PauseCircle } from "lucide-react";
import { useWorkspace } from "../../contexts/workspace-context";
import { useConsoleStore } from "../../store/consoleStore";
import {
  TERMINAL_RUN_STATUSES,
  useProcessStore,
  type AgentTurnView,
  type JournalEvent,
  type StepToolCall,
  type StepView,
} from "../../store/processStore";
import { BUI_MONO_FONT_FAMILY } from "../chat/bui-styles";
import VSScrollArea from "../VSScrollArea";
import StreamingMarkdown from "../StreamingMarkdown";
import {
  EffectChip,
  HumanRequestCard,
  JsonBlock,
  KindChip,
  RunStatusPill,
  SectionLabel,
  StepBadge,
} from "./common";
import {
  formatDuration,
  formatTime,
  waitingLabel,
} from "../../process-runtime/format";

function ToolCallRow({ call }: { call: StepToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ borderBottom: 1, borderColor: "divider", py: 0.5 }}>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{ cursor: "pointer" }}
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <EffectChip effect={call.effect} />
        <Typography
          sx={{ fontFamily: BUI_MONO_FONT_FAMILY, fontSize: 12.5, flex: 1 }}
        >
          {call.tool}
          {call.iteration !== undefined && (
            <Typography
              component="span"
              variant="caption"
              color="text.secondary"
            >
              {" "}
              · iteration {call.iteration + 1}
            </Typography>
          )}
        </Typography>
        <Typography
          variant="caption"
          color={call.status === "failed" ? "error" : "text.secondary"}
        >
          {call.status === "failed"
            ? "failed"
            : formatDuration(call.durationMs)}
          {call.reconciled ? " · reconciled" : ""}
        </Typography>
      </Stack>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ pl: 3, pt: 0.5 }}>
          <SectionLabel>Input</SectionLabel>
          <JsonBlock value={call.input} />
          {call.error ? (
            <>
              <SectionLabel>Error</SectionLabel>
              <Alert severity="error">{call.error}</Alert>
            </>
          ) : (
            <>
              <SectionLabel>Output</SectionLabel>
              <JsonBlock value={call.output} />
            </>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

function AgentTrace({ turns }: { turns: AgentTurnView[] }) {
  return (
    <Stack spacing={1}>
      {turns.map(turn => (
        <Box
          key={`${turn.iteration}-${turn.ts}`}
          sx={{ borderLeft: 2, borderColor: "divider", pl: 1.5 }}
        >
          <Typography variant="caption" color="text.secondary">
            Iteration {turn.iteration + 1} · {turn.model} ·{" "}
            {formatTime(turn.ts)}
            {turn.usage
              ? ` · ${turn.usage.inputTokens.toLocaleString()} in / ${turn.usage.outputTokens.toLocaleString()} out`
              : ""}
          </Typography>
          {turn.reasoning && (
            <Typography
              variant="body2"
              sx={{
                fontStyle: "italic",
                color: "text.secondary",
                whiteSpace: "pre-wrap",
              }}
            >
              {turn.reasoning}
            </Typography>
          )}
          {turn.text && (
            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
              {turn.text}
            </Typography>
          )}
          {turn.toolCalls.map(call => (
            <Box key={call.callId} sx={{ mt: 0.5 }}>
              <Typography
                sx={{ fontFamily: BUI_MONO_FONT_FAMILY, fontSize: 12 }}
              >
                → {call.tool.replace(/__/g, ".")}
              </Typography>
              <JsonBlock value={call.input} maxHeight={160} />
              {call.error ? (
                <Alert severity="warning" sx={{ mt: 0.5 }}>
                  {call.error}
                </Alert>
              ) : (
                call.output !== undefined && (
                  <JsonBlock value={call.output} maxHeight={160} />
                )
              )}
            </Box>
          ))}
        </Box>
      ))}
    </Stack>
  );
}

function StepRow({
  step,
  onOpenArtifact,
  last,
}: {
  step: StepView;
  onOpenArtifact: (id: string) => void;
  last: boolean;
}) {
  const [open, setOpen] = useState(step.status === "failed");
  const toolsUsed = [...new Set(step.tools.map(t => t.tool))];
  const usage = step.agent?.usage;
  return (
    <Box sx={{ display: "flex", gap: 1.5 }}>
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          pt: 1,
        }}
      >
        <StepBadge status={step.status} />
        {!last && (
          <Box sx={{ flex: 1, width: 2, bgcolor: "divider", mt: 0.5 }} />
        )}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, pb: 1.5 }}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ cursor: "pointer", py: 0.75 }}
          onClick={() => setOpen(o => !o)}
        >
          <Typography variant="body1" sx={{ fontWeight: 500 }}>
            {step.name}
          </Typography>
          <KindChip kind={step.kind} />
          {step.attempts > 1 && (
            <Typography variant="caption" color="warning.main">
              {step.attempts} attempts
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {toolsUsed.length > 0 && (
            <Typography variant="caption" color="text.secondary">
              {step.tools.length} tool call{step.tools.length === 1 ? "" : "s"}
            </Typography>
          )}
          {step.agent?.model && (
            <Typography variant="caption" color="text.secondary">
              {step.agent.model}
            </Typography>
          )}
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ minWidth: 56, textAlign: "right" }}
          >
            {step.status === "waiting"
              ? "waiting"
              : formatDuration(step.durationMs)}
          </Typography>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {formatTime(step.startedAt)}
          {step.endedAt ? ` → ${formatTime(step.endedAt)}` : ""}
          {toolsUsed.length > 0 ? ` · ${toolsUsed.join(", ")}` : ""}
          {usage
            ? ` · ${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens`
            : ""}
          {usage?.costUsd ? ` · $${usage.costUsd.toFixed(4)}` : ""}
          {step.wait?.until && step.status === "waiting"
            ? ` · until ${formatTime(step.wait.until)}`
            : ""}
        </Typography>

        <Collapse in={open} unmountOnExit>
          <Box sx={{ pt: 1 }}>
            {step.error && (
              <Alert severity="error" sx={{ mb: 1 }}>
                {step.error}
              </Alert>
            )}
            {step.agent && (
              <>
                {step.agent.instructions && (
                  <>
                    <SectionLabel>Instructions</SectionLabel>
                    <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                      {step.agent.instructions}
                    </Typography>
                  </>
                )}
                {step.agent.prompt !== undefined && (
                  <>
                    <SectionLabel>Input</SectionLabel>
                    <JsonBlock value={step.agent.prompt} maxHeight={200} />
                  </>
                )}
                <SectionLabel>
                  Trace · {step.agent.turns.length} turn
                  {step.agent.turns.length === 1 ? "" : "s"}
                  {step.agent.harness ? ` · ${step.agent.harness}` : ""}
                </SectionLabel>
                <AgentTrace turns={step.agent.turns} />
              </>
            )}
            {step.tools.length > 0 && (
              <>
                <SectionLabel>Tool calls (audited)</SectionLabel>
                {step.tools.map((call, i) => (
                  <ToolCallRow key={`${call.callKey}-${i}`} call={call} />
                ))}
              </>
            )}
            {step.logs.length > 0 && (
              <>
                <SectionLabel>Logs</SectionLabel>
                {step.logs.map((log, i) => (
                  <Typography
                    key={i}
                    sx={{ fontFamily: BUI_MONO_FONT_FAMILY, fontSize: 12 }}
                  >
                    {formatTime(log.ts)} {log.tool ? `[${log.tool}] ` : ""}
                    {log.message}
                    {log.data !== undefined
                      ? ` ${JSON.stringify(log.data)}`
                      : ""}
                  </Typography>
                ))}
              </>
            )}
            {step.artifacts.length > 0 && (
              <>
                <SectionLabel>Artifacts</SectionLabel>
                <Stack direction="row" spacing={1}>
                  {step.artifacts.map(a => (
                    <Button
                      key={a.id}
                      size="small"
                      variant="outlined"
                      startIcon={<FileText size={14} />}
                      onClick={() => onOpenArtifact(a.id)}
                    >
                      {a.name}
                    </Button>
                  ))}
                </Stack>
              </>
            )}
            {step.output !== undefined && (
              <>
                <SectionLabel>Output</SectionLabel>
                <JsonBlock value={step.output} />
              </>
            )}
          </Box>
        </Collapse>
      </Box>
    </Box>
  );
}

/** One human-readable line per journal event. */
function describeEvent(e: JournalEvent): string | null {
  const d = e.data;
  switch (e.type) {
    case "run.created":
      return `Trigger received (${(d.trigger as { type?: string })?.type ?? "manual"})`;
    case "run.started":
      return `Run started (attempt ${Number(d.attempt ?? 0) + 1}, ${d.engine})`;
    case "run.retried":
      return "Run retried from the failed step";
    case "run.version_changed":
      return `Resumed on new code: v${d.fromVersion} → v${d.toVersion}`;
    case "run.completed":
      return "Run completed";
    case "run.failed":
      return `Run failed: ${d.error}`;
    case "run.cancelled":
      return "Run cancelled";
    case "step.started":
      return `${d.name} started${Number(d.attempt) > 0 ? ` (attempt ${Number(d.attempt) + 1})` : ""}`;
    case "step.completed":
      return `${d.name} completed`;
    case "step.failed":
      return `${d.name} failed: ${d.error}${d.willRetry ? " — retrying" : ""}`;
    case "agent.turn":
      return `  agent turn ${Number(d.iteration) + 1} (${d.model})`;
    case "tool.started":
      return `  ${d.caller === "agent" ? "agent" : "step"} called ${d.tool} [${d.effect}]`;
    case "tool.failed":
      return `  ${d.tool} failed: ${d.error}`;
    case "human.requested":
      return `Waiting for ${d.kind === "task" ? "input" : "approval"}: ${d.title}  — PAUSED`;
    case "human.responded":
      return `${String(d.status).replace(/^\w/, c => c.toUpperCase())} by ${(d.by as { email?: string })?.email ?? "someone"}${d.edited ? " (edited)" : ""}`;
    case "human.expired":
      return `${d.title} expired`;
    case "wait.started":
      return d.event
        ? `Waiting for event ${d.event}  — PAUSED`
        : `Sleeping until ${formatTime(String(d.until))}  — PAUSED`;
    case "wait.matched":
      return `Event ${d.event} received`;
    case "wait.completed":
      return d.timedOut ? "Wait timed out" : "Resumed";
    case "artifact.created":
      return `Artifact ${d.name} created`;
    case "log":
      return `  ${d.message}`;
    default:
      return null;
  }
}

export default function ProcessRunView({
  tabId,
  runId,
}: {
  tabId: string;
  processId: string;
  runId: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const detail = useProcessStore(s => s.runDetails[runId]);
  const fetchRun = useProcessStore(s => s.fetchRun);
  const cancelRun = useProcessStore(s => s.cancelRun);
  const retryRun = useProcessStore(s => s.retryRun);
  const respond = useProcessStore(s => s.respond);
  const fetchArtifact = useProcessStore(s => s.fetchArtifact);
  const error = useProcessStore(s => s.error);
  const clearError = useProcessStore(s => s.clearError);
  const [view, setView] = useState<"steps" | "log">("steps");
  const [artifact, setArtifact] = useState<{
    name: string;
    mimeType: string;
    content: string;
  } | null>(null);

  const status = detail?.run.status;
  const live = status ? !TERMINAL_RUN_STATUSES.includes(status) : true;

  useEffect(() => {
    if (!workspaceId) return;
    void fetchRun(workspaceId, runId);
    const timer = setInterval(
      () => void fetchRun(workspaceId, runId),
      live ? 2_000 : 30_000,
    );
    return () => clearInterval(timer);
  }, [workspaceId, runId, fetchRun, live]);

  useEffect(() => {
    if (!detail) return;
    const store = useConsoleStore.getState();
    store.updateTitle(tabId, `${detail.processName} #${detail.run.number}`);
    const tab = store.tabs[tabId];
    if (tab && tab.metadata?.processName !== detail.processName) {
      store.updateMetadata(tabId, {
        ...tab.metadata,
        processName: detail.processName,
      });
    }
  }, [tabId, detail]);

  const pendingRequests = useMemo(
    () => (detail?.humanRequests ?? []).filter(r => r.status === "pending"),
    [detail?.humanRequests],
  );

  if (!detail || !workspaceId) {
    return (
      <Box sx={{ p: 3 }}>
        {error ? (
          <Alert severity="error">{error}</Alert>
        ) : (
          <Typography color="text.secondary">Loading…</Typography>
        )}
      </Box>
    );
  }

  const { run, version } = detail;
  const duration = run.startedAt
    ? new Date(run.endedAt ?? Date.now()).getTime() -
      new Date(run.startedAt).getTime()
    : undefined;
  const stale = live && version.current && version.current.id !== version.id;

  const openArtifact = async (eventId: string) => {
    const result = await fetchArtifact(workspaceId, run.id, eventId);
    if (result) setArtifact(result);
  };

  return (
    <VSScrollArea>
      <Box sx={{ p: 3, maxWidth: 1100 }}>
        {error && (
          <Alert severity="error" onClose={clearError} sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            {detail.processName} · Run #{run.number}
          </Typography>
          <RunStatusPill status={run.status} waitingOn={run.waitingOn} />
          <Box sx={{ flex: 1 }} />
          {live && (
            <Button
              color="error"
              onClick={() => void cancelRun(workspaceId, run.id)}
            >
              Cancel run
            </Button>
          )}
          {run.status === "failed" && (
            <Button
              variant="contained"
              onClick={() => void retryRun(workspaceId, run.id)}
            >
              Retry from failed step
            </Button>
          )}
        </Stack>
        <Typography
          variant="caption"
          color="text.secondary"
          component="div"
          sx={{ mt: 0.5 }}
        >
          Trigger: {run.trigger.type}
          {run.trigger.event ? ` (${run.trigger.event})` : ""} · started{" "}
          {formatTime(run.startedAt ?? run.createdAt)} ·{" "}
          {formatDuration(duration)} · v{run.versionNumber}
          {run.attempt > 0 ? ` · retried ${run.attempt}×` : ""} ·{" "}
          {run.usage.modelCalls} model calls · {run.usage.toolCalls} tool calls
          · {(run.usage.inputTokens + run.usage.outputTokens).toLocaleString()}{" "}
          tokens
          {run.usage.costUsd ? ` · $${run.usage.costUsd.toFixed(4)}` : ""}
        </Typography>
        {stale && (
          <Alert severity="info" sx={{ mt: 1 }}>
            This run started on v{version.number}; the deployed code is now v
            {version.current?.number}. It will resume on the new code —
            completed steps are not re-run, and every step records the version
            that executed it.
          </Alert>
        )}
        {run.status === "failed" && run.error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {run.error.message}
          </Alert>
        )}

        {pendingRequests.map(request => (
          <Box key={request.id} sx={{ mt: 2 }}>
            <HumanRequestCard
              request={request}
              onRespond={async response => {
                const ok = await respond(workspaceId, request.id, response);
                if (ok) void fetchRun(workspaceId, run.id);
                return ok;
              }}
            />
          </Box>
        ))}

        <Stack direction="row" alignItems="center" sx={{ mt: 3, mb: 1 }}>
          <Typography variant="subtitle2" sx={{ flex: 1 }}>
            Timeline
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={view}
            onChange={(_, v) => v && setView(v)}
          >
            <ToggleButton value="steps">Steps</ToggleButton>
            <ToggleButton value="log">Event log</ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        {view === "steps" ? (
          <Box>
            {detail.steps.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                {run.status === "queued" ? "Queued…" : "No steps yet."}
              </Typography>
            )}
            {detail.steps.map((step, i) => (
              <Box key={step.key}>
                <StepRow
                  step={step}
                  last={
                    i === detail.steps.length - 1 && run.status !== "waiting"
                  }
                  onOpenArtifact={id => void openArtifact(id)}
                />
                {step.status === "waiting" && run.status === "waiting" && (
                  <Stack
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    sx={{ pl: 4, py: 1, color: "warning.main" }}
                  >
                    <PauseCircle size={16} />
                    <Typography
                      variant="body2"
                      sx={{ fontWeight: 600, letterSpacing: 1 }}
                    >
                      PAUSED — {waitingLabel(run.waitingOn)}. Nothing is
                      running.
                    </Typography>
                  </Stack>
                )}
              </Box>
            ))}
          </Box>
        ) : (
          <Box sx={{ fontFamily: BUI_MONO_FONT_FAMILY, fontSize: 12.5 }}>
            {detail.events.map(e => {
              const line = describeEvent(e);
              if (!line) return null;
              return (
                <Box key={e.id} sx={{ display: "flex", gap: 2, py: 0.25 }}>
                  <Box sx={{ color: "text.secondary", minWidth: 80 }}>
                    {formatTime(e.ts)}
                  </Box>
                  <Box
                    sx={{
                      whiteSpace: "pre",
                      color: line.includes("PAUSED")
                        ? "warning.main"
                        : e.type.endsWith("failed")
                          ? "error.main"
                          : "text.primary",
                    }}
                  >
                    {line}
                  </Box>
                </Box>
              );
            })}
          </Box>
        )}

        <SectionLabel>Input</SectionLabel>
        <JsonBlock value={run.input} />
        {run.output !== null && run.output !== undefined && (
          <>
            <SectionLabel>Output</SectionLabel>
            <JsonBlock value={run.output} />
          </>
        )}
      </Box>

      <Dialog
        open={Boolean(artifact)}
        onClose={() => setArtifact(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{artifact?.name}</DialogTitle>
        <DialogContent>
          {artifact?.mimeType === "text/markdown" ? (
            <StreamingMarkdown>{artifact.content}</StreamingMarkdown>
          ) : (
            <JsonBlock value={artifact?.content ?? ""} maxHeight={600} />
          )}
        </DialogContent>
      </Dialog>
    </VSScrollArea>
  );
}
