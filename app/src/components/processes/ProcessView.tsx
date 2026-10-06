/**
 * One process: what it is (description, triggers, tool envelope with effect
 * classes), the readable flow derived from its code, a run form, and its runs.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { ArrowDown, Play, Zap } from "lucide-react";
import { useWorkspace } from "../../contexts/workspace-context";
import { useConsoleStore } from "../../store/consoleStore";
import {
  TERMINAL_RUN_STATUSES,
  useProcessStore,
  type JsonSchema,
  type OutlineItem,
  type ProcessRunSummary,
  type TriggerSpec,
} from "../../store/processStore";
import { focusProcessRunTab } from "../../process-runtime/shell";
import { BUI_MONO_FONT_FAMILY } from "../chat/bui-styles";
import VSScrollArea from "../VSScrollArea";
import { EffectChip, KindChip, RunStatusPill, SectionLabel } from "./common";
import {
  formatDuration,
  formatTime,
  triggerLabel,
} from "../../process-runtime/format";

const EMPTY_RUNS: ProcessRunSummary[] = [];

/** A starting point for the run form, from the input JSON schema. */
function sampleInput(schema: unknown): Record<string, unknown> {
  const s = schema as JsonSchema | undefined;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(s?.properties ?? {})) {
    if (field.default !== undefined) out[key] = field.default;
    else if (s?.required?.includes(key)) {
      out[key] =
        field.type === "number" || field.type === "integer"
          ? 0
          : field.type === "boolean"
            ? false
            : field.type === "array"
              ? []
              : field.type === "object"
                ? {}
                : "";
    }
  }
  return out;
}

function Outline({
  triggers,
  outline,
}: {
  triggers: TriggerSpec[];
  outline: OutlineItem[];
}) {
  const nodes = [
    {
      key: "trigger",
      label: triggers.map(triggerLabel).join(" · "),
      chip: (
        <Box
          component="span"
          sx={{
            display: "inline-flex",
            gap: 0.5,
            alignItems: "center",
            fontSize: 11,
            color: "text.secondary",
          }}
        >
          <Zap size={12} /> trigger
        </Box>
      ),
      dynamic: false,
    },
    ...outline.map((item, i) => ({
      key: `${i}`,
      label: item.name,
      chip: <KindChip kind={item.kind} />,
      dynamic: item.dynamic,
    })),
  ];
  return (
    <Stack alignItems="flex-start" spacing={0}>
      {nodes.map((node, i) => (
        <Box key={node.key} sx={{ display: "flex", flexDirection: "column" }}>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              px: 1.5,
              py: 0.75,
              border: 1,
              borderColor: "divider",
              borderRadius: 1.5,
              borderStyle: node.dynamic ? "dashed" : "solid",
              minWidth: 280,
              bgcolor: "background.paper",
            }}
          >
            {node.chip}
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {node.label}
            </Typography>
            {node.dynamic && (
              <Tooltip title="Repeated per item (loop or parallel)">
                <Typography variant="caption" color="text.secondary">
                  ×n
                </Typography>
              </Tooltip>
            )}
          </Box>
          {i < nodes.length - 1 && (
            <Box sx={{ pl: 3, color: "text.disabled", display: "flex" }}>
              <ArrowDown size={16} />
            </Box>
          )}
        </Box>
      ))}
    </Stack>
  );
}

export default function ProcessView({
  tabId,
  processId,
}: {
  tabId: string;
  processId: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const detail = useProcessStore(s =>
    workspaceId ? s.details[`${workspaceId}:${processId}`] : undefined,
  );
  const runs = useProcessStore(s =>
    workspaceId
      ? (s.runsByProcess[`${workspaceId}:${processId}`] ?? EMPTY_RUNS)
      : EMPTY_RUNS,
  );
  const fetchProcess = useProcessStore(s => s.fetchProcess);
  const fetchRuns = useProcessStore(s => s.fetchRuns);
  const startRun = useProcessStore(s => s.startRun);
  const updateProcess = useProcessStore(s => s.updateProcess);
  const error = useProcessStore(s => s.error);
  const clearError = useProcessStore(s => s.clearError);

  const [input, setInput] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    void fetchProcess(workspaceId, processId);
    void fetchRuns(workspaceId, processId);
  }, [workspaceId, processId, fetchProcess, fetchRuns]);

  const live = runs.some(r => !TERMINAL_RUN_STATUSES.includes(r.status));
  useEffect(() => {
    if (!workspaceId) return;
    const timer = setInterval(
      () => void fetchRuns(workspaceId, processId),
      live ? 3_000 : 20_000,
    );
    return () => clearInterval(timer);
  }, [workspaceId, processId, fetchRuns, live]);

  useEffect(() => {
    if (detail?.name) {
      useConsoleStore.getState().updateTitle(tabId, detail.name);
    }
  }, [tabId, detail?.name]);

  const defaultInput = useMemo(
    () => JSON.stringify(sampleInput(detail?.manifest.inputSchema), null, 2),
    [detail?.manifest.inputSchema],
  );

  if (!detail) {
    return (
      <Box sx={{ p: 3 }}>
        {error ? (
          <Alert severity="error" onClose={clearError}>
            {error}
          </Alert>
        ) : (
          <Typography color="text.secondary">Loading…</Typography>
        )}
      </Box>
    );
  }

  const run = async () => {
    if (!workspaceId) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(input ?? defaultInput);
    } catch {
      setInputError("Input is not valid JSON");
      return;
    }
    setInputError(null);
    setStarting(true);
    const started = await startRun(workspaceId, processId, parsed);
    setStarting(false);
    if (started) {
      focusProcessRunTab(
        processId,
        started.id,
        `${detail.name} #${started.number}`,
      );
    }
  };

  return (
    <VSScrollArea>
      <Box sx={{ p: 3, maxWidth: 1100 }}>
        {error && (
          <Alert severity="error" onClose={clearError} sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Stack direction="row" alignItems="center" spacing={2}>
          <Typography variant="h5" sx={{ fontWeight: 600, flex: 1 }}>
            {detail.name}
          </Typography>
          <Tooltip title="Enabled processes receive event and schedule triggers (admins)">
            <Stack direction="row" alignItems="center">
              <Typography variant="body2" color="text.secondary">
                Enabled
              </Typography>
              <Switch
                checked={detail.installation.enabled}
                onChange={e =>
                  workspaceId &&
                  void updateProcess(workspaceId, processId, {
                    enabled: e.target.checked,
                  })
                }
              />
            </Stack>
          </Tooltip>
        </Stack>
        <Typography color="text.secondary" sx={{ mt: 0.5 }}>
          {detail.description}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          component="div"
          sx={{ mt: 0.5 }}
        >
          {detail.id} · version v{detail.currentVersion.number} (
          {detail.currentVersion.hash}) · {detail.versions.length} version
          {detail.versions.length === 1 ? "" : "s"}
          {" · "}
          <Box
            component="span"
            sx={{ cursor: "pointer", textDecoration: "underline" }}
            onClick={() => setShowSource(v => !v)}
          >
            {showSource ? "hide code" : "view code"}
          </Box>
        </Typography>

        {showSource && (
          <Box
            component="pre"
            sx={{
              mt: 1,
              p: 1.5,
              maxHeight: 420,
              overflow: "auto",
              bgcolor: "action.hover",
              borderRadius: 1,
              fontFamily: BUI_MONO_FONT_FAMILY,
              fontSize: 12,
            }}
          >
            {detail.currentVersion.source}
          </Box>
        )}

        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={4}
          sx={{ mt: 2 }}
        >
          <Box sx={{ flex: 1 }}>
            <SectionLabel>Flow (derived from the code)</SectionLabel>
            <Outline
              triggers={detail.manifest.triggers}
              outline={detail.currentVersion.outline}
            />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <SectionLabel>Tools this process may use</SectionLabel>
            <Stack spacing={0.75}>
              {detail.manifest.tools.length === 0 && (
                <Typography variant="body2" color="text.secondary">
                  None
                </Typography>
              )}
              {detail.manifest.tools.map(tool => (
                <Stack
                  key={tool.name}
                  direction="row"
                  spacing={1}
                  alignItems="center"
                >
                  <EffectChip effect={tool.effect} />
                  <Tooltip title={tool.description}>
                    <Typography
                      variant="body2"
                      sx={{ fontFamily: BUI_MONO_FONT_FAMILY, fontSize: 12.5 }}
                    >
                      {tool.name}
                    </Typography>
                  </Tooltip>
                  {tool.connections.length > 0 && (
                    <Typography variant="caption" color="text.secondary">
                      needs {tool.connections.join(", ")}
                      {tool.connections.every(
                        c => detail.installation.bindings[c],
                      )
                        ? " ✓"
                        : " (unbound)"}
                    </Typography>
                  )}
                </Stack>
              ))}
            </Stack>

            <SectionLabel>Run</SectionLabel>
            <TextField
              multiline
              fullWidth
              minRows={4}
              maxRows={14}
              value={input ?? defaultInput}
              onChange={e => setInput(e.target.value)}
              InputProps={{
                sx: { fontFamily: BUI_MONO_FONT_FAMILY, fontSize: 12 },
              }}
            />
            {inputError && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {inputError}
              </Alert>
            )}
            <Button
              variant="contained"
              startIcon={<Play size={14} />}
              sx={{ mt: 1 }}
              disabled={starting}
              onClick={() => void run()}
            >
              Run
            </Button>
          </Box>
        </Stack>

        <SectionLabel>Runs</SectionLabel>
        {runs.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No runs yet.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Trigger</TableCell>
                <TableCell>Started</TableCell>
                <TableCell>Duration</TableCell>
                <TableCell>Version</TableCell>
                <TableCell>Tokens</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {runs.map(r => (
                <TableRow
                  key={r.id}
                  hover
                  sx={{ cursor: "pointer" }}
                  onClick={() =>
                    focusProcessRunTab(
                      processId,
                      r.id,
                      `${detail.name} #${r.number}`,
                    )
                  }
                >
                  <TableCell>{r.number}</TableCell>
                  <TableCell>
                    <RunStatusPill status={r.status} waitingOn={r.waitingOn} />
                  </TableCell>
                  <TableCell>{r.trigger.type}</TableCell>
                  <TableCell>{formatTime(r.createdAt)}</TableCell>
                  <TableCell>
                    {r.startedAt
                      ? formatDuration(
                          new Date(r.endedAt ?? Date.now()).getTime() -
                            new Date(r.startedAt).getTime(),
                        )
                      : "—"}
                  </TableCell>
                  <TableCell>v{r.versionNumber}</TableCell>
                  <TableCell>
                    {r.usage.inputTokens + r.usage.outputTokens > 0
                      ? (
                          r.usage.inputTokens + r.usage.outputTokens
                        ).toLocaleString()
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Box>
    </VSScrollArea>
  );
}
