/**
 * Shared pieces of the Processes UI: status pills/badges, kind and effect
 * chips, JSON blocks, time formatting, and the human-request card (approval
 * or task) used both inline in a run and in the inbox.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import {
  Bot,
  Clock,
  Cog,
  Hand,
  Hourglass,
  ListTodo,
  type LucideIcon,
} from "lucide-react";
import {
  ResultBadge,
  SpinnerRingBadge,
  StatusPill,
  type BuiPillTone,
} from "../bui-status";
import { BUI_MONO_FONT_FAMILY } from "../chat/bui-styles";
import type {
  HumanRequest,
  JsonSchema,
  RunStatus,
  WaitingOn,
} from "../../store/processStore";
import { formatTime, waitingLabel } from "../../process-runtime/format";
import StreamingMarkdown from "../StreamingMarkdown";

const RUN_STATUS: Record<RunStatus, { label: string; tone: BuiPillTone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "accent" },
  waiting: { label: "Waiting", tone: "orange" },
  completed: { label: "Completed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function RunStatusPill({
  status,
  waitingOn,
}: {
  status: RunStatus;
  waitingOn?: WaitingOn | null;
}) {
  const meta = RUN_STATUS[status];
  return (
    <StatusPill tone={meta.tone}>
      {status === "waiting" ? waitingLabel(waitingOn) : meta.label}
    </StatusPill>
  );
}

/** The circle at the left of a timeline row. */
export function StepBadge({ status }: { status: string }) {
  if (status === "completed") return <ResultBadge tone="green" size={20} />;
  if (status === "failed") return <ResultBadge tone="red" size={20} />;
  if (status === "waiting") {
    return (
      <Box
        component="span"
        sx={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          bgcolor: "warning.main",
          color: "#fff",
          flexShrink: 0,
        }}
      >
        <Hourglass size={11} strokeWidth={2.5} />
      </Box>
    );
  }
  return <SpinnerRingBadge size={20} />;
}

const KIND_META: Record<string, { label: string; icon: LucideIcon }> = {
  step: { label: "step", icon: Cog },
  agent: { label: "agent", icon: Bot },
  approval: { label: "approval", icon: Hand },
  task: { label: "task", icon: ListTodo },
  wait: { label: "wait", icon: Clock },
};

export function KindChip({ kind }: { kind: string }) {
  const meta = KIND_META[kind] ?? KIND_META.step;
  const Icon = meta.icon;
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.5,
        px: 0.75,
        height: 20,
        borderRadius: 1,
        fontSize: 11,
        color: "text.secondary",
        border: 1,
        borderColor: "divider",
        flexShrink: 0,
      }}
    >
      <Icon size={12} />
      {meta.label}
    </Box>
  );
}

const EFFECT_TONE: Record<string, BuiPillTone> = {
  read: "neutral",
  write: "orange",
  destructive: "red",
};

export function EffectChip({ effect }: { effect: string }) {
  return (
    <StatusPill tone={EFFECT_TONE[effect] ?? "neutral"}>{effect}</StatusPill>
  );
}

export function JsonBlock({
  value,
  maxHeight = 320,
}: {
  value: unknown;
  maxHeight?: number;
}) {
  const text = useMemo(() => {
    if (value === undefined) return "—";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1,
        maxHeight,
        overflow: "auto",
        fontFamily: BUI_MONO_FONT_FAMILY,
        fontSize: 12,
        lineHeight: 1.5,
        bgcolor: "action.hover",
        borderRadius: 1,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {text}
    </Box>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="caption"
      sx={{
        display: "block",
        mt: 1.5,
        mb: 0.5,
        color: "text.secondary",
        textTransform: "uppercase",
        letterSpacing: 0.4,
        fontWeight: 600,
      }}
    >
      {children}
    </Typography>
  );
}

/**
 * Structured data for people: arrays of flat objects become tables, scalars
 * become "key: value" lines, anything deeper falls back to JSON.
 */
function isFlatRow(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every(
      x =>
        x === null ||
        typeof x !== "object" ||
        (Array.isArray(x) && x.every(y => typeof y !== "object")),
    )
  );
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

export function DataView({ value }: { value: unknown }) {
  if (typeof value !== "object" || value === null) {
    return <JsonBlock value={value} />;
  }
  const entries = Array.isArray(value)
    ? [["items", value] as [string, unknown]]
    : Object.entries(value);
  return (
    <Stack spacing={1.25}>
      {entries.map(([key, v]) => {
        if (Array.isArray(v) && v.length > 0 && v.every(isFlatRow)) {
          const columns = [...new Set(v.flatMap(row => Object.keys(row)))];
          return (
            <Box key={key}>
              <Typography variant="caption" color="text.secondary">
                {key}
              </Typography>
              <Box sx={{ overflowX: "auto" }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      {columns.map(c => (
                        <TableCell key={c}>{c}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {v.map((row, i) => (
                      <TableRow key={i}>
                        {columns.map(c => (
                          <TableCell key={c} sx={{ verticalAlign: "top" }}>
                            {cell(row[c])}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            </Box>
          );
        }
        if (
          v === null ||
          typeof v !== "object" ||
          (Array.isArray(v) && v.every(x => typeof x !== "object"))
        ) {
          return (
            <Typography key={key} variant="body2">
              <Box component="span" sx={{ color: "text.secondary" }}>
                {key}:
              </Box>{" "}
              {Array.isArray(v) && v.length === 0 ? "none" : cell(v)}
            </Typography>
          );
        }
        return (
          <Box key={key}>
            <Typography variant="caption" color="text.secondary">
              {key}
            </Typography>
            <JsonBlock value={v} maxHeight={240} />
          </Box>
        );
      })}
    </Stack>
  );
}

// ── Human requests ─────────────────────────────────────────────────────────

/** Flat object schemas with scalar fields render as a form; else JSON. */
function isSimpleForm(schema: JsonSchema | null): boolean {
  if (!schema || schema.type !== "object" || !schema.properties) return false;
  return Object.values(schema.properties).every(
    p =>
      ["string", "number", "integer", "boolean"].includes(String(p.type)) ||
      Array.isArray(p.enum),
  );
}

function FormFields({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <Stack spacing={1.5}>
      {Object.entries(schema.properties ?? {}).map(([key, field]) => {
        const label = `${key}${schema.required?.includes(key) ? " *" : ""}`;
        if (field.type === "boolean") {
          return (
            <FormControlLabel
              key={key}
              control={
                <Checkbox
                  checked={Boolean(value[key])}
                  onChange={e =>
                    onChange({ ...value, [key]: e.target.checked })
                  }
                />
              }
              label={
                field.description ? `${label} — ${field.description}` : label
              }
            />
          );
        }
        if (Array.isArray(field.enum)) {
          return (
            <TextField
              key={key}
              select
              size="small"
              label={label}
              helperText={field.description}
              value={(value[key] as string) ?? ""}
              onChange={e => onChange({ ...value, [key]: e.target.value })}
            >
              {field.enum.map(option => (
                <MenuItem key={String(option)} value={String(option)}>
                  {String(option)}
                </MenuItem>
              ))}
            </TextField>
          );
        }
        const numeric = field.type === "number" || field.type === "integer";
        return (
          <TextField
            key={key}
            size="small"
            label={label}
            helperText={field.description}
            type={numeric ? "number" : "text"}
            value={(value[key] as string | number | undefined) ?? ""}
            onChange={e =>
              onChange({
                ...value,
                [key]:
                  numeric && e.target.value !== ""
                    ? Number(e.target.value)
                    : e.target.value || undefined,
              })
            }
          />
        );
      })}
    </Stack>
  );
}

export function HumanRequestCard({
  request,
  onRespond,
  onOpenRun,
}: {
  request: HumanRequest;
  onRespond: (response: {
    decision: "approve" | "reject" | "submit";
    data?: unknown;
    comment?: string;
  }) => Promise<boolean>;
  onOpenRun?: () => void;
}) {
  const pending = request.status === "pending";
  const editable = request.kind === "approval" && Boolean(request.schema);
  const simple = request.kind === "task" && isSimpleForm(request.schema);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() =>
    JSON.stringify(request.payload ?? {}, null, 2),
  );
  const [form, setForm] = useState<Record<string, unknown>>(
    () => (request.payload as Record<string, unknown>) ?? {},
  );
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const submit = async (decision: "approve" | "reject" | "submit") => {
    let data: unknown;
    if (decision === "submit") {
      if (simple) data = form;
      else {
        try {
          data = JSON.parse(draft);
        } catch {
          setParseError("Not valid JSON");
          return;
        }
      }
    } else if (decision === "approve" && editing) {
      try {
        data = JSON.parse(draft);
      } catch {
        setParseError("Not valid JSON");
        return;
      }
    }
    setParseError(null);
    setBusy(true);
    await onRespond({ decision, data, comment: comment || undefined });
    setBusy(false);
  };

  return (
    <Box
      sx={{
        border: 1,
        borderColor: pending ? "warning.main" : "divider",
        borderRadius: 2,
        p: 2,
        bgcolor: "background.paper",
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <KindChip kind={request.kind} />
        <Typography variant="subtitle2" sx={{ flex: 1, fontWeight: 600 }}>
          {request.title}
        </Typography>
        {!pending && (
          <StatusPill
            tone={
              request.status === "approved" || request.status === "submitted"
                ? "green"
                : request.status === "rejected"
                  ? "red"
                  : "neutral"
            }
          >
            {request.status}
          </StatusPill>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" component="div">
        {request.processName} · run #{request.runNumber}
        {onOpenRun && (
          <Button
            size="small"
            onClick={onOpenRun}
            sx={{ ml: 1, minWidth: 0, p: 0 }}
          >
            open run
          </Button>
        )}
        {pending && <> · expires {formatTime(request.expiresAt)}</>}
        {request.assignees.length > 0 && (
          <> · for {request.assignees.join(", ")}</>
        )}
      </Typography>
      {request.description && (
        <Box sx={{ mt: 1, fontSize: 14 }}>
          <StreamingMarkdown>{request.description}</StreamingMarkdown>
        </Box>
      )}

      {request.kind === "approval" && (
        <>
          <SectionLabel>
            {editing ? "Edit data (validated on submit)" : "Data"}
          </SectionLabel>
          {editing ? (
            <TextField
              multiline
              fullWidth
              minRows={8}
              maxRows={24}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              InputProps={{
                sx: { fontFamily: BUI_MONO_FONT_FAMILY, fontSize: 12 },
              }}
            />
          ) : (
            <DataView value={request.payload} />
          )}
        </>
      )}

      {request.kind === "task" && pending && (
        <>
          <SectionLabel>Form</SectionLabel>
          {simple && request.schema ? (
            <FormFields
              schema={request.schema}
              value={form}
              onChange={setForm}
            />
          ) : (
            <TextField
              multiline
              fullWidth
              minRows={6}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              InputProps={{
                sx: { fontFamily: BUI_MONO_FONT_FAMILY, fontSize: 12 },
              }}
            />
          )}
        </>
      )}

      {!pending && request.response && (
        <>
          <SectionLabel>
            Response by{" "}
            {request.respondedBy?.email ?? request.respondedBy?.id ?? "unknown"}{" "}
            · {formatTime(request.respondedAt)}
            {request.response.edited ? " · edited" : ""}
          </SectionLabel>
          {request.response.comment && (
            <Typography variant="body2" sx={{ mb: 1 }}>
              “{request.response.comment}”
            </Typography>
          )}
          {request.response.data !== undefined && (
            <DataView value={request.response.data} />
          )}
        </>
      )}

      {pending && (
        <>
          <TextField
            fullWidth
            size="small"
            placeholder="Comment (optional, recorded in the audit trail)"
            value={comment}
            onChange={e => setComment(e.target.value)}
            sx={{ mt: 1.5 }}
          />
          {parseError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {parseError}
            </Alert>
          )}
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            {request.kind === "approval" ? (
              <>
                <Button
                  variant="contained"
                  color="success"
                  disabled={busy}
                  onClick={() => void submit("approve")}
                >
                  {editing ? "Approve edited" : "Approve"}
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  disabled={busy}
                  onClick={() => void submit("reject")}
                >
                  Reject
                </Button>
                {editable && !editing && (
                  <Button disabled={busy} onClick={() => setEditing(true)}>
                    Edit data
                  </Button>
                )}
              </>
            ) : (
              <Button
                variant="contained"
                disabled={busy}
                onClick={() => void submit("submit")}
              >
                Submit
              </Button>
            )}
          </Stack>
        </>
      )}
    </Box>
  );
}
