/**
 * Database Description Panel
 * Displays and manages AI-generated descriptions for databases within a connection.
 * Simplified version without history, rules, or memory folding.
 */
import React, { useEffect, useState, useCallback } from "react";
import {
  Box,
  Typography,
  TextField,
  Button,
  IconButton,
  Alert,
  CircularProgress,
  Tooltip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@mui/material";
import {
  ExpandMore as ExpandMoreIcon,
  Edit as EditIcon,
  Save as SaveIcon,
  Close as CloseIcon,
  DeleteForever as WipeIcon,
  Refresh as RefreshIcon,
} from "@mui/icons-material";
import { useWorkspace } from "../contexts/workspace-context";
import { apiClient } from "../lib/api-client";

interface DatabaseEntry {
  name: string;
  description: string | null;
}

interface MemoryData {
  connectionId: string;
  connectionName: string;
  connectionSummary: string | null;
  databases: DatabaseEntry[];
}

interface DatabaseMemoryPanelProps {
  connectionId: string;
  connectionName: string;
  onClose?: () => void;
}

export const DatabaseMemoryPanel: React.FC<DatabaseMemoryPanelProps> = ({
  connectionId,
  connectionName,
  onClose,
}) => {
  const { currentWorkspace } = useWorkspace();
  const [memory, setMemory] = useState<MemoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Expanded accordion
  const [expandedDb, setExpandedDb] = useState<string | false>(false);

  // Description editing state
  const [editingDb, setEditingDb] = useState<string | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [savingDescription, setSavingDescription] = useState(false);

  // Connection summary editing state
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [savingSummary, setSavingSummary] = useState(false);

  // Wipe confirmation state
  const [wipeDbName, setWipeDbName] = useState<string | null>(null);
  const [wiping, setWiping] = useState(false);

  // Indexing state
  const [indexingDb, setIndexingDb] = useState<string | null>(null);
  const [indexingAll, setIndexingAll] = useState(false);

  // Summarizing state
  const [summarizing, setSummarizing] = useState(false);

  const isAdmin =
    currentWorkspace?.role === "owner" || currentWorkspace?.role === "admin";

  const fetchMemory = useCallback(async () => {
    if (!currentWorkspace) return;

    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.get<{
        success: boolean;
        data: MemoryData;
      }>(`/workspaces/${currentWorkspace.id}/databases/${connectionId}/memory`);

      if (response.success) {
        // Deduplicate databases by name
        const seenNames = new Set<string>();
        const deduplicatedDatabases = response.data.databases.filter(db => {
          if (seenNames.has(db.name)) {
            return false;
          }
          seenNames.add(db.name);
          return true;
        });

        setMemory({
          ...response.data,
          databases: deduplicatedDatabases,
        });
      } else {
        setError("Failed to load description data");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load descriptions",
      );
    } finally {
      setLoading(false);
    }
  }, [currentWorkspace, connectionId]);

  useEffect(() => {
    fetchMemory();
  }, [fetchMemory]);

  const handleAccordionChange =
    (dbName: string) => (_: React.SyntheticEvent, isExpanded: boolean) => {
      setExpandedDb(isExpanded ? dbName : false);
      setEditingDb(null);
    };

  const handleSaveSummary = async () => {
    if (!currentWorkspace) return;

    setSavingSummary(true);
    try {
      await apiClient.put(
        `/workspaces/${currentWorkspace.id}/databases/${connectionId}/memory/summary`,
        { summary: summaryDraft.trim() },
      );
      await fetchMemory();
      setEditingSummary(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save summary");
    } finally {
      setSavingSummary(false);
    }
  };

  const handleSaveDescription = async (dbName: string) => {
    if (!currentWorkspace || !descriptionDraft.trim()) return;

    setSavingDescription(true);
    try {
      await apiClient.post(
        `/workspaces/${currentWorkspace.id}/databases/${connectionId}/memory/description`,
        { databaseName: dbName, content: descriptionDraft.trim() },
      );
      await fetchMemory();
      setEditingDb(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save description",
      );
    } finally {
      setSavingDescription(false);
    }
  };

  const handleWipeDatabase = async () => {
    if (!currentWorkspace || !wipeDbName) return;

    setWiping(true);
    try {
      await apiClient.delete(
        `/workspaces/${currentWorkspace.id}/databases/${connectionId}/memory/wipe?database=${encodeURIComponent(wipeDbName)}`,
      );
      await fetchMemory();
      setWipeDbName(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to wipe description",
      );
    } finally {
      setWiping(false);
    }
  };

  const handleIndexDatabase = async (dbName: string) => {
    if (!currentWorkspace) return;

    setIndexingDb(dbName);
    setError(null);
    try {
      await apiClient.post(
        `/workspaces/${currentWorkspace.id}/databases/${connectionId}/memory/index`,
        { databaseName: dbName },
      );
      setTimeout(() => {
        fetchMemory();
      }, 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to trigger indexing",
      );
    } finally {
      setIndexingDb(null);
    }
  };

  const handleIndexAllDatabases = async () => {
    if (!currentWorkspace) return;

    setIndexingAll(true);
    setError(null);
    try {
      await apiClient.post(
        `/workspaces/${currentWorkspace.id}/databases/${connectionId}/memory/index-all`,
        {},
      );
      setTimeout(() => {
        fetchMemory();
      }, 5000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to trigger indexing",
      );
    } finally {
      setIndexingAll(false);
    }
  };

  const handleSummarize = async () => {
    if (!currentWorkspace) return;

    setSummarizing(true);
    setError(null);
    try {
      await apiClient.post(
        `/workspaces/${currentWorkspace.id}/databases/${connectionId}/memory/summarize`,
        {},
      );
      setTimeout(() => {
        fetchMemory();
      }, 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to trigger summarization",
      );
    } finally {
      setSummarizing(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ p: 3, display: "flex", justifyContent: "center" }}>
        <CircularProgress />
      </Box>
    );
  }

  const hasDatabases = memory?.databases && memory.databases.length > 0;

  return (
    <Box sx={{ p: 2 }}>
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          mb: 2,
        }}
      >
        <Typography variant="h6">Descriptions: {connectionName}</Typography>
        {onClose && (
          <IconButton onClick={onClose} size="small">
            <CloseIcon />
          </IconButton>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Connection Summary */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          mb: 1,
        }}
      >
        <Typography variant="subtitle2" color="text.secondary">
          Connection Summary
        </Typography>
        {!editingSummary && isAdmin && (
          <Box sx={{ display: "flex", gap: 0.5 }}>
            <Tooltip title="Generate a summary based on database descriptions">
              <IconButton
                size="small"
                onClick={handleSummarize}
                disabled={summarizing}
              >
                {summarizing ? (
                  <CircularProgress size={16} />
                ) : (
                  <RefreshIcon fontSize="small" />
                )}
              </IconButton>
            </Tooltip>
            <IconButton
              size="small"
              onClick={() => {
                setSummaryDraft(memory?.connectionSummary || "");
                setEditingSummary(true);
              }}
            >
              <EditIcon fontSize="small" />
            </IconButton>
          </Box>
        )}
      </Box>

      {editingSummary ? (
        <Box sx={{ mb: 2 }}>
          <TextField
            fullWidth
            multiline
            rows={2}
            value={summaryDraft}
            onChange={e => setSummaryDraft(e.target.value)}
            placeholder="High-level summary of what this connection contains..."
            size="small"
            inputProps={{ maxLength: 500 }}
            helperText={`${summaryDraft.length}/500 characters`}
          />
          <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
            <Button
              size="small"
              variant="contained"
              startIcon={
                savingSummary ? <CircularProgress size={14} /> : <SaveIcon />
              }
              onClick={handleSaveSummary}
              disabled={savingSummary}
            >
              Save
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() => setEditingSummary(false)}
              disabled={savingSummary}
            >
              Cancel
            </Button>
          </Box>
        </Box>
      ) : memory?.connectionSummary ? (
        <Typography variant="body2" sx={{ mb: 2 }}>
          {memory.connectionSummary}
        </Typography>
      ) : (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontStyle: "italic", mb: 2 }}
        >
          No summary set. {isAdmin ? "Click the edit button to add one." : ""}
        </Typography>
      )}

      {/* Connection-level actions */}
      {isAdmin && (
        <Box sx={{ mb: 2, display: "flex", gap: 1 }}>
          <Tooltip title="Inspect all databases and generate descriptions based on their schemas">
            <span>
              <Button
                variant="contained"
                size="small"
                startIcon={
                  indexingAll ? <CircularProgress size={14} /> : <RefreshIcon />
                }
                onClick={handleIndexAllDatabases}
                disabled={indexingAll || !!indexingDb}
              >
                Index All Databases
              </Button>
            </span>
          </Tooltip>
        </Box>
      )}

      {/* Database accordions */}
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
        Databases
      </Typography>
      {hasDatabases ? (
        <Box
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            overflow: "hidden",
          }}
        >
          {memory?.databases
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((db, index, arr) => (
              <Accordion
                key={db.name}
                expanded={expandedDb === db.name}
                onChange={handleAccordionChange(db.name)}
                disableGutters
                elevation={0}
                square
                sx={{
                  "&:before": { display: "none" },
                  borderBottom: index < arr.length - 1 ? 1 : 0,
                  borderColor: "divider",
                }}
              >
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography
                    sx={{
                      fontWeight: db.description ? 500 : 400,
                      color: db.description ? "text.primary" : "text.secondary",
                      fontStyle: db.description ? "normal" : "italic",
                    }}
                  >
                    {db.name}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  {/* Description Section */}
                  <Box sx={{ mb: 2 }}>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        mb: 1,
                      }}
                    >
                      <Typography variant="subtitle2" color="text.secondary">
                        Description
                      </Typography>
                      {editingDb !== db.name && isAdmin && (
                        <IconButton
                          size="small"
                          onClick={() => {
                            setDescriptionDraft(db.description || "");
                            setEditingDb(db.name);
                          }}
                        >
                          <EditIcon fontSize="small" />
                        </IconButton>
                      )}
                    </Box>

                    {editingDb === db.name ? (
                      <Box>
                        <TextField
                          fullWidth
                          multiline
                          rows={3}
                          value={descriptionDraft}
                          onChange={e => setDescriptionDraft(e.target.value)}
                          placeholder="Describe what this database contains..."
                          size="small"
                          inputProps={{ maxLength: 500 }}
                          helperText={`${descriptionDraft.length}/500 characters`}
                        />
                        <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
                          <Button
                            size="small"
                            variant="contained"
                            startIcon={
                              savingDescription ? (
                                <CircularProgress size={14} />
                              ) : (
                                <SaveIcon />
                              )
                            }
                            onClick={() => handleSaveDescription(db.name)}
                            disabled={
                              savingDescription || !descriptionDraft.trim()
                            }
                          >
                            Save
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => setEditingDb(null)}
                            disabled={savingDescription}
                          >
                            Cancel
                          </Button>
                        </Box>
                      </Box>
                    ) : db.description ? (
                      <Typography variant="body2">{db.description}</Typography>
                    ) : (
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ fontStyle: "italic" }}
                      >
                        No description yet.{" "}
                        {isAdmin
                          ? 'Click "Index DB" to generate one automatically.'
                          : ""}
                      </Typography>
                    )}
                  </Box>

                  {/* Database Actions */}
                  {isAdmin && (
                    <Box
                      sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 2 }}
                    >
                      <Tooltip title="Inspect schema and generate a description for this database">
                        <span>
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={
                              indexingDb === db.name ? (
                                <CircularProgress size={14} />
                              ) : (
                                <RefreshIcon />
                              )
                            }
                            onClick={() => handleIndexDatabase(db.name)}
                            disabled={!!indexingDb || indexingAll}
                          >
                            Index DB
                          </Button>
                        </span>
                      </Tooltip>

                      <Tooltip title="Clear description for this database">
                        <span>
                          <Button
                            size="small"
                            variant="outlined"
                            color="error"
                            startIcon={<WipeIcon />}
                            onClick={() => setWipeDbName(db.name)}
                            disabled={!!indexingDb || indexingAll}
                          >
                            Wipe
                          </Button>
                        </span>
                      </Tooltip>
                    </Box>
                  )}
                </AccordionDetails>
              </Accordion>
            ))}
        </Box>
      ) : (
        <Box
          sx={{
            p: 3,
            textAlign: "center",
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
          }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            No databases indexed yet. Click the button to scan this connection.
          </Typography>
          {isAdmin && (
            <Button
              variant="outlined"
              size="small"
              startIcon={
                indexingAll ? <CircularProgress size={14} /> : <RefreshIcon />
              }
              onClick={handleIndexAllDatabases}
              disabled={indexingAll}
            >
              Index All Databases
            </Button>
          )}
        </Box>
      )}

      {/* Wipe Confirmation Dialog */}
      <Dialog open={!!wipeDbName} onClose={() => setWipeDbName(null)}>
        <DialogTitle>Clear Description?</DialogTitle>
        <DialogContent>
          <Typography>
            This will remove the description for database &quot;{wipeDbName}
            &quot;. You can regenerate it later by indexing.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setWipeDbName(null)} disabled={wiping}>
            Cancel
          </Button>
          <Button
            onClick={handleWipeDatabase}
            color="error"
            variant="contained"
            disabled={wiping}
            startIcon={wiping ? <CircularProgress size={14} /> : <WipeIcon />}
          >
            Clear
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
