import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useWorkspace } from "../contexts/workspace-context";
import {
  DEFAULT_REVERSE_FLOW_SPEC,
  ReverseFlowDryRunResult,
  ReverseFlowMapping,
  ReverseFlowSpec,
  useReverseFlowStore,
} from "../store/reverseFlowStore";

export interface ReverseFlowFormRef {
  getFormState: () => Record<string, unknown>;
  setField: (path: string, value: unknown) => void;
  setMultipleFields: (fields: Record<string, unknown>) => void;
}

interface ReverseFlowEditorProps {
  reverseFlowId?: string;
  isNew?: boolean;
  onCancel?: () => void;
}

function cloneSpec(spec: ReverseFlowSpec): ReverseFlowSpec {
  return JSON.parse(JSON.stringify(spec)) as ReverseFlowSpec;
}

function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
) {
  const parts = path.split(".");
  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    if (!cursor[part] || typeof cursor[part] !== "object") {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

function MappingTable({
  mappings,
  onChange,
}: {
  mappings: ReverseFlowMapping[];
  onChange: (mappings: ReverseFlowMapping[]) => void;
}) {
  const update = (index: number, patch: Partial<ReverseFlowMapping>) => {
    onChange(
      mappings.map((mapping, idx) =>
        idx === index ? { ...mapping, ...patch } : mapping,
      ),
    );
  };

  return (
    <Stack spacing={1}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h6">Mappings</Typography>
        <Button
          size="small"
          onClick={() =>
            onChange([
              ...mappings,
              {
                target: "",
                source: { column: "" },
                required: false,
                onConflict: "fill_empty",
              },
            ])
          }
        >
          Add mapping
        </Button>
      </Stack>
      {mappings.map((mapping, index) => (
        <Paper key={index} variant="outlined" sx={{ p: 1.5 }}>
          <Stack direction={{ xs: "column", md: "row" }} spacing={1}>
            <TextField
              label="Source column"
              size="small"
              value={mapping.source.column || ""}
              onChange={event =>
                update(index, {
                  source: { ...mapping.source, column: event.target.value },
                })
              }
              fullWidth
            />
            <TextField
              label="Target field"
              size="small"
              value={mapping.target}
              onChange={event => update(index, { target: event.target.value })}
              fullWidth
            />
            <TextField
              select
              label="Conflict"
              size="small"
              value={mapping.onConflict || "fill_empty"}
              onChange={event =>
                update(index, {
                  onConflict: event.target
                    .value as ReverseFlowMapping["onConflict"],
                })
              }
              sx={{ minWidth: 140 }}
            >
              <MenuItem value="overwrite">Overwrite</MenuItem>
              <MenuItem value="fill_empty">Fill empty</MenuItem>
              <MenuItem value="ignore">Ignore</MenuItem>
            </TextField>
            <TransformEditorPopover
              mapping={mapping}
              onChange={next => update(index, next)}
            />
            <Button
              color="error"
              onClick={() =>
                onChange(mappings.filter((_, idx) => idx !== index))
              }
            >
              Remove
            </Button>
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}

function TransformEditorPopover({
  mapping,
  onChange,
}: {
  mapping: ReverseFlowMapping;
  onChange: (patch: Partial<ReverseFlowMapping>) => void;
}) {
  const [raw, setRaw] = useState(
    JSON.stringify(mapping.source.transform || {}, null, 2),
  );

  return (
    <TextField
      label="Transform JSON"
      size="small"
      value={raw}
      onChange={event => {
        setRaw(event.target.value);
        try {
          const transform = JSON.parse(event.target.value);
          onChange({ source: { ...mapping.source, transform } });
        } catch {
          // Keep invalid JSON local until the user finishes editing.
        }
      }}
      multiline
      minRows={1}
      sx={{ minWidth: 180 }}
    />
  );
}

function DryRunPreview({ dryRun }: { dryRun?: ReverseFlowDryRunResult }) {
  if (!dryRun) return null;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1}>
        <Typography variant="h6">Dry run preview</Typography>
        <Stack direction="row" spacing={1}>
          <Chip label={`${dryRun.summary.accepted} OK`} color="success" />
          <Chip label={`${dryRun.summary.rejected} rejected`} color="error" />
          <Chip
            label={`${dryRun.summary.ambiguous} ambiguous`}
            color="warning"
          />
          <Chip
            label={dryRun.summary.passed ? "passed" : "blocked"}
            color={dryRun.summary.passed ? "success" : "warning"}
          />
        </Stack>
        {dryRun.rows.slice(0, 10).map((row, index) => (
          <Box key={index} sx={{ fontFamily: "monospace", fontSize: 12 }}>
            <strong>{row.outcome.status}</strong> {JSON.stringify(row.payload)}
            {row.fieldDiffs?.length ? (
              <Box sx={{ mt: 0.5 }}>
                {row.fieldDiffs.map(diff => (
                  <div key={diff.field}>
                    {diff.field}: {JSON.stringify(diff.before)} -&gt;{" "}
                    {JSON.stringify(diff.after)}
                    {diff.willOverwrite ? " (will overwrite)" : ""}
                  </div>
                ))}
              </Box>
            ) : null}
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}

function RunHistory() {
  const runs = useReverseFlowStore(state => state.runs);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Run history
      </Typography>
      <Stack spacing={1}>
        {runs.map(run => (
          <Box key={run._id}>
            <Typography variant="body2">
              {run.status} • read {run.rowsRead} • created {run.rowsCreated} •
              updated {run.rowsUpdated} • failed {run.rowsFailed}
            </Typography>
            {run.rowOutcomes.slice(0, 5).map(outcome => (
              <Typography
                key={`${run._id}-${outcome.sourcePk}`}
                variant="caption"
                display="block"
              >
                {outcome.sourcePk}: {outcome.status}
                {outcome.error ? ` (${outcome.error})` : ""}
              </Typography>
            ))}
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}

export const ReverseFlowEditor = forwardRef<
  ReverseFlowFormRef,
  ReverseFlowEditorProps
>(function ReverseFlowEditor({ reverseFlowId, isNew, onCancel }, ref) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const fetchFlow = useReverseFlowStore(state => state.fetchFlow);
  const fetchRuns = useReverseFlowStore(state => state.fetchRuns);
  const createFlow = useReverseFlowStore(state => state.createFlow);
  const updateFlow = useReverseFlowStore(state => state.updateFlow);
  const dryRunFlow = useReverseFlowStore(state => state.dryRunFlow);
  const activateFlow = useReverseFlowStore(state => state.activateFlow);
  const runFlow = useReverseFlowStore(state => state.runFlow);
  const dryRunResult = useReverseFlowStore(state => state.dryRun);
  const storeError = useReverseFlowStore(state => state.error);
  const lastDryRunPassed = useReverseFlowStore(
    state => state.activeFlow?.lastDryRun?.passed,
  );
  const [name, setName] = useState("Untitled Reverse ETL");
  const [flowId, setFlowId] = useState(reverseFlowId);
  const [spec, setSpec] = useState<ReverseFlowSpec>(() =>
    cloneSpec(DEFAULT_REVERSE_FLOW_SPEC),
  );
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (!workspaceId || !reverseFlowId || isNew) return;
    void fetchFlow(workspaceId, reverseFlowId).then(flow => {
      setName(flow.name);
      setSpec(cloneSpec(flow.spec));
      setFlowId(flow.id);
      void fetchRuns(workspaceId, flow.id);
    });
  }, [workspaceId, reverseFlowId, isNew, fetchFlow, fetchRuns]);

  const patchSpec = useCallback((path: string, value: unknown) => {
    setSpec(current => {
      const next = cloneSpec(current);
      setPath(next as unknown as Record<string, unknown>, path, value);
      return next;
    });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      getFormState: () => ({ name, spec, flowId }),
      setField: (path, value) => {
        if (path === "name") setName(String(value));
        else patchSpec(path, value);
      },
      setMultipleFields: fields => {
        for (const [path, value] of Object.entries(fields)) {
          if (path === "name") setName(String(value));
          else patchSpec(path, value);
        }
      },
    }),
    [flowId, name, patchSpec, spec],
  );

  const canActivate = useMemo(
    () => !spec.safety.dryRunRequiredBeforeActivate || lastDryRunPassed,
    [lastDryRunPassed, spec.safety.dryRunRequiredBeforeActivate],
  );

  const save = async () => {
    if (!workspaceId) return;
    const saved = flowId
      ? await updateFlow(workspaceId, flowId, { name, spec })
      : await createFlow(workspaceId, { name, spec });
    setFlowId(saved.id);
    setMessage("Saved reverse flow");
  };

  const dryRun = async () => {
    if (!workspaceId) return;
    const savedId =
      flowId || (await createFlow(workspaceId, { name, spec })).id;
    setFlowId(savedId);
    await dryRunFlow(workspaceId, savedId, { spec, sampleSize: 25 });
    setMessage("Dry run completed");
  };

  return (
    <Box sx={{ height: "100%", overflow: "auto", p: 3 }}>
      <Stack spacing={2}>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
        >
          <Box>
            <Typography variant="h5">Reverse ETL</Typography>
            <Typography variant="body2" color="text.secondary">
              Writes mapped source rows to production CRM records with per-row
              audit.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="outlined" onClick={save}>
              Save
            </Button>
            <Button variant="outlined" onClick={dryRun}>
              Dry run
            </Button>
            <Button
              variant="contained"
              color="warning"
              disabled={!workspaceId || !flowId || !canActivate}
              onClick={async () => {
                if (!workspaceId || !flowId) return;
                await activateFlow(workspaceId, flowId);
                setMessage("Activated; writes to production Close on run");
              }}
            >
              Activate
            </Button>
            <Button
              variant="contained"
              disabled={!workspaceId || !flowId}
              onClick={async () => {
                if (!workspaceId || !flowId) return;
                await runFlow(workspaceId, flowId);
                setMessage("Run queued");
              }}
            >
              Run
            </Button>
          </Stack>
        </Stack>

        <Alert severity="warning">
          Activating this flow writes to PRODUCTION destination systems.
        </Alert>
        {message ? <Alert severity="success">{message}</Alert> : null}
        {storeError ? <Alert severity="error">{storeError}</Alert> : null}

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={2}>
            <TextField
              label="Name"
              value={name}
              onChange={e => setName(e.target.value)}
            />
            <TextField
              label="Source connection ID"
              value={spec.source.connectionId}
              onChange={e => patchSpec("source.connectionId", e.target.value)}
            />
            <TextField
              label="Source database"
              value={spec.source.database || ""}
              onChange={e => patchSpec("source.database", e.target.value)}
            />
            <TextField
              label="SQL query"
              value={spec.source.query}
              onChange={e => patchSpec("source.query", e.target.value)}
              multiline
              minRows={5}
            />
            <TextField
              label="Primary key column"
              value={spec.source.primaryKey}
              onChange={e => patchSpec("source.primaryKey", e.target.value)}
            />
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={2}>
            <Typography variant="h6">Destination</Typography>
            <TextField
              label="Connector ID"
              value={spec.destination.connectorId}
              onChange={e =>
                patchSpec("destination.connectorId", e.target.value)
              }
            />
            <TextField
              label="Entity"
              value={spec.destination.entity}
              onChange={e => patchSpec("destination.entity", e.target.value)}
            />
            <Stack direction={{ xs: "column", md: "row" }} spacing={1}>
              <TextField
                select
                label="Write mode"
                value={spec.destination.writeMode}
                onChange={e =>
                  patchSpec("destination.writeMode", e.target.value)
                }
                fullWidth
              >
                <MenuItem value="create">Create</MenuItem>
                <MenuItem value="update">Update</MenuItem>
                <MenuItem value="upsert">Upsert</MenuItem>
              </TextField>
              <TextField
                select
                label="Update strategy"
                value={spec.destination.updateFieldStrategy}
                onChange={e =>
                  patchSpec("destination.updateFieldStrategy", e.target.value)
                }
                fullWidth
              >
                <MenuItem value="overwrite">Overwrite</MenuItem>
                <MenuItem value="fill_empty">Fill empty</MenuItem>
                <MenuItem value="ignore">Ignore</MenuItem>
              </TextField>
            </Stack>
            <Stack direction={{ xs: "column", md: "row" }} spacing={1}>
              <TextField
                label="Lookup column"
                value={spec.destination.match.lookupColumn}
                onChange={e =>
                  patchSpec("destination.match.lookupColumn", e.target.value)
                }
                fullWidth
              />
              <TextField
                label="Remote field"
                value={spec.destination.match.remoteField}
                onChange={e =>
                  patchSpec("destination.match.remoteField", e.target.value)
                }
                fullWidth
              />
            </Stack>
          </Stack>
        </Paper>

        <MappingTable
          mappings={spec.mappings}
          onChange={mappings => patchSpec("mappings", mappings)}
        />

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction={{ xs: "column", md: "row" }} spacing={1}>
            <TextField
              label="Cron"
              value={spec.schedule.cron || ""}
              onChange={e => patchSpec("schedule.cron", e.target.value)}
              fullWidth
            />
            <TextField
              label="Timezone"
              value={spec.schedule.timezone}
              onChange={e => patchSpec("schedule.timezone", e.target.value)}
              fullWidth
            />
            <TextField
              label="Batch size"
              type="number"
              value={spec.safety.batchSize}
              onChange={e =>
                patchSpec("safety.batchSize", Number(e.target.value))
              }
              fullWidth
            />
          </Stack>
        </Paper>

        <DryRunPreview dryRun={dryRunResult} />
        <Divider />
        <RunHistory />
      </Stack>
    </Box>
  );
});
