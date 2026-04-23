import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Delete as DeleteIcon,
  EditOutlined as EditIcon,
  Refresh as RefreshIcon,
  Save as SaveIcon,
} from "@mui/icons-material";
import { useWorkspace } from "../contexts/workspace-context";

interface SkillSummary {
  id: string;
  name: string;
  loadWhen: string;
  bodyPreview: string;
  entities: string[];
  suppressed: boolean;
  useCount: number;
  lastUsedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface SkillDetail extends SkillSummary {
  body: string;
  previousBody: string | null;
  previousUpdatedAt: string | null;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export function SkillsSection() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<SkillDetail | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editLoadWhen, setEditLoadWhen] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editEntities, setEditEntities] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchSkills = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/skills`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to load skills");
      }
      setSkills(data.skills as SkillSummary[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void fetchSkills();
  }, [fetchSkills]);

  const handleToggleSuppress = async (skill: SkillSummary) => {
    if (!workspaceId) return;
    const nextSuppressed = !skill.suppressed;
    // Optimistic update
    setSkills(prev =>
      prev.map(s =>
        s.id === skill.id ? { ...s, suppressed: nextSuppressed } : s,
      ),
    );
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/skills/${skill.id}/suppress`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suppressed: nextSuppressed }),
        },
      );
      if (!res.ok) throw new Error("Request failed");
    } catch {
      // Rollback on error
      setSkills(prev =>
        prev.map(s =>
          s.id === skill.id ? { ...s, suppressed: skill.suppressed } : s,
        ),
      );
    }
  };

  const handleDelete = async (skill: SkillSummary) => {
    if (!workspaceId) return;
    if (
      !window.confirm(
        `Delete skill "${skill.name}"? This is permanent — the agent can still recreate it later.`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/skills/${skill.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Request failed");
      setSkills(prev => prev.filter(s => s.id !== skill.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete skill");
    }
  };

  const openEditor = async (skill: SkillSummary) => {
    if (!workspaceId) return;
    setEditLoading(true);
    setEditing(null);
    setSaveError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/skills/${skill.id}`,
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to load skill");
      }
      const detail = data.skill as SkillDetail;
      setEditing(detail);
      setEditLoadWhen(detail.loadWhen);
      setEditBody(detail.body);
      setEditEntities(detail.entities.join(", "));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skill");
    } finally {
      setEditLoading(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!workspaceId || !editing) return;
    setSaving(true);
    setSaveError(null);
    try {
      const entities = editEntities
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
      const res = await fetch(
        `/api/workspaces/${workspaceId}/skills/${editing.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            loadWhen: editLoadWhen,
            body: editBody,
            entities,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save skill");
      }
      setEditing(null);
      await fetchSkills();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const hasSkills = skills.length > 0;
  const suppressedCount = useMemo(
    () => skills.filter(s => s.suppressed).length,
    [skills],
  );

  return (
    <Box>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="flex-end"
        sx={{ mb: 1 }}
      >
        <Tooltip title="Refresh">
          <span>
            <IconButton
              size="small"
              onClick={fetchSkills}
              disabled={loading}
              aria-label="refresh skills"
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading && !hasSkills && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      )}

      {!loading && !hasSkills && (
        <Alert severity="info">
          No skills yet. The agent will save skills as you teach it durable
          facts about your workspace (schema quirks, metric definitions,
          connector specifics).
        </Alert>
      )}

      {hasSkills && (
        <Stack spacing={1.5}>
          <Typography variant="caption" color="text.secondary">
            {skills.length} skill{skills.length === 1 ? "" : "s"}
            {suppressedCount > 0 ? ` · ${suppressedCount} suppressed` : ""}
          </Typography>
          {skills.map(skill => (
            <Box
              key={skill.id}
              sx={{
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
                p: 1.5,
                bgcolor: skill.suppressed ? "action.hover" : "transparent",
                opacity: skill.suppressed ? 0.7 : 1,
              }}
            >
              <Stack
                direction="row"
                alignItems="flex-start"
                justifyContent="space-between"
                spacing={1}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Stack
                    direction="row"
                    alignItems="center"
                    spacing={1}
                    sx={{ mb: 0.5 }}
                  >
                    <Typography
                      variant="body2"
                      sx={{
                        fontFamily: "monospace",
                        fontWeight: 600,
                      }}
                    >
                      {skill.name}
                    </Typography>
                    <Chip
                      label={`used ${skill.useCount}×`}
                      size="small"
                      variant="outlined"
                    />
                    {skill.suppressed && (
                      <Chip
                        label="suppressed"
                        size="small"
                        color="warning"
                        variant="outlined"
                      />
                    )}
                  </Stack>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mb: 0.5 }}
                  >
                    <strong>loadWhen:</strong> {skill.loadWhen}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{
                      whiteSpace: "pre-wrap",
                      fontSize: "0.82rem",
                      color: "text.secondary",
                      mb: 0.5,
                    }}
                  >
                    {skill.bodyPreview}
                  </Typography>
                  {skill.entities.length > 0 && (
                    <Stack
                      direction="row"
                      spacing={0.5}
                      sx={{ flexWrap: "wrap", gap: 0.5, mb: 0.5 }}
                    >
                      {skill.entities.slice(0, 12).map(e => (
                        <Chip
                          key={e}
                          label={e}
                          size="small"
                          sx={{ height: 18, fontSize: "0.68rem" }}
                        />
                      ))}
                      {skill.entities.length > 12 && (
                        <Typography variant="caption" color="text.secondary">
                          +{skill.entities.length - 12} more
                        </Typography>
                      )}
                    </Stack>
                  )}
                  <Typography variant="caption" color="text.secondary">
                    by {skill.createdBy} · updated {formatDate(skill.updatedAt)}{" "}
                    · last used {formatDate(skill.lastUsedAt)}
                  </Typography>
                </Box>
                <Stack direction="row" alignItems="center" spacing={0.5}>
                  <Tooltip
                    title={
                      skill.suppressed
                        ? "Re-enable this skill"
                        : "Suppress — stop injecting this skill but keep it around"
                    }
                  >
                    <Switch
                      size="small"
                      checked={!skill.suppressed}
                      onChange={() => handleToggleSuppress(skill)}
                    />
                  </Tooltip>
                  <Tooltip title="Edit">
                    <IconButton
                      size="small"
                      onClick={() => openEditor(skill)}
                      aria-label="edit skill"
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete permanently">
                    <IconButton
                      size="small"
                      onClick={() => handleDelete(skill)}
                      aria-label="delete skill"
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
            </Box>
          ))}
        </Stack>
      )}

      <Dialog
        open={editing !== null || editLoading}
        onClose={() => {
          if (!saving) setEditing(null);
        }}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>
          {editing ? (
            <Box>
              <Typography variant="h6" sx={{ fontFamily: "monospace" }}>
                {editing.name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Editing will preserve the current body as a one-step undo slot.
              </Typography>
            </Box>
          ) : (
            "Loading skill…"
          )}
        </DialogTitle>
        <DialogContent dividers>
          {editLoading && (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={24} />
            </Box>
          )}
          {editing && (
            <Stack spacing={2}>
              {saveError && <Alert severity="error">{saveError}</Alert>}
              <TextField
                label="loadWhen"
                value={editLoadWhen}
                onChange={e => setEditLoadWhen(e.target.value)}
                multiline
                minRows={2}
                fullWidth
                inputProps={{ maxLength: 500 }}
                helperText="Short trigger describing when this skill should load."
              />
              <TextField
                label="body"
                value={editBody}
                onChange={e => setEditBody(e.target.value)}
                multiline
                minRows={12}
                fullWidth
                inputProps={{ maxLength: 20000 }}
                sx={{ fontFamily: "monospace" }}
              />
              <TextField
                label="entities (comma-separated)"
                value={editEntities}
                onChange={e => setEditEntities(e.target.value)}
                fullWidth
                helperText="Extra tokens the extractor might miss (synonyms, business concepts). Unioned with auto-extracted tokens."
              />
              {editing.previousBody && (
                <Alert severity="info">
                  Previous body from {formatDate(editing.previousUpdatedAt)} is
                  preserved as a one-step undo.
                </Alert>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(null)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={handleSaveEdit}
            disabled={saving || !editing}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
